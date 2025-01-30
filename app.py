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

import subprocess
import json

progress = 0
progress_message = ""
processing = False


def detect_hardware():
    try:
        # Check for NVIDIA GPU (CUDA)
        result = subprocess.run(["ffmpeg", "-hwaccels"], capture_output=True, text=True)
        if "cuda" in result.stdout:
            return "cuda"
        # Check for Apple Silicon (VideoToolbox)
        if "videotoolbox" in result.stdout:
            return "apple"
    except Exception as e:
        print(f"Error detecting hardware: {e}")
    return "cpu"


def get_clip(media_path, start, end, fps=30):
    # it is faster to input the video and then trim it
    media = ffmpeg.input(media_path, ss=start, to=end)
    video_clip = media.video.setpts("PTS-STARTPTS").filter("fps", fps=fps)
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


def output_video(medium, output):
    global progress, progress_message, processing
    progress = 0
    progress_message = "Processing video..."
    processing = True

    # Create named pipe for progress
    progress_pipe = os.path.join(
        tempfile.gettempdir(), f"ffmpeg_progress_{os.getpid()}"
    )
    if not os.path.exists(progress_pipe):
        os.mkfifo(progress_pipe)

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

    video = medium["video"]
    audio = medium["audio"]

    # show the command
    try:
        process = (
            ffmpeg.output(video, audio, output, vcodec=video_codec, acodec=audio_codec)
            .global_args(*global_opts)
            .global_args("-progress", progress_pipe)
            .overwrite_output()
        )

        # Start ffmpeg in background
        thread = threading.Thread(target=process.run)
        thread.start()

        # Read progress from pipe
        with open(progress_pipe, "r") as pipe:
            while thread.is_alive():
                line = pipe.readline()
                if "out_time_us=" in line:
                    value = line.split("=")[1].strip()
                    if value.isdigit():
                        time_us = int(value)
                        total_duration = (
                            medium["duration"] * 1000 * 1000
                        )  # in microseconds
                        if total_duration > 0:
                            progress = min(int((time_us / total_duration) * 100), 100)

        thread.join()
        progress = 100

    finally:
        processing = False
        progress_message = ""
        # Cleanup
        if os.path.exists(progress_pipe):
            os.unlink(progress_pipe)


def output_audio(medium, output):
    global progress, progress_message, processing
    progress = 0
    progress_message = "Processing audio..."
    processing = True
    audio = medium["audio"]

    # Create named pipe for progress
    progress_pipe = os.path.join(
        tempfile.gettempdir(), f"ffmpeg_progress_{os.getpid()}"
    )
    if not os.path.exists(progress_pipe):
        os.mkfifo(progress_pipe)

    try:
        # Add progress pipe to ffmpeg command
        process = (
            ffmpeg.output(audio, output)
            .global_args("-progress", progress_pipe)
            .overwrite_output()
        )

        # Start ffmpeg in background
        thread = threading.Thread(target=process.run)
        thread.start()

        # Read progress from pipe
        with open(progress_pipe, "r") as pipe:
            while thread.is_alive():
                line = pipe.readline()
                if "out_time_us=" in line:
                    value = line.split("=")[1].strip()
                    if value.isdigit():
                        time_us = int(value)
                        total_duration = (
                            medium["duration"] * 1000 * 1000
                        )  # in microseconds
                        if total_duration > 0:
                            progress = min(int((time_us / total_duration) * 100), 100)

        thread.join()
        progress = 100

    finally:
        processing = False
        progress_message = ""
        # Cleanup
        if os.path.exists(progress_pipe):
            os.unlink(progress_pipe)


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
        # Detect hardware
        hardware_accel = detect_hardware()

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

        output_video(media, output_video_path)

        return render_template(
            "result.html",
            video_filename=f"clipped_{filename}",
            audio_filename=f"{os.path.splitext(filename)[0]}.mp3",
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
