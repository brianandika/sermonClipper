import "dotenv/config";
import "reflect-metadata";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import IORedis from "ioredis";
import { PrismaClient, JobStatus as PrismaJobStatus, HardwareOption } from "@prisma/client";
import { JobStage, QUEUE_NAMES, type ClipProcessJobData, type CreateJobRequest, type JobKind, type QueueName } from "@sermon-clipper/shared";
import { buildAssFromVtt, buildShortVideoFilter, clamp, MAX_ZOOM, MIN_ZOOM } from "./captions";

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

type FfmpegRunOptions = {
    totalDurationSec?: number;
    onProgress?: (fraction: number) => void;
};

// Runs ffmpeg while streaming its `-progress` output so callers can report
// smooth intra-operation progress. Returns captured stderr (needed for the
// loudnorm JSON). Honors job cancellation via the shared AbortController set.
async function runFfmpeg(jobId: string, args: string[], options: FfmpegRunOptions = {}): Promise<{ stderr: string }> {
    await assertJobNotCanceled(jobId);

    const controller = new AbortController();
    registerJobController(jobId, controller);

    const total = options.totalDurationSec && options.totalDurationSec > 0 ? options.totalDurationSec : 0;
    const fullArgs = ["-progress", "pipe:1", "-nostats", ...args];

    return await new Promise<{ stderr: string }>((resolve, reject) => {
        const child = spawn(runtimeEnv.ffmpegPath, fullArgs, { signal: controller.signal });
        let stderr = "";
        let stdoutBuffer = "";

        child.stdout?.on("data", (chunk: Buffer) => {
            if (total <= 0 || !options.onProgress) {
                return;
            }

            stdoutBuffer += chunk.toString();
            let newlineIndex = stdoutBuffer.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = stdoutBuffer.slice(0, newlineIndex).trim();
                stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
                if (line.startsWith("out_time_us=")) {
                    const microseconds = Number.parseInt(line.slice("out_time_us=".length), 10);
                    if (Number.isFinite(microseconds) && microseconds >= 0) {
                        options.onProgress(microseconds / 1_000_000 / total);
                    }
                }
                newlineIndex = stdoutBuffer.indexOf("\n");
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
            unregisterJobController(jobId, controller);
            if (error.name === "AbortError") {
                reject(new JobCanceledError(jobId));
                return;
            }
            reject(error);
        });

        child.on("close", (code) => {
            unregisterJobController(jobId, controller);
            if (controller.signal.aborted) {
                reject(new JobCanceledError(jobId));
                return;
            }
            if (code === 0) {
                resolve({ stderr });
                return;
            }
            reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-800)}`));
        });
    });
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
    stage?: JobStage;
    stageProgress?: number;
    overallProgress?: number;
    audioProgress?: number;
    videoProgress?: number;
    transcriptProgress?: number;
    message?: string;
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
                        stage: data.stage ?? JobStage.extractClips,
                        stageProgress: data.stageProgress ?? 0,
                        overallProgress: data.overallProgress ?? 0,
                        audioProgress: data.audioProgress ?? 0,
                        videoProgress: data.videoProgress ?? 0,
                        transcriptProgress: data.transcriptProgress ?? 0,
                        message: data.message ?? "",
                    },
                    update: {
                        stage: data.stage,
                        stageProgress: data.stageProgress,
                        overallProgress: data.overallProgress,
                        audioProgress: data.audioProgress,
                        videoProgress: data.videoProgress,
                        transcriptProgress: data.transcriptProgress,
                        message: data.message,
                    },
                },
            },
        },
    });
}

// Serialize progress writes per job so throttled mid-op tick writes and awaited
// boundary checkpoints never race (last write wins in submission order).
const progressWriteChains = new Map<string, Promise<unknown>>();

function enqueueProgressWrite(jobId: string, data: Parameters<typeof updateJobProgress>[1]) {
    const previous = progressWriteChains.get(jobId) ?? Promise.resolve();
    const next = previous.then(() => updateJobProgress(jobId, data)).catch(() => undefined);
    progressWriteChains.set(jobId, next);
    return next;
}

type PhaseField = "audioProgress" | "videoProgress" | "transcriptProgress";

// Maps a 0..1 op fraction into a [low, high] slice of a phase bar and emits
// throttled, monotonic progress updates. The ffmpeg process has fully closed by
// the time we await the next boundary checkpoint, so no stale ticks arrive late.
function createBandReporter(jobId: string, field: PhaseField, low: number, high: number) {
    let lastValue = -1;
    let lastWriteAt = 0;
    return (fraction: number) => {
        const clamped = Math.max(0, Math.min(1, fraction));
        const value = Math.round(low + (high - low) * clamped);
        const now = Date.now();
        if (value <= lastValue) {
            return;
        }
        if (value < high && now - lastWriteAt < 400) {
            return;
        }
        lastValue = value;
        lastWriteAt = now;
        const update: Parameters<typeof updateJobProgress>[1] = {};
        update[field] = value;
        void enqueueProgressWrite(jobId, update);
    };
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

async function analyzeAudioNormalization(
    jobId: string,
    inputPath: string,
    totalDurationSec?: number,
    onProgress?: (fraction: number) => void,
) {
    const { stderr } = await runFfmpeg(jobId, [
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
    ], { totalDurationSec, onProgress });

    return getLoudnormAnalysis(stderr);
}

async function normalizeVideoAudio(
    jobId: string,
    inputPath: string,
    outputPath: string,
    analysis: LoudnormAnalysis,
    totalDurationSec?: number,
    onProgress?: (fraction: number) => void,
) {
    await runFfmpeg(jobId, [
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
    ], { totalDurationSec, onProgress });
}

async function normalizeAudioOnly(
    jobId: string,
    inputPath: string,
    outputPath: string,
    analysis: LoudnormAnalysis,
    totalDurationSec?: number,
    onProgress?: (fraction: number) => void,
) {
    await runFfmpeg(jobId, [
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
    ], { totalDurationSec, onProgress });
}

async function encodeSegment(
    jobId: string,
    sourcePath: string,
    outputPath: string,
    startTime: number,
    duration: number,
    hardware: HardwareOption,
    fps?: number,
    onProgress?: (fraction: number) => void,
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

    await runFfmpeg(jobId, args, { totalDurationSec: duration, onProgress });
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

// Extract a 16 kHz mono PCM WAV — the format faster-whisper decodes most
// reliably — for the standalone transcribeSource pipeline.
async function extractAudioForTranscription(jobId: string, videoPath: string, audioPath: string) {
    await runFfmpeg(jobId, [
        "-hide_banner",
        "-y",
        "-i",
        videoPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        audioPath,
    ]);
}

// Whether this ffmpeg build exposes the libass-backed "ass" filter needed to
// burn captions. Probed once and cached, mirroring JobHardwareService's
// capability caching in the API. When absent, shorts still encode — just
// without captions — and the result message records the fallback.
let assCapabilityPromise: Promise<boolean> | null = null;

async function canBurnCaptions(): Promise<boolean> {
    if (!assCapabilityPromise) {
        assCapabilityPromise = (async () => {
            try {
                const { stdout } = await execFileAsync(runtimeEnv.ffmpegPath, ["-hide_banner", "-filters"]);
                return /\bass\b/.test(stdout);
            }
            catch {
                return false;
            }
        })();
    }

    return assCapabilityPromise;
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
    onProgress?: (fraction: number) => void,
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

    await runFfmpeg(jobId, args, { totalDurationSec: outputDuration, onProgress });
}

async function renderSegmentsWithTransitions(
    jobId: string,
    segmentPaths: string[],
    segmentDurations: number[],
    outputPath: string,
    transitionDurations: number[],
    hardware: HardwareOption,
    onProgress?: (fraction: number) => void,
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

    await runFfmpeg(jobId, args, { totalDurationSec: outputDuration, onProgress });
}

async function renderConcatenatedVideoArtifact(
    jobId: string,
    segmentPaths: string[],
    segmentDurations: number[],
    outputPath: string,
    hardware: HardwareOption,
    onProgress?: (fraction: number) => void,
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

    await runFfmpeg(jobId, args, { totalDurationSec: outputDuration, onProgress });
}

async function createStillImageClip(
    jobId: string,
    imagePath: string,
    outputPath: string,
    introDuration: number,
    fps: number,
    onProgress?: (fraction: number) => void,
) {
    await runFfmpeg(jobId, [
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
    ], { totalDurationSec: introDuration, onProgress });
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

async function runTranscribeProcess(jobId: string, args: string[], onProgress?: (fraction: number) => void) {
    await assertJobNotCanceled(jobId);

    const controller = new AbortController();
    registerJobController(jobId, controller);

    return await new Promise<void>((resolve, reject) => {
        const child = spawn(runtimeEnv.pythonPath, args, { signal: controller.signal });
        let stderrTail = "";
        let stderrBuffer = "";

        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderrTail = (stderrTail + text).slice(-2000);
            if (!onProgress) {
                return;
            }

            stderrBuffer += text;
            let newlineIndex = stderrBuffer.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = stderrBuffer.slice(0, newlineIndex).trim();
                stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
                const marker = "[transcribe] progress=";
                if (line.startsWith(marker)) {
                    const pct = Number.parseInt(line.slice(marker.length), 10);
                    if (Number.isFinite(pct)) {
                        onProgress(Math.max(0, Math.min(1, pct / 100)));
                    }
                }
                newlineIndex = stderrBuffer.indexOf("\n");
            }
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
            unregisterJobController(jobId, controller);
            if (error.name === "AbortError") {
                reject(new JobCanceledError(jobId));
                return;
            }
            reject(error);
        });

        child.on("close", (code) => {
            unregisterJobController(jobId, controller);
            if (controller.signal.aborted) {
                reject(new JobCanceledError(jobId));
                return;
            }
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`transcribe exited with code ${code}: ${stderrTail.slice(-500)}`));
        });
    });
}

async function transcribeAudio(
    jobId: string,
    audioPath: string,
    outputTranscriptPath: string,
    onProgress?: (fraction: number) => void,
) {
    const scriptPath = resolveTranscribeScript();
    if (!scriptPath) {
        process.stderr.write("Transcription skipped: transcribe.py not found\n");
        return null;
    }

    try {
        await runTranscribeProcess(jobId, [
            scriptPath,
            "--audio", audioPath,
            "--output", outputTranscriptPath,
            "--model", runtimeEnv.whisperModel,
            "--model-dir", runtimeEnv.whisperModelDir,
            "--device", runtimeEnv.whisperDevice,
            "--compute-type", runtimeEnv.whisperComputeType,
            "--language", runtimeEnv.whisperLanguage,
        ], onProgress);

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
        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.preparing,
            effectiveHardware,
            startedAt: new Date(),
            stage: JobStage.extractClips,
            stageProgress: 0,
            overallProgress: 3,
            audioProgress: 0,
            videoProgress: 0,
            transcriptProgress: 0,
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
            // Segment extraction fills the first 55% of the audio bar (video reuses these clips).
            const segmentBandLow = (index / segments.length) * 55;
            const segmentBandHigh = ((index + 1) / segments.length) * 55;
            await encodeSegment(
                job.id,
                job.asset.sourcePath,
                segmentPath,
                segment.startTime,
                duration,
                effectiveHardware,
                requestedFps,
                createBandReporter(job.id, "audioProgress", segmentBandLow, segmentBandHigh),
            );
            segmentPaths.push(segmentPath);
            segmentDurations.push(duration);

            await enqueueProgressWrite(job.id, {
                status: PrismaJobStatus.preparing,
                stage: JobStage.extractClips,
                stageProgress: Math.round(((index + 1) / segments.length) * 100),
                overallProgress: Math.round(((index + 1) / segments.length) * 30),
                audioProgress: Math.round(segmentBandHigh),
                message: `Encoded segment ${index + 1} of ${segments.length}`,
            });
        }

        const audioTransitionDuration = getTransitionDuration(segments, defaultAudioTransitionDurationSeconds);
        const audioTransitionDurations = getUniformTransitionDurations(segmentDurations, audioTransitionDuration);
        const expectedAudioDuration = getSequenceDuration(segmentDurations, audioTransitionDurations);

        await assertJobNotCanceled(job.id);

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.encoding_audio,
            stage: JobStage.encodeAudio,
            stageProgress: 10,
            overallProgress: 34,
            audioProgress: 55,
            message: "Rendering stitched audio artifact",
        });

        await renderAudioArtifact(
            job.id,
            segmentPaths,
            segmentDurations,
            audioTransitionDurations,
            audioProgramPath,
            createBandReporter(job.id, "audioProgress", 55, 70),
        );

        await assertJobNotCanceled(job.id);

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.normalizeAudio,
            stageProgress: 20,
            overallProgress: 40,
            audioProgress: 70,
            message: "Analyzing stitched audio levels",
        });

        const audioLoudnormAnalysis = await analyzeAudioNormalization(
            job.id,
            audioProgramPath,
            expectedAudioDuration,
            createBandReporter(job.id, "audioProgress", 70, 82),
        );

        await assertJobNotCanceled(job.id);

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.normalizeAudio,
            stageProgress: 55,
            overallProgress: 48,
            audioProgress: 82,
            message: "Normalizing stitched audio artifact",
        });

        try {
            await normalizeAudioOnly(
                job.id,
                audioProgramPath,
                outputAudioPath,
                audioLoudnormAnalysis,
                expectedAudioDuration,
                createBandReporter(job.id, "audioProgress", 82, 100),
            );
        }
        finally {
            await rm(audioProgramPath, { force: true });
        }

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.normalizeAudio,
            stageProgress: 100,
            overallProgress: 55,
            audioProgress: 100,
            message: "Audio artifact ready",
        });

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
            await enqueueProgressWrite(job.id, {
                status: PrismaJobStatus.encoding_video,
                stage: JobStage.encodeVideo,
                stageProgress: 0,
                overallProgress: 58,
                videoProgress: 0,
                message: "Building intro image clip",
            });

            await createStillImageClip(
                job.id,
                introImageAsset.sourcePath,
                introClipPath,
                introDuration,
                requestedFps,
                createBandReporter(job.id, "videoProgress", 0, 5),
            );
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
        const expectedVideoDuration = getSequenceDuration(videoSegmentDurations, videoTransitionDurations);

        if (videoTransitionDuration > 0 && videoSegmentPaths.length > 1) {
            await enqueueProgressWrite(job.id, {
                status: PrismaJobStatus.encoding_video,
                stage: JobStage.buildTransitions,
                stageProgress: 0,
                overallProgress: 60,
                videoProgress: 5,
                message: `Rendering ${videoSegmentPaths.length - 1} video crossfade transition(s)`,
            });

            await renderSegmentsWithTransitions(
                job.id,
                videoSegmentPaths,
                videoSegmentDurations,
                videoProgramPath,
                videoTransitionDurations,
                effectiveHardware,
                createBandReporter(job.id, "videoProgress", 5, 80),
            );

            await assertJobNotCanceled(job.id);

            await enqueueProgressWrite(job.id, {
                status: PrismaJobStatus.encoding_video,
                stage: JobStage.buildTransitions,
                stageProgress: 100,
                overallProgress: 75,
                videoProgress: 80,
                message: "Transition rendering complete",
            });
        }
        else {
            await enqueueProgressWrite(job.id, {
                status: PrismaJobStatus.encoding_video,
                stage: JobStage.encodeVideo,
                stageProgress: 0,
                overallProgress: 60,
                videoProgress: 5,
                message: "Rendering stitched video artifact",
            });

            await renderConcatenatedVideoArtifact(
                job.id,
                videoSegmentPaths,
                videoSegmentDurations,
                videoProgramPath,
                effectiveHardware,
                createBandReporter(job.id, "videoProgress", 5, 80),
            );
        }

        await assertJobNotCanceled(job.id);

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.normalizeAudio,
            stageProgress: 70,
            overallProgress: 82,
            videoProgress: 80,
            message: "Analyzing stitched video audio levels",
        });

        try {
            const videoLoudnormAnalysis = await analyzeAudioNormalization(
                job.id,
                videoProgramPath,
                expectedVideoDuration,
                createBandReporter(job.id, "videoProgress", 80, 90),
            );

            await assertJobNotCanceled(job.id);

            await enqueueProgressWrite(job.id, {
                status: PrismaJobStatus.processing_audio,
                stage: JobStage.normalizeAudio,
                stageProgress: 90,
                overallProgress: 88,
                videoProgress: 90,
                message: "Normalizing stitched video audio",
            });

            await normalizeVideoAudio(
                job.id,
                videoProgramPath,
                outputVideoPath,
                videoLoudnormAnalysis,
                expectedVideoDuration,
                createBandReporter(job.id, "videoProgress", 90, 100),
            );
        }
        finally {
            await rm(videoProgramPath, { force: true });
            await rm(introClipPath, { force: true });
        }

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.encoding_video,
            stage: JobStage.normalizeAudio,
            stageProgress: 100,
            overallProgress: 92,
            videoProgress: 100,
            message: "Video artifact ready",
        });

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

        const expiresAt = new Date();
        expiresAt.setUTCDate(expiresAt.getUTCDate() + runtimeEnv.resultTtlDays);

        // Publish the finished video result now so it is downloadable immediately,
        // before the (slower) transcription step runs.
        await prisma.$transaction([
            prisma.result.upsert({
                where: { jobId: job.id },
                update: {
                    sessionId: job.sessionId,
                    videoPath: outputVideoPath,
                    audioPath: outputAudioPath,
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
                    manifestPath: processingManifestPath,
                    sizeBytes: BigInt(outputStats.size),
                    duration: outputDuration,
                    expiresAt,
                },
            }),
            prisma.processingArtifact.createMany({
                data: [
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
                ],
            }),
        ]);

        // Transcribe the exported audio to a WebVTT (.vtt) transcript (best-effort).
        // Runs after the video is published; a failure never fails the job.
        const outputTranscriptPath = join(jobRoot, `${outputAudioFilename.replace(/\.mp3$/i, "")}.vtt`);

        if (runtimeEnv.transcriptionEnabled) {
            await enqueueProgressWrite(job.id, {
                stage: JobStage.transcribe,
                stageProgress: 0,
                overallProgress: 95,
                transcriptProgress: 0,
                message: "Transcribing sermon audio",
            });

            const transcriptPath = await transcribeAudio(
                job.id,
                outputAudioPath,
                outputTranscriptPath,
                createBandReporter(job.id, "transcriptProgress", 0, 100),
            );

            await assertJobNotCanceled(job.id);

            if (transcriptPath) {
                const transcriptStats = await stat(transcriptPath);
                await prisma.$transaction([
                    prisma.result.update({
                        where: { jobId: job.id },
                        data: { transcriptPath },
                    }),
                    prisma.processingArtifact.create({
                        data: {
                            jobId: job.id,
                            type: "transcript",
                            filename: basename(transcriptPath),
                            storagePath: transcriptPath,
                            sizeBytes: BigInt(transcriptStats.size),
                        },
                    }),
                ]);

                await enqueueProgressWrite(job.id, {
                    stage: JobStage.transcribe,
                    stageProgress: 100,
                    overallProgress: 99,
                    transcriptProgress: 100,
                    message: "Transcript ready",
                });
            }
        }

        await enqueueProgressWrite(job.id, {
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
        progressWriteChains.delete(payload.jobId);
    }
}

// transcribeSource: transcribe an uploaded source video on demand so shorts can
// be built without first running a full sermon job. Writes the .vtt next to the
// asset source and records Asset.transcriptPath. No Result row. Unlike the
// sermon path's best-effort transcription, a failure here is fatal — a short
// needs the transcript to pick moments and (optionally) burn captions.
async function processTranscribeSourceJob(payload: ClipProcessJobData) {
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

        if (!runtimeEnv.transcriptionEnabled) {
            throw new Error("Transcription is disabled on this worker (ENABLE_TRANSCRIPTION=false)");
        }

        const effectiveHardware = job.effectiveHardware ?? (job.requestedHardware ?? HardwareOption.auto) as HardwareOption;
        const jobRoot = getJobRoot(job.sessionId, job.id);
        const workingAudioPath = join(jobRoot, "source-audio.wav");
        // Store the transcript alongside the asset source so it survives beyond
        // this transient job and can be reused by every short of this asset.
        const transcriptPath = join(dirname(job.asset.sourcePath), "transcript.vtt");

        await mkdir(jobRoot, { recursive: true });
        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.preparing,
            effectiveHardware,
            startedAt: new Date(),
            stage: JobStage.extractClips,
            stageProgress: 0,
            overallProgress: 5,
            transcriptProgress: 0,
            message: "Extracting audio for transcription",
        });

        await extractAudioForTranscription(job.id, job.asset.sourcePath, workingAudioPath);

        await assertJobNotCanceled(job.id);
        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.processing_audio,
            stage: JobStage.transcribe,
            stageProgress: 10,
            overallProgress: 20,
            transcriptProgress: 0,
            message: "Transcribing source audio",
        });

        let producedTranscript: string | null = null;
        try {
            producedTranscript = await transcribeAudio(
                job.id,
                workingAudioPath,
                transcriptPath,
                createBandReporter(job.id, "transcriptProgress", 0, 100),
            );
        }
        finally {
            await rm(workingAudioPath, { force: true });
        }

        await assertJobNotCanceled(job.id);

        if (!producedTranscript) {
            throw new Error("Transcription produced no transcript for the source video");
        }

        await prisma.asset.update({
            where: { id: job.assetId },
            data: { transcriptPath: producedTranscript },
        });

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.completed,
            finishedAt: new Date(),
            failureReason: null,
            stage: JobStage.complete,
            stageProgress: 100,
            overallProgress: 100,
            transcriptProgress: 100,
            message: "Source transcript ready",
        });
    }
    finally {
        stopJobCancellationWatcher(payload.jobId);
        progressWriteChains.delete(payload.jobId);
    }
}

// short: single-pass FFmpeg — crop the 9:16 window from the source, scale to
// 1080x1920, optionally burn captions sliced from the asset transcript, and
// encode one MP4. No MP3, no re-transcription, no two-pass loudnorm. The Result
// is written once at completion with a real videoPath (no early sentinel).
async function processShortJob(payload: ClipProcessJobData) {
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
        const startTime = request.startTime;
        const endTime = request.endTime;
        const duration = getDurationSeconds(startTime, endTime);

        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error("Short requires a positive [startTime, endTime] range");
        }

        const effectiveHardware = job.effectiveHardware ?? (job.requestedHardware ?? HardwareOption.auto) as HardwareOption;
        const zoom = clamp(request.zoom && request.zoom > 0 ? request.zoom : 1, MIN_ZOOM, MAX_ZOOM);
        const cropX = clamp(request.cropX ?? 0.5, 0, 1);
        const cropY = clamp(request.cropY ?? 0.5, 0, 1);
        const wantCaptions = request.captions !== false;
        const jobRoot = getJobRoot(job.sessionId, job.id);
        const assFilePath = join(jobRoot, "captions.ass");
        const outputVideoFilename = sanitizeOutputFilename(request.outputVideoFilename, ".mp4", "short-video");
        const outputVideoPath = join(jobRoot, outputVideoFilename);

        await mkdir(jobRoot, { recursive: true });
        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.preparing,
            effectiveHardware,
            startedAt: new Date(),
            stage: JobStage.extractClips,
            stageProgress: 0,
            overallProgress: 5,
            videoProgress: 0,
            message: "Preparing vertical clip",
        });

        const media = await detectMediaProperties(job.id, job.asset.sourcePath);

        // Resolve captions: needs the request flag, an asset transcript, cues in
        // range, and libass support. Any miss degrades to a caption-less encode.
        let captionsApplied = false;
        let captionNote = "";

        if (wantCaptions) {
            const libassReady = await canBurnCaptions();
            if (!libassReady) {
                captionNote = "captions skipped: libass unavailable";
            }
            else if (!job.asset.transcriptPath || !existsSync(job.asset.transcriptPath)) {
                captionNote = "captions skipped: no source transcript";
            }
            else {
                const vtt = await readFile(job.asset.transcriptPath, "utf8");
                const ass = buildAssFromVtt(vtt, startTime, endTime);
                if (ass.cueCount > 0) {
                    await writeFile(assFilePath, ass.content);
                    captionsApplied = true;
                }
                else {
                    captionNote = "captions skipped: no transcript lines in range";
                }
            }
        }

        const videoFilter = buildShortVideoFilter(
            media.width,
            media.height,
            zoom,
            cropX,
            cropY,
            captionsApplied ? assFilePath : undefined,
        );

        await assertJobNotCanceled(job.id);
        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.encoding_video,
            stage: JobStage.encodeVideo,
            stageProgress: 0,
            overallProgress: 15,
            videoProgress: 5,
            message: captionsApplied ? "Encoding vertical clip with captions" : "Encoding vertical clip",
        });

        try {
            await runFfmpeg(job.id, [
                "-hide_banner",
                "-y",
                "-ss",
                String(startTime),
                "-i",
                job.asset.sourcePath,
                "-t",
                String(duration),
                "-vf",
                videoFilter,
                ...getVideoEncodingArgs(effectiveHardware),
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                outputVideoPath,
            ], {
                totalDurationSec: duration,
                onProgress: createBandReporter(job.id, "videoProgress", 5, 100),
            });
        }
        finally {
            await rm(assFilePath, { force: true });
        }

        await assertJobNotCanceled(job.id);

        const outputStats = await stat(outputVideoPath);
        const outputDuration = await detectOutputDuration(job.id, outputVideoPath);
        const expiresAt = new Date();
        expiresAt.setUTCDate(expiresAt.getUTCDate() + runtimeEnv.resultTtlDays);

        // Write the Result once, at completion, with a real videoPath — video-only
        // (audioPath/manifestPath stay null; the API 404s those artifacts).
        await prisma.$transaction([
            prisma.result.upsert({
                where: { jobId: job.id },
                update: {
                    sessionId: job.sessionId,
                    videoPath: outputVideoPath,
                    sizeBytes: BigInt(outputStats.size),
                    duration: outputDuration,
                    expiresAt,
                },
                create: {
                    jobId: job.id,
                    sessionId: job.sessionId,
                    videoPath: outputVideoPath,
                    sizeBytes: BigInt(outputStats.size),
                    duration: outputDuration,
                    expiresAt,
                },
            }),
            prisma.processingArtifact.create({
                data: {
                    jobId: job.id,
                    type: "video",
                    filename: basename(outputVideoPath),
                    storagePath: outputVideoPath,
                    sizeBytes: BigInt(outputStats.size),
                },
            }),
        ]);

        await enqueueProgressWrite(job.id, {
            status: PrismaJobStatus.completed,
            finishedAt: new Date(),
            failureReason: null,
            stage: JobStage.complete,
            stageProgress: 100,
            overallProgress: 100,
            videoProgress: 100,
            message: captionsApplied
                ? "Short ready"
                : (captionNote ? `Short ready (${captionNote})` : "Short ready"),
        });
    }
    finally {
        stopJobCancellationWatcher(payload.jobId);
        progressWriteChains.delete(payload.jobId);
    }
}

// Route a job to its pipeline by the payload's `kind` discriminator. Absent or
// "sermon" ⇒ the original landscape flow. The BullMQ message is only { jobId },
// so we read the kind from the persisted job row.
async function dispatchJob(payload: ClipProcessJobData) {
    const job = await prisma.job.findUnique({
        where: { id: payload.jobId },
        select: { payloadJson: true },
    });

    const kind = (job?.payloadJson as { kind?: JobKind } | null)?.kind;

    if (kind === "transcribeSource") {
        await processTranscribeSourceJob(payload);
        return;
    }

    if (kind === "short") {
        await processShortJob(payload);
        return;
    }

    await processClipJob(payload);
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

function createRedisConnection() {
    const connection = new IORedis(runtimeEnv.redisUrl, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
    });
    connection.on("error", () => undefined);
    return connection;
}

async function createQueueWorker(queueName: QueueName) {
    const { Worker } = await import("bullmq");

    // Each worker gets its OWN Redis connection. A BullMQ worker holds a blocking
    // consumer (BZPOPMIN); sharing one connection across queues lets a single
    // half-closed connection (e.g. after an ungraceful restart) wedge every queue
    // — jobs then sit in `wait` and never drain.
    const connection = createRedisConnection();
    try {
        await connection.connect();
    }
    catch (error) {
        throw new Error(`Unable to connect to Redis at ${runtimeEnv.redisUrl}: ${String(error)}`);
    }

    const worker = new Worker<ClipProcessJobData>(
        queueName,
        async (bullJob) => {
            try {
                await dispatchJob(bullJob.data);
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

    return { worker, connection };
}

async function bootstrap() {
    const queueNames = getEnabledQueues();
    const created = await Promise.all(queueNames.map((queueName) => createQueueWorker(queueName)));

    // Graceful shutdown. On any restart — ts-node-dev respawn (a watched file
    // changed), Docker/orchestrator SIGTERM on redeploy, or Ctrl-C — close each
    // worker so its blocking Redis consumer is torn down cleanly. Without this the
    // process was killed abruptly, and a respawned worker could come up wedged and
    // never pull queued jobs (they piled up in `wait`). A hard timeout keeps a
    // long in-flight encode from blocking the restart forever.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stdout.write(`Received ${signal}, closing workers…\n`);

        const forceExit = setTimeout(() => {
            process.stderr.write("Shutdown timed out; forcing exit.\n");
            process.exit(0);
        }, 10_000);
        forceExit.unref();

        try {
            await Promise.all(created.map(({ worker }) => worker.close()));
            await Promise.all(created.map(({ connection }) => connection.quit().catch(() => undefined)));
        }
        catch (error) {
            process.stderr.write(`Error during shutdown: ${String(error)}\n`);
        }
        finally {
            clearTimeout(forceExit);
        }
        process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
});
