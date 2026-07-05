#!/usr/bin/env python3
"""Local sermon transcription for the worker pipeline.

Runs faster-whisper (CTranslate2) fully offline and writes a plain-text
transcript to an exact output path. Invoked as a subprocess by the Node worker,
mirroring how the worker shells out to ffmpeg/ffprobe.

Progress and diagnostics go to stderr as `[transcribe] progress=N` lines so the
worker can surface them; only real errors cause a non-zero exit. The worker
treats transcription as best-effort, so a failure here never fails the job.
"""
import argparse
import os
import sys


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def write_transcript(segments, info, output_path):
    total = getattr(info, "duration", 0) or 0
    with open(output_path, "w", encoding="utf-8") as handle:
        for segment in segments:
            text = segment.text.strip()
            if text:
                handle.write(text + "\n")
            if total > 0:
                pct = min(int((segment.end / total) * 100), 99)
                eprint(f"[transcribe] progress={pct}")
    eprint("[transcribe] progress=100")


def run(args):
    from faster_whisper import WhisperModel

    os.makedirs(args.model_dir, exist_ok=True)
    language = None if args.language.lower() == "auto" else args.language
    transcribe_kwargs = dict(language=language, beam_size=5, vad_filter=True)

    def build(device, compute_type):
        eprint(f"[transcribe] loading model={args.model} device={device} compute={compute_type}")
        return WhisperModel(
            args.model,
            device=device,
            compute_type=compute_type,
            download_root=args.model_dir,
        )

    try:
        model = build(args.device, args.compute_type)
        segments, info = model.transcribe(args.audio, **transcribe_kwargs)
        write_transcript(segments, info, args.output)
    except Exception as gpu_error:
        # Most commonly a CUDA/cuDNN issue on a box without a working GPU stack.
        if args.device in ("auto", "cuda"):
            eprint(f"[transcribe] GPU path failed ({gpu_error}); retrying on CPU")
            model = build("cpu", "int8")
            segments, info = model.transcribe(args.audio, **transcribe_kwargs)
            write_transcript(segments, info, args.output)
        else:
            raise


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio to a .txt file")
    parser.add_argument("--audio", required=True, help="Path to the input audio file")
    parser.add_argument("--output", required=True, help="Path to write the .txt transcript")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--model-dir", default="models")
    parser.add_argument("--device", default="auto", help="auto | cpu | cuda")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--language", default="en", help='Language code, or "auto" to detect')
    args = parser.parse_args()

    if not os.path.exists(args.audio):
        eprint(f"[transcribe] audio not found: {args.audio}")
        sys.exit(2)

    run(args)


if __name__ == "__main__":
    main()
