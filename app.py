from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    send_from_directory,
    jsonify,
)
import ffmpeg
import os
import tempfile
import threading
import time

import subprocess
import shutil
import json

progress = 0
progress_message = ""
processing = False

# Default output resolution used for stills and transitions
OUTPUT_WIDTH = 1920
OUTPUT_HEIGHT = 1080


def detect_hardware():
    try:
        # Make sure ffmpeg exists in PATH
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            print("FFmpeg not found in PATH")
            return "cpu"
        result = subprocess.run(["ffmpeg", "-hwaccels"], capture_output=True, text=True)
        # Parse available hwaccels
        hwaccels = [l.strip() for l in result.stdout.splitlines() if l.strip()]
        # Convert to a single string for keyword checks
        hwstr = " ".join(hwaccels).lower()

        # Priority detection: CUDA (NVIDIA), QSV (Intel), VideoToolbox (Apple)
        if "cuda" in hwstr:
            return "cuda"
        if "qsv" in hwstr:
            return "intel"
        if "videotoolbox" in hwstr:
            return "apple"
        if "vaapi" in hwstr:
            return "vaapi"
    except Exception as e:
        print(f"Error detecting hardware: {e}")
    return "cpu"


def list_hardware_options():
    """Return the list of hwaccels reported by ffmpeg -hwaccels."""
    try:
        # Make sure ffmpeg is installed
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            return []
        result = subprocess.run(["ffmpeg", "-hwaccels"], capture_output=True, text=True)
        lines = [l.strip() for l in result.stdout.splitlines() if l.strip()]
        # Filter out header lines like "Hardware acceleration methods:" if present
        out = [l for l in lines if not l.lower().startswith("hardware")]
        return out
    except Exception:
        return []


def get_clip(media_path, start, end, fps=30):
    # it is faster to input the video and then trim it
    media = ffmpeg.input(media_path, ss=start, to=end)
    video_clip = media.video.setpts("PTS-STARTPTS").filter("fps", fps=fps)
    # Ensure the clip matches the target output resolution by scaling and padding
    try:
        # Use scale with keep-aspect-ratio then pad to exact target. This avoids distortion.
        # Scale to target width (keep aspect ratio) then pad to exact size.
        # Use positional args for width/height to avoid escaping issues on Windows.
        video_clip = video_clip.filter(
            "scale",
            OUTPUT_WIDTH,
            -2,
            force_original_aspect_ratio="decrease",
        )
        video_clip = video_clip.filter(
            "pad",
            OUTPUT_WIDTH,
            OUTPUT_HEIGHT,
            "(ow-iw)/2",
            "(oh-ih)/2",
        )
        print(f"Scaled/padded clip {media_path} to {OUTPUT_WIDTH}x{OUTPUT_HEIGHT}")
    except Exception as e:
        print(f"Warning: failed to scale/pad clip {media_path}: {e}")
    audio_clip = media.audio.filter("asetpts", "PTS-STARTPTS")

    return {"video": video_clip, "audio": audio_clip, "duration": end - start}


def concat_media_with_transition(clips, transition="fade", transition_duration=1):
    video = clips[0]["video"]
    audio = clips[0]["audio"]
    cumulative_duration = clips[0]["duration"]

    for i in range(1, len(clips)):
        next_video_clip = clips[i]["video"]
        next_audio_clip = clips[i]["audio"]

        offset = cumulative_duration - transition_duration
        video = ffmpeg.filter(
            [video, next_video_clip],
            "xfade",
            transition=transition,
            duration=transition_duration,
            offset=offset,
        )

        audio = ffmpeg.filter(
            [audio, next_audio_clip],
            "acrossfade",
            duration=transition_duration,
            c1="tri",
            c2="tri",
        )

        cumulative_duration += clips[i]["duration"] - transition_duration

    return {"video": video, "audio": audio, "duration": cumulative_duration}


def add_fade_in_out(media, fade_duration=1):
    video = media["video"]
    audio = media["audio"]
    duration = media["duration"]

    ret_video = video.filter(
        "fade",
        type="in",
        duration=fade_duration,
    ).filter(
        "fade",
        type="out",
        start_time=duration - fade_duration,
        duration=fade_duration,
    )

    ret_audio = audio.filter(
        "afade",
        type="in",
        start_sample=0,
        duration=fade_duration,
    ).filter(
        "afade",
        type="out",
        start_time=duration - fade_duration,
        duration=fade_duration,
    )

    return {"video": ret_video, "audio": ret_audio, "duration": duration}


def create_still_image_sequence(image_path, duration):
    try:
        output_video = "./temp/temp_still_clip.mp4"
        command = [
            "ffmpeg",
            "-loop",
            "1",
            "-i",
            image_path,
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t",
            str(duration),
            "-vf",
            "scale=1920:1080",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-pix_fmt",
            "yuv420p",
            output_video,
            "-y",
        ]

        subprocess.run(command, check=True)

        return get_clip(output_video, 0, duration)

    except subprocess.CalledProcessError as e:
        print(f"An error occurred during processing: {e}")

    return None


def update_progress(progress_file, duration_estimate):
    global progress, progress_message
    progress_message = "Normalizing audio..."
    while not os.path.exists(progress_file):
        time.sleep(0.1)
    while True:
        try:
            with open(progress_file, "r") as pf:
                lines = pf.readlines()
                for line in lines:
                    if "out_time_us=" in line:
                        value = line.split("=")[1].strip()
                        if value.isdigit():
                            time_us = int(value)
                            prog = min(int((time_us / duration_estimate) * 100), 100)
                            progress = prog
            time.sleep(0.1)
        except Exception:
            pass
        if progress >= 100:
            break


def normalize_audio(audio, duration_sec):
    """Apply 2-pass loudnorm filter to normalize audio levels with progress update
    duration_sec: actual duration in seconds of the audio stream."""
    global processing, progress_message
    processing = True
    progress_message = "Normalizing audio..."
    temp_file = os.path.join(TEMP_FOLDER, f"temp_audio_{int(time.time())}.wav")
    # Calculate duration estimate in microseconds (more accurate than a constant)
    duration_estimate = int(duration_sec * 1e6)
    norm_progress_file = os.path.join(
        tempfile.gettempdir(), f"norm_progress_{os.getpid()}.txt"
    )

    try:
        process = (
            ffmpeg.output(
                audio.filter(
                    "loudnorm", i=-23.0, lra=7.0, tp=-2.0, print_format="json"
                ),
                temp_file,
            )
            .global_args("-progress", norm_progress_file)
            .overwrite_output()
        )
        progress_thread = threading.Thread(
            target=update_progress, args=(norm_progress_file, duration_estimate)
        )
        progress_thread.start()
        _, stderr = process.run(capture_stdout=True, capture_stderr=True)
        progress_thread.join()
        stderr_str = stderr.decode("utf-8")
        json_start = stderr_str.find("{")
        json_str = stderr_str[json_start:]
        decoder = json.JSONDecoder()
        stats, _ = decoder.raw_decode(json_str)
        normalized_audio = audio.filter(
            "loudnorm",
            i=-23.0,
            lra=7.0,
            tp=-2.0,
            measured_i=stats["input_i"],
            measured_lra=stats["input_lra"],
            measured_tp=stats["input_tp"],
            measured_thresh=stats["input_thresh"],
            linear="true",
            print_format="json",
        )
        progress_message = "Audio normalization complete"
        return normalized_audio
    finally:
        progress_message = ""
        processing = False
        if os.path.exists(temp_file):
            os.remove(temp_file)
        if os.path.exists(norm_progress_file):
            os.remove(norm_progress_file)


def output_video(medium, output, hardware_accel=None):
    # Use provided hardware or detect if not provided
    if hardware_accel is None or hardware_accel == "auto":
        hardware_accel = detect_hardware()

    video_codec = "libx264"
    audio_codec = "aac"
    global_opts = []

    # For Apple Silicon (videotoolbox) or NVIDIA (cuda) or CPU
    if hardware_accel == "apple":
        video_codec = "h264_videotoolbox"
        global_opts = ["-hwaccel", "videotoolbox"]
    elif hardware_accel == "cuda":
        video_codec = "h264_nvenc"
        global_opts = ["-hwaccel", "cuda"]
    elif hardware_accel == "intel":
        video_codec = "h264_qsv"
        global_opts = ["-hwaccel", "qsv"]

    video = medium["video"]
    audio = medium["audio"]
    # Apply audio normalization
    audio = normalize_audio(audio, medium["duration"])

    global progress, progress_message, processing
    progress = 0
    progress_message = "Processing video..."
    processing = True

    # Create temporary file for progress
    progress_file = os.path.join(
        tempfile.gettempdir(), f"ffmpeg_progress_{os.getpid()}.txt"
    )

    try:
        process = (
            ffmpeg.output(video, audio, output, vcodec=video_codec, acodec=audio_codec)
            .global_args(*global_opts)
            .global_args("-progress", progress_file)
            .overwrite_output()
        )

        # Start ffmpeg in background
        thread = threading.Thread(target=process.run)
        thread.start()

        # Wait for the progress file to be created
        while not os.path.exists(progress_file):
            time.sleep(0.1)

        # Read progress from file
        while thread.is_alive():
            with open(progress_file, "r") as file:
                lines = file.readlines()
                for line in lines:
                    if "out_time_us=" in line:
                        value = line.split("=")[1].strip()
                        if value.isdigit():
                            time_us = int(value)
                            total_duration = (
                                medium["duration"] * 1000 * 1000
                            )  # in microseconds
                            if total_duration > 0:
                                progress = min(
                                    int((time_us / total_duration) * 100), 100
                                )

        thread.join()
        progress = 100

    finally:
        processing = False
        progress_message = ""
        # Cleanup
        if os.path.exists(progress_file):
            os.remove(progress_file)


def output_audio(medium, output):
    audio = medium["audio"]

    # Apply audio normalization
    audio = normalize_audio(audio, medium["duration"])

    global progress, progress_message, processing
    progress = 0
    progress_message = "Processing audio..."
    processing = True

    # Create temporary file for progress
    progress_file = os.path.join(
        tempfile.gettempdir(), f"ffmpeg_progress_{os.getpid()}.txt"
    )

    try:
        # Add progress file to ffmpeg command
        process = (
            ffmpeg.output(audio, output)
            .global_args("-progress", progress_file)
            .overwrite_output()
        )

        # Start ffmpeg in background
        thread = threading.Thread(target=process.run)
        thread.start()

        # Wait for the progress file to be created
        while not os.path.exists(progress_file):
            time.sleep(0.1)

        # Read progress from file
        while thread.is_alive():
            with open(progress_file, "r") as file:
                lines = file.readlines()
                for line in lines:
                    if "out_time_us=" in line:
                        value = line.split("=")[1].strip()
                        if value.isdigit():
                            time_us = int(value)
                            total_duration = (
                                medium["duration"] * 1000 * 1000
                            )  # in microseconds
                            if total_duration > 0:
                                progress = min(
                                    int((time_us / total_duration) * 100), 100
                                )

        thread.join()
        progress = 100

    finally:
        processing = False
        progress_message = ""
        # Cleanup
        if os.path.exists(progress_file):
            os.remove(progress_file)


def get_video_fps(filepath):
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=r_frame_rate",
                "-of",
                "json",
                filepath,
            ],
            capture_output=True,
            text=True,
        )
        ffprobe_output = json.loads(result.stdout)
        r_frame_rate = ffprobe_output["streams"][0]["r_frame_rate"]
        num, den = map(int, r_frame_rate.split("/"))
        fps = num / den
        return fps
    except Exception as e:
        print(f"Error getting FPS: {e}")
        return 30  # Default FPS


def generate_peaks(filepath):
    try:
        # Create temp WAV file
        temp_wav = os.path.join(TEMP_FOLDER, f"{os.path.basename(filepath)}.wav")

        # Extract audio to WAV
        extract_command = [
            "ffmpeg",
            "-i",
            filepath,
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",  # 16kHz for speech
            "-ac",
            "1",
            "-af",
            "highpass=f=300,lowpass=f=3000,volume=1.0",  # Speech frequency range
            temp_wav,
        ]

        subprocess.run(extract_command, check=True, capture_output=True)

        # Analyze peaks
        peaks_command = [
            "ffmpeg",
            "-i",
            temp_wav,
            "-filter_complex",
            "astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
            "-f",
            "null",
            "-",
        ]

        result = subprocess.run(peaks_command, capture_output=True, text=True)

        # Process peaks with speech-optimized normalization
        peaks = []
        speech_min = -40  # Background noise threshold (dB)
        speech_max = -10  # Loud speech threshold (dB)

        for line in result.stderr.split("\n"):
            if "RMS_level" in line:
                try:
                    value = float(line.split("=")[1])
                    if value == float("-inf") or value < speech_min:
                        normalized = 0.0  # Below speech threshold
                    else:
                        # Emphasize speech range
                        normalized = min(
                            1.0,
                            max(0.0, (value - speech_min) / (speech_max - speech_min)),
                        )
                    peaks.append(normalized)
                except ValueError:
                    peaks.append(0.0)

        # Ensure we have at least some peaks
        if not peaks:
            peaks = [0.0] * 1000  # Default empty waveform

        # Cache results
        cache_file = os.path.join(
            TEMP_FOLDER, f"{os.path.basename(filepath)}.peaks.json"
        )
        peak_data = {
            "data": peaks,
            "length": len(peaks),
            "bits": 16,
            "sample_rate": 16000,
        }

        with open(cache_file, "w") as f:
            json.dump(peak_data, f)

        # Cleanup
        os.remove(temp_wav)

        return peak_data

    except Exception as e:
        print(f"Error generating peaks: {e}")
        if os.path.exists(temp_wav):
            os.remove(temp_wav)
        return None


app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
PROCESSED_FOLDER = "processed"
TEMP_FOLDER = "temp"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)
os.makedirs(TEMP_FOLDER, exist_ok=True)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload_file():
    if "file" not in request.files:
        return redirect(request.url)
    file = request.files["file"]
    if file.filename == "":
        return redirect(request.url)
    if file:
        filepath = os.path.join(UPLOAD_FOLDER, file.filename)
        file.save(filepath)
        return redirect(url_for("process_file", filename=file.filename))
    return redirect(request.url)


@app.route("/process/<filename>", methods=["GET", "POST"])
def process_file(filename):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    if request.method == "POST":
        # Detect hardware (can be overridden by user selection)
        hardware_choice = request.form.get("hardware_choice") or "auto"
        if hardware_choice == "auto":
            hardware_accel = detect_hardware()
        elif hardware_choice == "cpu":
            hardware_accel = "cpu"
        else:
            # map front-end selectable choices to ffmpeg accel names
            mapping = {
                "intel": "qsv",
                "cuda": "cuda",
                "apple": "videotoolbox",
                "vaapi": "vaapi",
            }
            requested = hardware_choice
            mapped = mapping.get(requested)

            # Validate user selection against ffmpeg hwaccels. If ffmpeg is missing or selection not supported, fallback to cpu
            available_accels = [a.lower() for a in list_hardware_options()]
            if mapped and mapped in available_accels:
                hardware_accel = requested
            else:
                print(f"Requested hardware '{requested}' not available. Falling back to CPU.")
                hardware_accel = "cpu"

        start_time = float(request.form["start_time"])
        end_time = float(request.form["end_time"])
        clip_start = request.form.getlist("clip_start[]")
        clip_end = request.form.getlist("clip_end[]")
        if (
            len(clip_start) > 0
            and len(clip_end) > 0
            and len(clip_start) == len(clip_end)
        ):
            clip_start = [float(x) for x in clip_start]
            clip_end = [float(x) for x in clip_end]
        else:
            clip_start = None
            clip_end = None

        # settings
        cross_dissolve_duration = 1  # Duration of the cross dissolve effect in seconds
        fps = 30

        # get output paths
        output_video_path = os.path.join(PROCESSED_FOLDER, f"clipped_{filename}")
        output_audio_path = os.path.join(
            PROCESSED_FOLDER, f"{os.path.splitext(filename)[0]}.mp3"
        )

        # get number of segments
        num_segments = 1
        if clip_start and clip_end:
            num_segments = len(clip_start) + 1

        # get the clip
        clips = []
        for i in range(num_segments):
            if i == 0:
                clips.append(
                    get_clip(
                        filepath,
                        start_time,
                        clip_start[0] if num_segments > 1 else end_time,
                    )
                )
            elif i == num_segments - 1:
                clips.append(get_clip(filepath, clip_end[i - 1], end_time))
            else:
                clips.append(get_clip(filepath, clip_end[i - 1], clip_start[i]))

        media = concat_media_with_transition(
            clips, transition="fade", transition_duration=1
        )

        media = add_fade_in_out(media, fade_duration=1)

        output_audio(media, output_audio_path)

        # Get uploaded image if provided
        if "image" in request.files:
            image = request.files["image"]
            if image.filename != "":
                # Save image
                image_path = os.path.join(UPLOAD_FOLDER, image.filename)
                image.save(image_path)

                # Create still image sequence
                still_image_media = create_still_image_sequence(image_path, 5)

                if still_image_media:
                    clips.insert(0, still_image_media)

        media = concat_media_with_transition(
            clips, transition="fade", transition_duration=0.5
        )

        media = add_fade_in_out(media, fade_duration=1)

        output_video(media, output_video_path, hardware_accel)

        # Friendly name for the selected hardware
        friendly_map = {
            "intel": "Intel Quick Sync (QSV)",
            "cuda": "NVIDIA CUDA (NVENC)",
            "apple": "Apple VideoToolbox",
            "vaapi": "VAAPI",
            "cpu": "CPU (libx264)",
        }
        selected_hardware_friendly = friendly_map.get(hardware_accel, hardware_accel)
        return render_template(
            "result.html",
            video_filename=f"clipped_{filename}",
            audio_filename=f"{os.path.splitext(filename)[0]}.mp3",
            selected_hardware=hardware_accel,
            selected_hardware_friendly=selected_hardware_friendly,
        )
    return render_template("process.html", filename=filename)


@app.route("/uploads/<filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)


@app.route("/processed/<filename>")
def processed_file(filename):
    return send_from_directory(PROCESSED_FOLDER, filename)


@app.route("/status")
def status():
    global progress, progress_message, processing
    return jsonify(
        progress=progress, processing=processing, progress_message=progress_message
    )


@app.route("/get_hardware")
def get_hardware():
    """Return a JSON blob with detected hardware and available hwaccels."""
    hw = detect_hardware()
    options = list_hardware_options()
    # Map options to friendly names
    pretty = {
        "qsv": "Intel Quick Sync (QSV)",
        "cuda": "NVIDIA CUDA (NVENC)",
        "videotoolbox": "Apple VideoToolbox",
        "vaapi": "VAAPI (Linux/Intel/Radeon)",
    }
    friendly = [pretty.get(opt.lower(), opt) for opt in options]
    ffmpeg_installed = True if shutil.which("ffmpeg") else False
    error_msg = None
    if not ffmpeg_installed:
        error_msg = "ffmpeg not found on server PATH. Hardware acceleration not available."
    return jsonify(
        detected=hw,
        available=options,
        friendly=friendly,
        ffmpeg_installed=ffmpeg_installed,
        error=error_msg,
    )


@app.route("/get_fps/<filename>")
def get_fps(filename):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    fps = get_video_fps(filepath)
    return jsonify(fps=fps)


@app.route("/get_peaks/<filename>")
def get_peaks(filename):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    peaks_data = generate_peaks(filepath)
    if peaks_data:
        return jsonify(peaks_data)
    else:
        return jsonify({"error": "Failed to generate peaks data"}), 500


if __name__ == "__main__":
    app.run(debug=True)
