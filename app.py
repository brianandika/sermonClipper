from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    send_from_directory,
    jsonify,
    session
)
import ffmpeg
import os
import tempfile
import threading
import time

import subprocess
import shutil
import json
from pathlib import Path
from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google_auth_oauthlib.flow import Flow

# Load environment variables from .env file
load_dotenv()

progress = 0
progress_message = ""
processing = False

# Default output resolution used for stills and transitions
OUTPUT_WIDTH = 1920
OUTPUT_HEIGHT = 1080

# Cache cleanup configuration
UPLOADS_MAX_AGE_HOURS = 2190  # Delete files older than 3 months (set to None to disable)
TEMP_MAX_AGE_HOURS = 24  # Delete temp files older than 24 hours (set to None to disable)
CLEANUP_INTERVAL_HOURS = 24  # Run cleanup every 1 day


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
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-key-change-in-production")

UPLOAD_FOLDER = "uploads"
PROCESSED_FOLDER = "processed"
TEMP_FOLDER = "temp"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)
os.makedirs(TEMP_FOLDER, exist_ok=True)


def cleanup_old_files():
    """Delete old files from uploads and temp directories based on age."""
    current_time = time.time()
    
    # Cleanup uploads folder
    if UPLOADS_MAX_AGE_HOURS is not None:
        max_age_seconds = UPLOADS_MAX_AGE_HOURS * 3600
        deleted_count = 0
        try:
            for file_path in Path(UPLOAD_FOLDER).iterdir():
                if file_path.is_file():
                    file_age = current_time - file_path.stat().st_mtime
                    if file_age > max_age_seconds:
                        try:
                            file_path.unlink()
                            deleted_count += 1
                            print(f"Deleted old upload: {file_path.name}")
                        except Exception as e:
                            print(f"Error deleting {file_path.name}: {e}")
            if deleted_count > 0:
                print(f"Cleanup: Deleted {deleted_count} file(s) from uploads folder")
        except Exception as e:
            print(f"Error during uploads cleanup: {e}")
    
    # Cleanup temp folder (excluding .peaks.json cache files)
    if TEMP_MAX_AGE_HOURS is not None:
        max_age_seconds = TEMP_MAX_AGE_HOURS * 3600
        deleted_count = 0
        try:
            for file_path in Path(TEMP_FOLDER).iterdir():
                if file_path.is_file():
                    if file_path.suffix == ".json" and ".peaks.json" in file_path.name:
                        continue
                    file_age = current_time - file_path.stat().st_mtime
                    if file_age > max_age_seconds:
                        try:
                            file_path.unlink()
                            deleted_count += 1
                            print(f"Deleted old temp file: {file_path.name}")
                        except Exception as e:
                            print(f"Error deleting {file_path.name}: {e}")
            if deleted_count > 0:
                print(f"Cleanup: Deleted {deleted_count} file(s) from temp folder")
        except Exception as e:
            print(f"Error during temp cleanup: {e}")


def cleanup_worker():
    """Background thread that periodically runs cleanup."""
    while True:
        try:
            cleanup_old_files()
        except Exception as e:
            print(f"Error in cleanup worker: {e}")
        # Sleep for the cleanup interval
        time.sleep(CLEANUP_INTERVAL_HOURS * 3600)


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


@app.route("/youtube")
def youtube():
    """YouTube upload page"""
    # Check if coming from result page with video filename
    video_filename = request.args.get("video")
    return render_template("youtube.html", video_filename=video_filename)


@app.route("/youtube/auth")
def youtube_auth():
    """Initiate YouTube authentication flow"""
    try:        
        # Get your OAuth credentials from environment or config
        client_config = {
            "installed": {
                "client_id": os.getenv("GOOGLE_CLIENT_ID", "YOUR_CLIENT_ID"),
                "client_secret": os.getenv("GOOGLE_CLIENT_SECRET", "YOUR_CLIENT_SECRET"),
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost:5000/youtube/callback"]
            }
        }
        
        # Scopes required for YouTube upload and playlist management
        scopes = [
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube.force-ssl"
        ]
        
        flow = Flow.from_client_config(client_config, scopes=scopes)
        flow.redirect_uri = url_for("youtube_callback", _external=True)
        
        # Store flow in session for later use
        authorization_url, state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true"
        )
        
        return redirect(authorization_url)
        
    except Exception as e:
        print(f"Auth error: {str(e)}")
        return redirect(url_for("youtube", error="Authentication setup required"))


@app.route("/youtube/callback")
def youtube_callback():
    """Handle YouTube OAuth callback"""
    try:        
        code = request.args.get("code")
        state = request.args.get("state")
        
        if not code:
            return redirect(url_for("youtube", error="Authorization denied"))
        
        client_config = {
            "installed": {
                "client_id": os.getenv("GOOGLE_CLIENT_ID", "YOUR_CLIENT_ID"),
                "client_secret": os.getenv("GOOGLE_CLIENT_SECRET", "YOUR_CLIENT_SECRET"),
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost:5000/youtube/callback"]
            }
        }
        
        scopes = [
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube.force-ssl"
        ]
        flow = Flow.from_client_config(client_config, scopes=scopes)
        flow.redirect_uri = url_for("youtube_callback", _external=True)
        
        # Exchange code for credentials
        credentials = flow.fetch_token(code=code)
        
        # Store credentials in session (use server-side session for security)
        session["youtube_credentials"] = {
            "access_token": credentials.get("access_token"),
            "refresh_token": credentials.get("refresh_token"),
            "expires_at": credentials.get("expires_at")
        }
        
        return redirect(url_for("youtube"))
        
    except Exception as e:
        print(f"Callback error: {str(e)}")
        return redirect(url_for("youtube", error=str(e)))


@app.route("/youtube/auth-status")
def youtube_auth_status():
    """Check if user is authenticated"""
    
    credentials = session.get("youtube_credentials")
    if credentials and credentials.get("access_token"):
        return jsonify({
            "authenticated": True,
            "access_token": credentials.get("access_token")
        })
    else:
        return jsonify({"authenticated": False})


@app.route("/youtube/logout", methods=["POST"])
def youtube_logout():
    """Logout from YouTube and revoke OAuth token"""    
    try:
        # Get credentials before removing from session
        credentials = session.get("youtube_credentials")
        
        # Revoke the OAuth token with Google if we have one
        if credentials and credentials.get("access_token"):
            try:
                import urllib.request
                import urllib.parse
                access_token = credentials.get("access_token")
                # Revoke the token with Google
                revoke_url = "https://oauth2.googleapis.com/revoke"
                data = urllib.parse.urlencode({"token": access_token}).encode()
                req = urllib.request.Request(revoke_url, data=data)
                urllib.request.urlopen(req, timeout=5)
            except Exception as e:
                # Log error but continue with logout even if revocation fails
                print(f"Token revocation error (non-critical): {str(e)}")
        
        # Remove credentials from session
        session.pop("youtube_credentials", None)
        return jsonify({"success": True})
    except Exception as e:
        print(f"Logout error: {str(e)}")
        # Still clear session even if revocation fails
        session.pop("youtube_credentials", None)
        return jsonify({"success": True})


@app.route("/youtube/upload-manual-video", methods=["POST"])
def youtube_upload_manual_video():
    """Upload a manual video file for YouTube upload"""
    try:
        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400
        
        file = request.files["file"]
        if file.filename == "":
            return jsonify({"error": "No file selected"}), 400
        
        if file:
            # Save to processed folder for YouTube upload
            filename = file.filename
            filepath = os.path.join(PROCESSED_FOLDER, filename)
            file.save(filepath)
            return jsonify({
                "success": True,
                "filename": filename,
                "message": "Test video uploaded successfully"
            })
        
        return jsonify({"error": "File upload failed"}), 400
        
    except Exception as e:
        print(f"Test video upload error: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route("/youtube/playlists", methods=["GET"])
def youtube_playlists():
    """Fetch user's YouTube playlists"""    
    try:
        credentials = session.get("youtube_credentials")
        if not credentials or not credentials.get("access_token"):
            return jsonify({"error": "Not authenticated"}), 401
        
        access_token = credentials.get("access_token")
        
        
        creds = Credentials(token=access_token)
        youtube = build('youtube', 'v3', credentials=creds)
        
        playlists = []
        next_page_token = None
        
        while True:
            request = youtube.playlists().list(
                part="snippet,contentDetails",
                mine=True,
                maxResults=50,
                pageToken=next_page_token
            )
            response = request.execute()
            
            for item in response.get("items", []):
                playlists.append({
                    "id": item["id"],
                    "title": item["snippet"]["title"],
                    "itemCount": item["contentDetails"]["itemCount"]
                })
            
            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break
        
        return jsonify({"playlists": playlists})
        
    except Exception as e:
        print(f"Playlist fetch error: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route("/youtube/upload", methods=["POST"])
def youtube_upload():
    """Handle YouTube upload request"""    
    try:
        data = request.get_json()
        
        # Extract form data
        filename = data.get("filename")
        title = data.get("title")
        description = data.get("description", "")
        visibility = data.get("visibility", "private")
        playlist_ids = data.get("playlist_ids", [])
        
        # Validate required fields
        if not filename or not title:
            return jsonify({"error": "Missing required fields"}), 400
        
        if not description or description.strip() == "":
            return jsonify({"error": "Description is required"}), 400
        
        if not playlist_ids or len(playlist_ids) == 0:
            return jsonify({"error": "At least one playlist selection is required"}), 400
        
        # Check authentication
        credentials = session.get("youtube_credentials")
        if not credentials or not credentials.get("access_token"):
            return jsonify({"error": "Not authenticated"}), 401
        
        # Get the video file path
        video_path = os.path.join(PROCESSED_FOLDER, filename)
        if not os.path.exists(video_path):
            return jsonify({"error": "Video file not found"}), 404
        
        access_token = credentials.get("access_token")
        
        creds = Credentials(token=access_token)
        youtube = build('youtube', 'v3', credentials=creds)
        
        upload_request = youtube.videos().insert(
            part="snippet,status",
            body={
                "snippet": {
                    "title": title,
                    "description": description,
                    "categoryId": "26"  # Educational
                },
                "status": {
                    "privacyStatus": visibility,
                    "selfDeclaredMadeForKids": False
                }
            },
            media_body=MediaFileUpload(
                video_path,
                mimetype='video/mp4',
                chunksize=10*1024*1024,  # 10MB chunks for better performance
                resumable=True
            )
        )
        
        response = upload_request.execute()
        video_id = response.get("id")
        
        # Add video to all selected playlists
        added_playlists = []
        for playlist_id in playlist_ids:
            try:
                youtube.playlistItems().insert(
                    part="snippet",
                    body={
                        "snippet": {
                            "playlistId": playlist_id,
                            "resourceId": {
                                "kind": "youtube#video",
                                "videoId": video_id
                            }
                        }
                    }
                ).execute()
                added_playlists.append(playlist_id)
            except Exception as e:
                print(f"Error adding video to playlist {playlist_id}: {str(e)}")
                # Continue with other playlists even if one fails
        
        return jsonify({
            "success": True,
            "video_id": video_id,
            "added_to_playlists": len(added_playlists) > 0,
            "playlists_added": len(added_playlists),
            "total_playlists": len(playlist_ids)
        })
        
    except Exception as e:
        print(f"YouTube upload error: {str(e)}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # Start cleanup thread
    cleanup_thread = threading.Thread(target=cleanup_worker, daemon=True)
    cleanup_thread.start()
    print(f"Cache cleanup started (uploads: {UPLOADS_MAX_AGE_HOURS}h, temp: {TEMP_MAX_AGE_HOURS}h, interval: {CLEANUP_INTERVAL_HOURS}h)")
    
    # Run initial cleanup
    cleanup_old_files()
    
    app.run(debug=True)
