import "dotenv/config";
import "reflect-metadata";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import IORedis from "ioredis";
import { PrismaClient, JobStatus as PrismaJobStatus, HardwareOption } from "@prisma/client";
import { JobStage, QUEUE_NAMES, type ClipProcessJobData, type CreateJobRequest, type QueueName } from "@sermon-clipper/shared";

const execFileAsync = promisify(execFile);
const defaultCpuConcurrency = Math.max(1, Math.min(4, availableParallelism()));
const loudnormTarget = {
    integratedLufs: -23.0,
    loudnessRange: 7.0,
    truePeak: -2.0,
};

type SegmentRange = {
    startTime: number;
    endTime: number;
};

interface LoudnormAnalysis {
    input_i: string;
    input_lra: string;
    input_tp: string;
    input_thresh: string;
}

interface MediaProperties {
    width: number;
    height: number;
    fps: number;
    sampleRate: number;
    channelLayout: string;
}

interface FfprobeMediaResponse {
    streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        sample_rate?: string;
        channel_layout?: string;
    }>;
}

const runtimeEnv = {
    workerMode: (process.env.WORKER_MODE ?? "all").trim(),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
    workRoot: process.env.WORK_ROOT ?? "/workspaces/sermonClipper/work",
    resultTtlDays: Number.parseInt(process.env.RESULT_TTL_DAYS ?? "7", 10),
    cpuWorkerConcurrency: Number.parseInt(process.env.CPU_WORKER_CONCURRENCY ?? String(defaultCpuConcurrency), 10),
    gpuWorkerConcurrency: Number.parseInt(process.env.GPU_WORKER_CONCURRENCY ?? "1", 10),
    transcriptionEnabled: (process.env.ENABLE_TRANSCRIPTION ?? "true").trim().toLowerCase() !== "false",
    pythonPath: process.env.PYTHON_PATH ?? "python3",
    whisperModel: process.env.WHISPER_MODEL ?? "large-v3-turbo",
    whisperModelDir: process.env.WHISPER_MODEL_DIR
        ?? join(process.env.WORK_ROOT ?? "/workspaces/sermonClipper/work", "_models"),
    whisperDevice: process.env.WHISPER_DEVICE ?? "auto",
    whisperComputeType: process.env.WHISPER_COMPUTE_TYPE ?? "auto",
    whisperLanguage: process.env.WHISPER_LANGUAGE ?? "en",
    whisperScript: process.env.WHISPER_SCRIPT?.trim() || "",
};
const defaultIntroDurationSeconds = 5;
const defaultFadeDurationSeconds = 1;
const defaultIntroTransitionDurationSeconds = 0.5;
const defaultAudioTransitionDurationSeconds = 1;
const outputWidth = 1920;
const outputHeight = 1080;
const defaultFps = 30;
const defaultIntroSampleRate = 44100;
const pendingArtifactPath = "";

const prisma = new PrismaClient();
const activeJobControllers = new Map<string, Set<AbortController>>();
const activeJobCancelWatchers = new Map<string, NodeJS.Timeout>();

class JobCanceledError extends Error {
    constructor(jobId: string) {
        super(`Job ${jobId} was canceled`);
        this.name = "JobCanceledError";
    }
}

type TrackedExecOptions = {
    maxBuffer?: number;
};

function registerJobController(jobId: string, controller: AbortController) {
    const controllers = activeJobControllers.get(jobId) ?? new Set<AbortController>();
    controllers.add(controller);
    activeJobControllers.set(jobId, controllers);
}

function unregisterJobController(jobId: string, controller: AbortController) {
    const controllers = activeJobControllers.get(jobId);
    if (!controllers) {
        return;
    }

    controllers.delete(controller);
    if (controllers.size === 0) {
        activeJobControllers.delete(jobId);
    }
}

function abortJobProcesses(jobId: string) {
    const controllers = activeJobControllers.get(jobId);
    if (!controllers) {
        return;
    }

    for (const controller of controllers) {
        controller.abort();
    }
}

function startJobCancellationWatcher(jobId: string) {
    if (activeJobCancelWatchers.has(jobId)) {
        return;
    }

    let checking = false;
    const intervalId = setInterval(() => {
        if (checking) {
            return;
        }

        checking = true;
        void prisma.job.findUnique({
            where: { id: jobId },
            select: { status: true },
        }).then((job) => {
            if (job?.status === PrismaJobStatus.canceled) {
                abortJobProcesses(jobId);
            }
        }).finally(() => {
            checking = false;
        });
    }, 1000);

    activeJobCancelWatchers.set(jobId, intervalId);
}

function stopJobCancellationWatcher(jobId: string) {
    const intervalId = activeJobCancelWatchers.get(jobId);
    if (!intervalId) {
        return;
    }

    clearInterval(intervalId);
    activeJobCancelWatchers.delete(jobId);
    activeJobControllers.delete(jobId);
}

async function execFileForJob(jobId: string, command: string, args: string[], options?: TrackedExecOptions) {
    await assertJobNotCanceled(jobId);

    const controller = new AbortController();
    registerJobController(jobId, controller);

    try {
        return await execFileAsync(command, args, {
            maxBuffer: options?.maxBuffer,
            signal: controller.signal,
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new JobCanceledError(jobId);
        }

        throw error;
    }
    finally {
        unregisterJobController(jobId, controller);
    }
}

function getJobRoot(sessionId: string, jobId: string) {
    return join(runtimeEnv.workRoot, sessionId, "jobs", jobId);
}

function getSegments(payload: CreateJobRequest) {
    if (payload.clipStarts && payload.clipEnds && payload.clipStarts.length === payload.clipEnds.length && payload.clipStarts.length > 0) {
        const segments: SegmentRange[] = [];
        let currentStart = payload.startTime;

        for (const [index, clipStart] of payload.clipStarts.entries()) {
            const clipEnd = payload.clipEnds[index] ?? clipStart;

            if (clipStart > currentStart) {
                segments.push({
                    startTime: currentStart,
                    endTime: clipStart,
                });
            }

            currentStart = Math.max(currentStart, clipEnd);
        }

        if (currentStart < payload.endTime) {
            segments.push({
                startTime: currentStart,
                endTime: payload.endTime,
            });
        }

        return segments;
    }

    return [{
        startTime: payload.startTime,
        endTime: payload.endTime,
    }] satisfies SegmentRange[];
}

function getDurationSeconds(startTime: number, endTime: number) {
    return Math.max(0, endTime - startTime);
}

function getTransitionDuration(segments: SegmentRange[], requestedTransitionDuration: number) {
    if (segments.length < 2) {
        return 0;
    }

    const desiredDuration = requestedTransitionDuration;

    if (desiredDuration <= 0) {
        return 0;
    }

    const shortestSegmentDuration = Math.min(...segments.map((segment) => getDurationSeconds(segment.startTime, segment.endTime)));
    const cappedDuration = Math.min(desiredDuration, Math.max(0, shortestSegmentDuration - 0.05));

    return cappedDuration > 0 ? cappedDuration : 0;
}

function getEdgeTransitionDuration(previousDuration: number, nextDuration: number, requestedDuration: number) {
    if (requestedDuration <= 0) {
        return 0;
    }

    const maxDuration = Math.min(previousDuration, nextDuration) - 0.05;
    if (maxDuration <= 0) {
        return 0;
    }

    return Math.min(requestedDuration, maxDuration);
}

function getUniformTransitionDurations(segmentDurations: number[], requestedDuration: number) {
    const transitionDurations: number[] = [];

    for (let index = 1; index < segmentDurations.length; index += 1) {
        transitionDurations.push(
            getEdgeTransitionDuration(
                segmentDurations[index - 1] ?? 0,
                segmentDurations[index] ?? 0,
                requestedDuration,
            ),
        );
    }

    return transitionDurations;
}

function parseFrameRate(value?: string) {
    if (!value) {
        return 30;
    }

    const [numerator, denominator] = value.split("/").map((part) => Number.parseFloat(part));
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return 30;
    }

    return numerator / denominator;
}

function getVideoEncodingArgs(hardware: HardwareOption) {
    switch (hardware) {
        case HardwareOption.cuda:
            return ["-c:v", "h264_nvenc", "-preset", "fast", "-pix_fmt", "yuv420p"];
        case HardwareOption.intel:
            return ["-c:v", "h264_qsv"];
        case HardwareOption.apple:
            return ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p"];
        case HardwareOption.vaapi:
            return ["-c:v", "h264_vaapi"];
        case HardwareOption.auto:
        case HardwareOption.cpu:
        default:
            return ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"];
    }
}

async function updateJobProgress(jobId: string, data: {
    status?: PrismaJobStatus;
    effectiveHardware?: HardwareOption;
    startedAt?: Date;
    finishedAt?: Date;
    failureReason?: string | null;
    stage: JobStage;
    stageProgress: number;
    overallProgress: number;
    message: string;
}) {
    await prisma.job.update({
        where: { id: jobId },
        data: {
            status: data.status,
            effectiveHardware: data.effectiveHardware,
            startedAt: data.startedAt,
            finishedAt: data.finishedAt,
            failureReason: data.failureReason,
            progress: {
                upsert: {
                    create: {
                        stage: data.stage,
                        stageProgress: data.stageProgress,
                        overallProgress: data.overallProgress,
                        message: data.message,
                    },
                    update: {
                        stage: data.stage,
                        stageProgress: data.stageProgress,
                        overallProgress: data.overallProgress,
                        message: data.message,
                    },
                },
            },
        },
    });
}

async function assertJobNotCanceled(jobId: string) {
    const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { status: true },
    });

    if (job?.status === PrismaJobStatus.canceled) {
        throw new JobCanceledError(jobId);
    }
}

async function detectOutputDuration(jobId: string, videoPath: string) {
    try {
        const { stdout } = await execFileForJob(jobId, runtimeEnv.ffprobePath, [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            videoPath,
        ]);

        const duration = Number.parseFloat(stdout.trim());
        return Number.isFinite(duration) ? duration : null;
    }
    catch {
        return null;
    }
}

async function detectMediaProperties(jobId: string, videoPath: string) {
    try {
        const { stdout } = await execFileForJob(jobId, runtimeEnv.ffprobePath, [
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            videoPath,
        ]);

        const parsed = JSON.parse(stdout) as FfprobeMediaResponse;
        const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
        const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");

        return {
            width: videoStream?.width ?? 1920,
            height: videoStream?.height ?? 1080,
            fps: parseFrameRate(videoStream?.r_frame_rate),
            sampleRate: Number.parseInt(audioStream?.sample_rate ?? "48000", 10),
            channelLayout: audioStream?.channel_layout ?? "stereo",
        } satisfies MediaProperties;
    }
    catch {
        return {
            width: 1920,
            height: 1080,
            fps: 30,
            sampleRate: 48000,
            channelLayout: "stereo",
        } satisfies MediaProperties;
    }
}

function getSegmentVideoFilter(fps = defaultFps) {
    return [
        `fps=${fps}`,
        `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease`,
        `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2`,
        "format=yuv420p",
    ].join(",");
}

function sanitizeOutputFilename(raw: string | undefined, extension: ".mp3" | ".mp4", fallbackBase: string) {
    const fallback = `${fallbackBase}${extension}`;
    const candidate = (raw ?? "").trim();
    if (!candidate) {
        return fallback;
    }

    const withoutExtension = candidate.replace(/\.[^./\\]+$/, "");
    const normalizedBase = withoutExtension
        .replace(/[\\/]+/g, "-")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120);

    const safeBase = normalizedBase || fallbackBase;
    return `${safeBase}${extension}`;
}

function getLoudnormAnalysis(stderr: string) {
    const jsonStart = stderr.lastIndexOf("{");
    const jsonEnd = stderr.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        throw new Error("FFmpeg loudnorm analysis did not return JSON stats");
    }

    return JSON.parse(stderr.slice(jsonStart, jsonEnd + 1)) as LoudnormAnalysis;
}

function getLoudnormFilter(analysis?: LoudnormAnalysis) {
    const filterParts = [
        `i=${loudnormTarget.integratedLufs}`,
        `lra=${loudnormTarget.loudnessRange}`,
        `tp=${loudnormTarget.truePeak}`,
    ];

    if (!analysis) {
        filterParts.push("print_format=json");
        return `loudnorm=${filterParts.join(":")}`;
    }

    filterParts.push(
        `measured_i=${analysis.input_i}`,
        `measured_lra=${analysis.input_lra}`,
        `measured_tp=${analysis.input_tp}`,
        `measured_thresh=${analysis.input_thresh}`,
        "linear=true",
        "print_format=json",
    );

    return `loudnorm=${filterParts.join(":")}`;
}

async function analyzeAudioNormalization(jobId: string, inputPath: string) {
    const { stderr } = await execFileForJob(jobId, runtimeEnv.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-af",
        getLoudnormFilter(),
        "-f",
        "null",
        "-",
    ]);

    return getLoudnormAnalysis(stderr);
}

async function normalizeVideoAudio(jobId: string, inputPath: string, outputPath: string, analysis: LoudnormAnalysis) {
    await execFileForJob(jobId, runtimeEnv.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-i",
        inputPath,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-af",
        getLoudnormFilter(analysis),
        "-movflags",
        "+faststart",
        outputPath,
    ]);
}

async function normalizeAudioOnly(jobId: string, inputPath: string, outputPath: string, analysis: LoudnormAnalysis) {
    await execFileForJob(jobId, runtimeEnv.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-af",
        getLoudnormFilter(analysis),
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        outputPath,
    ]);
}

async function encodeSegment(
    jobId: string,
    sourcePath: string,
    outputPath: string,
    startTime: number,
    duration: number,
    hardware: HardwareOption,
    fps?: number,
) {
    const args = [
        "-hide_banner",
        "-y",
        "-ss",
        String(startTime),
        "-i",
        sourcePath,
        "-t",
        String(duration),
    ];

    if (fps) {
        args.push("-vf", getSegmentVideoFilter(fps));
    }
    else {
        args.push("-vf", getSegmentVideoFilter(defaultFps));
    }

    args.push(
        ...getVideoEncodingArgs(hardware),
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
    );

    await execFileForJob(jobId, runtimeEnv.ffmpegPath, args);
}

async function concatSegments(jobId: string, manifestPath: string, outputPath: string) {
    await execFileForJob(jobId, runtimeEnv.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        manifestPath,
        "-c",
        "copy",
        outputPath,
    ]);
}

async function extractAudio(jobId: string, videoPath: string, audioPath: string) {
    await execFileForJob(jobId, runtimeEnv.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-i",
        videoPath,
        "-vn",
        "-c:a",
        "copy",
        audioPath,
    ]);
}

function getSequenceDuration(segmentDurations: number[], transitionDurations: number[]) {
    return Math.max(0, segmentDurations.reduce((total, duration) => total + duration, 0) - transitionDurations.reduce((total, duration) => total + duration, 0));
}

async function renderAudioArtifact(
    jobId: string,
    segmentPaths: string[],
    segmentDurations: number[],
    transitionDurations: number[],
    outputPath: string,
) {
    const args = ["-hide_banner", "-y"];

    for (const segmentPath of segmentPaths) {
        args.push("-i", segmentPath);
    }

    const filterParts: string[] = [];
    for (const [index] of segmentPaths.entries()) {
        filterParts.push(`[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
    }

    let currentAudioLabel = "a0";
    let outputDuration = segmentDurations[0] ?? 0;

    if (segmentPaths.length > 1 && transitionDurations.some((duration) => duration > 0)) {
        for (let index = 1; index < segmentPaths.length; index += 1) {
            const nextAudioLabel = `a${index}`;
            const mergedAudioLabel = `ax${index}`;
            const transitionDuration = transitionDurations[index - 1] ?? 0;

            filterParts.push(
                `[${currentAudioLabel}][${nextAudioLabel}]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[${mergedAudioLabel}]`,
            );

            currentAudioLabel = mergedAudioLabel;
        }

        outputDuration = getSequenceDuration(segmentDurations, transitionDurations);
    }
    else if (segmentPaths.length > 1) {
        const concatInputs = segmentPaths.map((_, index) => `[a${index}]`).join("");
        filterParts.push(`${concatInputs}concat=n=${segmentPaths.length}:v=0:a=1[axcat]`);
        currentAudioLabel = "axcat";
        outputDuration = segmentDurations.reduce((total, duration) => total + duration, 0);
    }

    const fadeOutStart = Math.max(0, outputDuration - defaultFadeDurationSeconds);
    filterParts.push(
        `[${currentAudioLabel}]afade=t=in:st=0:d=${defaultFadeDurationSeconds},afade=t=out:st=${fadeOutStart}:d=${defaultFadeDurationSeconds}[outa]`,
    );

    args.push(
        "-filter_complex",
        filterParts.join(";"),
        "-map",
        "[outa]",
        "-c:a",
        "aac",
        outputPath,
    );

    await execFileForJob(jobId, runtimeEnv.ffmpegPath, args);
}

async function renderSegmentsWithTransitions(
    jobId: string,
    segmentPaths: string[],
    segmentDurations: number[],
    outputPath: string,
    transitionDurations: number[],
    hardware: HardwareOption,
) {
    const args = ["-hide_banner", "-y"];

    for (const segmentPath of segmentPaths) {
        args.push("-i", segmentPath);
    }

    const filterParts: string[] = [];
    for (const [index] of segmentPaths.entries()) {
        filterParts.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${defaultFps}[v${index}]`);
        filterParts.push(`[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
    }

    let cumulativeDuration = segmentDurations[0] ?? 0;
    let currentVideoLabel = "v0";
    let currentAudioLabel = "a0";

    for (let index = 1; index < segmentPaths.length; index += 1) {
        const nextVideoLabel = `v${index}`;
        const nextAudioLabel = `a${index}`;
        const mergedVideoLabel = `vx${index}`;
        const mergedAudioLabel = `ax${index}`;
        const transitionDuration = transitionDurations[index - 1] ?? 0;
        const offset = Math.max(0, cumulativeDuration - transitionDuration);

        filterParts.push(
            `[${currentVideoLabel}][${nextVideoLabel}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${mergedVideoLabel}]`,
        );
        filterParts.push(
            `[${currentAudioLabel}][${nextAudioLabel}]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[${mergedAudioLabel}]`,
        );

        currentVideoLabel = mergedVideoLabel;
        currentAudioLabel = mergedAudioLabel;
        cumulativeDuration += (segmentDurations[index] ?? 0) - transitionDuration;
    }

    const outputDuration = getSequenceDuration(segmentDurations, transitionDurations);
    const fadeOutStart = Math.max(0, outputDuration - defaultFadeDurationSeconds);
    filterParts.push(`[${currentVideoLabel}]fade=t=in:st=0:d=${defaultFadeDurationSeconds},fade=t=out:st=${fadeOutStart}:d=${defaultFadeDurationSeconds}[outv]`);
    filterParts.push(`[${currentAudioLabel}]afade=t=in:st=0:d=${defaultFadeDurationSeconds},afade=t=out:st=${fadeOutStart}:d=${defaultFadeDurationSeconds}[outa]`);

    args.push(
        "-filter_complex",
        filterParts.join(";"),
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        ...getVideoEncodingArgs(hardware),
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
    );

    await execFileForJob(jobId, runtimeEnv.ffmpegPath, args);
}

async function renderConcatenatedVideoArtifact(
    jobId: string,
    segmentPaths: string[],
    segmentDurations: number[],
    outputPath: string,
    hardware: HardwareOption,
) {
    const args = ["-hide_banner", "-y"];

    for (const segmentPath of segmentPaths) {
        args.push("-i", segmentPath);
    }

    const filterParts: string[] = [];
    const concatInputs: string[] = [];

    for (const [index] of segmentPaths.entries()) {
        filterParts.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${defaultFps}[v${index}]`);
        filterParts.push(`[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
        concatInputs.push(`[v${index}]`, `[a${index}]`);
    }

    filterParts.push(`${concatInputs.join("")}concat=n=${segmentPaths.length}:v=1:a=1[vcat][acat]`);

    const outputDuration = segmentDurations.reduce((total, duration) => total + duration, 0);
    const fadeOutStart = Math.max(0, outputDuration - defaultFadeDurationSeconds);
    filterParts.push(`[vcat]fade=t=in:st=0:d=${defaultFadeDurationSeconds},fade=t=out:st=${fadeOutStart}:d=${defaultFadeDurationSeconds}[outv]`);
    filterParts.push(`[acat]afade=t=in:st=0:d=${defaultFadeDurationSeconds},afade=t=out:st=${fadeOutStart}:d=${defaultFadeDurationSeconds}[outa]`);

    args.push(
        "-filter_complex",
        filterParts.join(";"),
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        ...getVideoEncodingArgs(hardware),
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
    );

    await execFileForJob(jobId, runtimeEnv.ffmpegPath, args);
}

async function createStillImageClip(
    jobId: string,
    imagePath: string,
    outputPath: string,
    introDuration: number,
    fps: number,
) {
    await execFileForJob(jobId, runtimeEnv.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-loop",
        "1",
        "-t",
        String(introDuration),
        "-i",
        imagePath,
        "-f",
        "lavfi",
        "-t",
        String(introDuration),
        "-i",
        `anullsrc=channel_layout=stereo:sample_rate=${defaultIntroSampleRate}`,
        "-vf",
        getSegmentVideoFilter(fps),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
    ]);
}

function resolveTranscribeScript() {
    // Resolve without relying on __dirname (avoids CJS/ESM ambiguity). Covers
    // prod (cwd=/app) and workspace dev (cwd=apps/worker), plus an override.
    const candidates = [
        runtimeEnv.whisperScript,
        join(process.cwd(), "apps/worker/scripts/transcribe.py"),
        join(process.cwd(), "scripts/transcribe.py"),
    ].filter((candidate) => candidate.length > 0);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

async function transcribeAudio(jobId: string, audioPath: string, outputTranscriptPath: string) {
    const scriptPath = resolveTranscribeScript();
    if (!scriptPath) {
        process.stderr.write("Transcription skipped: transcribe.py not found\n");
        return null;
    }

    try {
        await execFileForJob(jobId, runtimeEnv.pythonPath, [
            scriptPath,
            "--audio", audioPath,
            "--output", outputTranscriptPath,
            "--model", runtimeEnv.whisperModel,
            "--model-dir", runtimeEnv.whisperModelDir,
            "--device", runtimeEnv.whisperDevice,
            "--compute-type", runtimeEnv.whisperComputeType,
            "--language", runtimeEnv.whisperLanguage,
        ], { maxBuffer: 64 * 1024 * 1024 });

        if (existsSync(outputTranscriptPath)) {
            return outputTranscriptPath;
        }

        process.stderr.write("Transcription produced no output file\n");
        return null;
    }
    catch (error) {
        // Cancellation must still propagate; anything else is non-fatal so the
        // MP3/MP4 exports are unaffected by a transcription failure.
        if (error instanceof JobCanceledError) {
            throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Transcription failed (continuing without transcript): ${reason}\n`);
        return null;
    }
}

async function processClipJob(payload: ClipProcessJobData) {
    await assertJobNotCanceled(payload.jobId);
    startJobCancellationWatcher(payload.jobId);

    try {
        const job = await prisma.job.findUnique({
            where: { id: payload.jobId },
            include: { asset: true },
        });

        if (!job) {
            throw new Error(`Job ${payload.jobId} not found`);
        }

        const request = job.payloadJson as unknown as CreateJobRequest;
        const segments = getSegments(request);

        if (segments.length === 0) {
            throw new Error("No output segments remain after applying clip gaps");
        }

        const effectiveHardware = job.effectiveHardware ?? (job.requestedHardware ?? HardwareOption.auto) as HardwareOption;
        const requestedFps = request.fps ?? defaultFps;
        const introDuration = request.introDuration && request.introDuration > 0
            ? request.introDuration
            : defaultIntroDurationSeconds;
        const jobRoot = getJobRoot(job.sessionId, job.id);
        const segmentsRoot = join(jobRoot, "segments");
        const audioProgramPath = join(jobRoot, "audio-program.m4a");
        const videoProgramPath = join(jobRoot, "video-program.mp4");
        const introClipPath = join(jobRoot, "intro-clip.mp4");
        const outputVideoFilename = sanitizeOutputFilename(request.outputVideoFilename, ".mp4", "result-video");
        const outputAudioFilename = sanitizeOutputFilename(request.outputAudioFilename, ".mp3", "result-audio");
        const outputVideoPath = join(jobRoot, outputVideoFilename);
        const outputAudioPath = join(jobRoot, outputAudioFilename);
        const processingManifestPath = join(jobRoot, "manifest.json");

        const introImageAsset = request.introImageAssetId
            ? await prisma.asset.findFirst({
                where: {
                    id: request.introImageAssetId,
                    sessionId: job.sessionId,
                },
            })
            : null;

        if (request.introImageAssetId && !introImageAsset) {
            throw new Error(`Intro image asset ${request.introImageAssetId} not found`);
        }

        await mkdir(segmentsRoot, { recursive: true });
        await updateJobProgress(job.id, {
            status: PrismaJobStatus.preparing,
            effectiveHardware,
            startedAt: new Date(),
            stage: JobStage.extractClips,
            stageProgress: 0,
            overallProgress: 5,
            message: "Preparing clip extraction",
        });

        const segmentPaths: string[] = [];
        const segmentDurations: number[] = [];

        for (const [index, segment] of segments.entries()) {
            await assertJobNotCanceled(job.id);

            const duration = getDurationSeconds(segment.startTime, segment.endTime);

            if (duration <= 0) {
                throw new Error(`Invalid clip duration for segment ${index + 1}`);
            }

            const segmentPath = join(segmentsRoot, `segment-${String(index + 1).padStart(2, "0")}.mp4`);
            await encodeSegment(job.id, job.asset.sourcePath, segmentPath, segment.startTime, duration, effectiveHardware, requestedFps);
            segmentPaths.push(segmentPath);
            segmentDurations.push(duration);

            const progress = Math.round(((index + 1) / segments.length) * 100);
            await updateJobProgress(job.id, {
                status: PrismaJobStatus.preparing,
                stage: JobStage.extractClips,
                stageProgress: progress,
                overallProgress: Math.min(60, 10 + Math.round(((index + 1) / segments.length) * 50)),
                message: `Encoded segment ${index + 1} of ${segments.length}`,
            });
        }

        const audioTransitionDuration = getTransitionDuration(segments, defaultAudioTransitionDurationSeconds);
        const audioTransitionDurations = getUniformTransitionDurations(segmentDurations, audioTransitionDuration);

        await assertJobNotCanceled(job.id);

        await updateJobProgress(job.id, {
            status: PrismaJobStatus.encoding_audio,
            stage: JobStage.encodeAudio,
            stageProgress: 10,
            overallProgress: 62,
            message: "Rendering stitched audio artifact",
        });

        await renderAudioArtifact(job.id, segmentPaths, segmentDurations, audioTransitionDurations, audioProgramPath);

        await assertJobNotCanceled(job.id);

        await updateJobProgress(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.normalizeAudio,
            stageProgress: 20,
            overallProgress: 72,
            message: "Analyzing stitched audio levels",
        });

        const audioLoudnormAnalysis = await analyzeAudioNormalization(job.id, audioProgramPath);

        await assertJobNotCanceled(job.id);

        await updateJobProgress(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.normalizeAudio,
            stageProgress: 55,
            overallProgress: 78,
            message: "Normalizing stitched audio artifact",
        });

        try {
            await normalizeAudioOnly(job.id, audioProgramPath, outputAudioPath, audioLoudnormAnalysis);
        }
        finally {
            await rm(audioProgramPath, { force: true });
        }

        const audioOutputStats = await stat(outputAudioPath);
        const partialExpiresAt = new Date();
        partialExpiresAt.setUTCDate(partialExpiresAt.getUTCDate() + runtimeEnv.resultTtlDays);

        await prisma.$transaction([
            prisma.result.upsert({
                where: { jobId: job.id },
                update: {
                    sessionId: job.sessionId,
                    audioPath: outputAudioPath,
                    videoPath: pendingArtifactPath,
                    manifestPath: pendingArtifactPath,
                    expiresAt: partialExpiresAt,
                },
                create: {
                    jobId: job.id,
                    sessionId: job.sessionId,
                    videoPath: pendingArtifactPath,
                    audioPath: outputAudioPath,
                    manifestPath: pendingArtifactPath,
                    expiresAt: partialExpiresAt,
                },
            }),
            prisma.processingArtifact.create({
                data: {
                    jobId: job.id,
                    type: "audio",
                    filename: basename(outputAudioPath),
                    storagePath: outputAudioPath,
                    sizeBytes: BigInt(audioOutputStats.size),
                },
            }),
        ]);

        await assertJobNotCanceled(job.id);

        const videoSegmentPaths = [...segmentPaths];
        const videoSegmentDurations = [...segmentDurations];

        if (introImageAsset) {
            await createStillImageClip(job.id, introImageAsset.sourcePath, introClipPath, introDuration, requestedFps);
            videoSegmentPaths.unshift(introClipPath);
            videoSegmentDurations.unshift(introDuration);
        }

        await assertJobNotCanceled(job.id);

        const videoTransitionDuration = getTransitionDuration(videoSegmentDurations.map((duration, index) => ({
            startTime: 0,
            endTime: duration,
        })), introImageAsset ? defaultIntroTransitionDurationSeconds : 0.5);
        const videoTransitionDurations = getUniformTransitionDurations(
            videoSegmentDurations,
            introImageAsset ? defaultIntroTransitionDurationSeconds : 0.5,
        );

        if (videoTransitionDuration > 0 && videoSegmentPaths.length > 1) {
            await updateJobProgress(job.id, {
                status: PrismaJobStatus.encoding_video,
                stage: JobStage.buildTransitions,
                stageProgress: 0,
                overallProgress: 65,
                message: `Rendering ${videoSegmentPaths.length - 1} video crossfade transition(s)`,
            });

            await renderSegmentsWithTransitions(
                job.id,
                videoSegmentPaths,
                videoSegmentDurations,
                videoProgramPath,
                videoTransitionDurations,
                effectiveHardware,
            );

            await assertJobNotCanceled(job.id);

            await updateJobProgress(job.id, {
                status: PrismaJobStatus.encoding_video,
                stage: JobStage.buildTransitions,
                stageProgress: 100,
                overallProgress: 72,
                message: "Transition rendering complete",
            });
        }
        else {
            await updateJobProgress(job.id, {
                status: PrismaJobStatus.encoding_video,
                stage: JobStage.encodeVideo,
                stageProgress: 0,
                overallProgress: 65,
                message: "Rendering stitched video artifact",
            });

            await renderConcatenatedVideoArtifact(job.id, videoSegmentPaths, videoSegmentDurations, videoProgramPath, effectiveHardware);
        }

        await assertJobNotCanceled(job.id);

        await updateJobProgress(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.normalizeAudio,
            stageProgress: 70,
            overallProgress: 84,
            message: "Analyzing stitched video audio levels",
        });

        try {
            const videoLoudnormAnalysis = await analyzeAudioNormalization(job.id, videoProgramPath);

            await assertJobNotCanceled(job.id);

            await updateJobProgress(job.id, {
                status: PrismaJobStatus.processing_audio,
                stage: JobStage.normalizeAudio,
                stageProgress: 90,
                overallProgress: 92,
                message: "Normalizing stitched video audio",
            });

            await normalizeVideoAudio(job.id, videoProgramPath, outputVideoPath, videoLoudnormAnalysis);
        }
        finally {
            await rm(videoProgramPath, { force: true });
            await rm(introClipPath, { force: true });
        }

        await assertJobNotCanceled(job.id);

        const outputStats = await stat(outputVideoPath);
        const outputDuration = await detectOutputDuration(job.id, outputVideoPath);

        await writeFile(processingManifestPath, JSON.stringify({
            jobId: job.id,
            assetId: job.assetId,
            sourcePath: job.asset.sourcePath,
            outputVideoPath,
            outputAudioPath,
            segments,
            audioTransitionDuration,
            videoTransitionDuration: introImageAsset ? defaultIntroTransitionDurationSeconds : 0.5,
            introImageAssetId: introImageAsset?.id ?? null,
            introDuration: introImageAsset ? introDuration : 0,
            fadeInOutApplied: true,
            stillImageFadeInApplied: Boolean(introImageAsset),
            introCrossfadeDuration: introImageAsset ? (videoTransitionDurations[0] ?? 0) : 0,
            effectiveHardware,
            normalizedAudio: true,
            videoIncludesStillIntro: Boolean(introImageAsset),
            createdAt: new Date().toISOString(),
        }, null, 2));

        // Transcribe the exported audio to a plain-text transcript (best-effort).
        // Runs at the end so the MP3/MP4 stay fast; a failure never fails the job.
        const outputTranscriptPath = join(jobRoot, `${outputAudioFilename.replace(/\.mp3$/i, "")}.txt`);
        let transcriptPath: string | null = null;

        if (runtimeEnv.transcriptionEnabled) {
            await updateJobProgress(job.id, {
                stage: JobStage.transcribe,
                stageProgress: 0,
                overallProgress: 95,
                message: "Transcribing sermon audio",
            });

            transcriptPath = await transcribeAudio(job.id, outputAudioPath, outputTranscriptPath);

            await assertJobNotCanceled(job.id);
        }

        const finalArtifacts: Array<{
            jobId: string;
            type: string;
            filename: string;
            storagePath: string;
            sizeBytes?: bigint;
        }> = [
            {
                jobId: job.id,
                type: "video",
                filename: basename(outputVideoPath),
                storagePath: outputVideoPath,
                sizeBytes: BigInt(outputStats.size),
            },
            {
                jobId: job.id,
                type: "manifest",
                filename: basename(processingManifestPath),
                storagePath: processingManifestPath,
            },
        ];

        if (transcriptPath) {
            const transcriptStats = await stat(transcriptPath);
            finalArtifacts.push({
                jobId: job.id,
                type: "transcript",
                filename: basename(transcriptPath),
                storagePath: transcriptPath,
                sizeBytes: BigInt(transcriptStats.size),
            });
        }

        const expiresAt = new Date();
        expiresAt.setUTCDate(expiresAt.getUTCDate() + runtimeEnv.resultTtlDays);

        await prisma.$transaction([
            prisma.result.upsert({
                where: { jobId: job.id },
                update: {
                    sessionId: job.sessionId,
                    videoPath: outputVideoPath,
                    audioPath: outputAudioPath,
                    transcriptPath,
                    manifestPath: processingManifestPath,
                    sizeBytes: BigInt(outputStats.size),
                    duration: outputDuration,
                    expiresAt,
                },
                create: {
                    jobId: job.id,
                    sessionId: job.sessionId,
                    videoPath: outputVideoPath,
                    audioPath: outputAudioPath,
                    transcriptPath,
                    manifestPath: processingManifestPath,
                    sizeBytes: BigInt(outputStats.size),
                    duration: outputDuration,
                    expiresAt,
                },
            }),
            prisma.processingArtifact.createMany({
                data: finalArtifacts,
            }),
        ]);

        await updateJobProgress(job.id, {
            status: PrismaJobStatus.completed,
            finishedAt: new Date(),
            failureReason: null,
            stage: JobStage.complete,
            stageProgress: 100,
            overallProgress: 100,
            message: "Clip processing complete",
        });
    }
    finally {
        stopJobCancellationWatcher(payload.jobId);
    }
}

function getEnabledQueues() {
    if (runtimeEnv.workerMode === "all") {
        return [QUEUE_NAMES.clipProcess, QUEUE_NAMES.gpuEncode] as const;
    }

    if (runtimeEnv.workerMode === QUEUE_NAMES.clipProcess || runtimeEnv.workerMode === QUEUE_NAMES.gpuEncode) {
        return [runtimeEnv.workerMode] as QueueName[];
    }

    throw new Error(`Unsupported worker mode: ${runtimeEnv.workerMode}`);
}

function getQueueConcurrency(queueName: QueueName) {
    if (queueName === QUEUE_NAMES.gpuEncode) {
        return Math.max(1, runtimeEnv.gpuWorkerConcurrency);
    }

    return Math.max(1, runtimeEnv.cpuWorkerConcurrency);
}

async function createQueueWorker(queueName: QueueName, connection: IORedis) {
    const { Worker } = await import("bullmq");

    const worker = new Worker<ClipProcessJobData>(
        queueName,
        async (bullJob) => {
            try {
                await processClipJob(bullJob.data);
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);

                if (error instanceof JobCanceledError) {
                    await updateJobProgress(bullJob.data.jobId, {
                        status: PrismaJobStatus.canceled,
                        finishedAt: new Date(),
                        failureReason: "Canceled by user",
                        stage: JobStage.finalize,
                        stageProgress: 0,
                        overallProgress: 0,
                        message: "Job canceled",
                    });
                    return;
                }

                await updateJobProgress(bullJob.data.jobId, {
                    status: PrismaJobStatus.failed,
                    finishedAt: new Date(),
                    failureReason: reason,
                    stage: JobStage.finalize,
                    stageProgress: 0,
                    overallProgress: 0,
                    message: `Processing failed: ${reason}`,
                });
                throw error;
            }
        },
        {
            connection,
            concurrency: getQueueConcurrency(queueName),
        },
    );

    worker.on("ready", () => {
        process.stdout.write(
            `Worker listening on queue ${queueName} with concurrency ${getQueueConcurrency(queueName)}\n`,
        );
    });

    worker.on("completed", (completedJob) => {
        process.stdout.write(`Completed job ${completedJob.id} on queue ${queueName}\n`);
    });

    worker.on("failed", (failedJob, error) => {
        process.stderr.write(`Failed job ${failedJob?.id ?? "unknown"} on queue ${queueName}: ${error.message}\n`);
    });

    return worker;
}

async function bootstrap() {
    const connection = new IORedis(runtimeEnv.redisUrl, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
    });
    connection.on("error", () => undefined);

    try {
        await connection.connect();
    }
    catch (error) {
        throw new Error(`Unable to connect to Redis at ${runtimeEnv.redisUrl}: ${String(error)}`);
    }

    const queueNames = getEnabledQueues();
    await Promise.all(queueNames.map((queueName) => createQueueWorker(queueName, connection)));
}

bootstrap().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
});
