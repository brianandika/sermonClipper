import ffmpeg

import subprocess


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


def get_clip(media, start, end, fps=30):
    video_clip = (
        media.video.trim(start=start, end=end)
        .setpts("PTS-STARTPTS")
        .filter("fps", fps=fps)
    )
    audio_clip = media.audio.filter("atrim", start=start, end=end).filter(
        "asetpts", "PTS-STARTPTS"
    )
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
        output_video = "./temp_still.mp4"
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

        video = ffmpeg.input(output_video)
        return get_clip(video, 0, duration)

    except subprocess.CalledProcessError as e:
        print(f"An error occurred during processing: {e}")

    return None

    return {"video": video, "audio": audio, "duration": duration}


def output_video(medium, output):
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
    process = (
        ffmpeg.output(video, audio, output, vcodec=video_codec, acodec=audio_codec)
        .global_args(*global_opts)
        .overwrite_output()
    )

    print("Video Output: ", process.compile())
    process.run()


def output_audio(medium, output):
    audio = medium["audio"]

    process = ffmpeg.output(audio, output).overwrite_output()
    print("Audio Output: ", process.compile())
    process.run()


media_in = ffmpeg.input("./source/S20240707_RAW.mp4")
still_image = ffmpeg.input("./source/24-02-18_SundayCelebration_Oikos_Pt9.pptx.png")
fps = 30

clips = []
clips.append(get_clip(media_in, 0, 5, fps))
clips.append(get_clip(media_in, 10, 15, fps))

media = concat_media_with_transition(clips, transition="fade", transition_duration=1)

media = add_fade_in_out(media, fade_duration=1)

output_audio(media, "output.mp3")

# Create video with still image sequence at the beginning

still_image_media = create_still_image_sequence(
    "./source/24-02-18_SundayCelebration_Oikos_Pt9.pptx.png", 5
)

# add the still image sequence to beginning of clips
clips = []
clips.insert(0, still_image_media)
clips.append(get_clip(media_in, 0, 5, fps))
clips.append(get_clip(media_in, 10, 15, fps))
clips.append(get_clip(media_in, 20, 25, fps))


media = concat_media_with_transition(clips, transition="fade", transition_duration=0.5)

media = add_fade_in_out(media, fade_duration=1)

output_video(media, "output5.mp4")
