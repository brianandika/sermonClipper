export const SESSION_COOKIE_NAME = "sermon_clipper_session";

// YouTube Shorts (and IG Reels) cap a clip at 3 minutes, so a short's
// start→end span may not exceed this.
export const MAX_SHORT_DURATION_SEC = 180;

export const QUEUE_NAMES = {
    clipProcess: "clip-process",
    gpuEncode: "gpu-encode",
    youtubeUpload: "youtube-upload",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export enum JobStatus {
    queued = "queued",
    preparing = "preparing",
    processingAudio = "processing_audio",
    encodingVideo = "encoding_video",
    encodingAudio = "encoding_audio",
    completed = "completed",
    failed = "failed",
    canceled = "canceled",
    expired = "expired",
}

export enum JobStage {
    extractClips = "EXTRACT_CLIPS",
    buildTransitions = "BUILD_TRANSITIONS",
    normalizeAudio = "NORMALIZE_AUDIO",
    waitingForEncode = "WAITING_FOR_ENCODE",
    encodeVideo = "ENCODE_VIDEO",
    encodeAudio = "ENCODE_AUDIO",
    transcribe = "TRANSCRIBE",
    finalize = "FINALIZE",
    complete = "COMPLETE",
}

export enum HardwareOption {
    auto = "auto",
    cpu = "cpu",
    cuda = "cuda",
    intel = "intel",
    apple = "apple",
    vaapi = "vaapi",
}

export interface SessionBootstrapResponse {
    sessionId: string;
    expiresAt: string;
    queueNames: typeof QUEUE_NAMES;
}

export interface HealthResponse {
    status: "ok";
    service: string;
    timestamp: string;
}

export interface AssetResponse {
    assetId: string;
    sessionId: string;
    originalFilename: string;
    mimeType: string;
    fileSize: string;
    sourcePath: string;
    fps: number | null;
    duration: number | null;
    transcriptPath: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
}

export interface PeaksResponse {
    data: number[];
    length: number;
    bits: number;
    sampleRate: number;
}

export interface TranscriptCue {
    start: number;
    end: number;
    text: string;
}

// Body for editing an asset's transcript (typo/spelling fixes). The API writes a
// canonical WebVTT to the asset's transcriptPath in place.
export interface UpdateTranscriptRequest {
    cues: TranscriptCue[];
}

// One AI-suggested shorts moment: a self-contained span of the source worth
// clipping, with a punchy heading and a short "why it's shareable" rationale.
// start/end are seconds into the source and always satisfy
// 0 <= start < end and (end - start) <= MAX_SHORT_DURATION_SEC.
export interface ShortSuggestion {
    start: number;
    end: number;
    heading: string;
    description: string;
}

// Response of POST /assets/:assetId/suggest-shorts — the model's picks, ordered
// best-first. Empty when the transcript yields nothing clip-worthy.
export interface SuggestShortsResponse {
    suggestions: ShortSuggestion[];
}

// Discriminates the worker pipelines. Absent ⇒ "sermon" (the original
// landscape trim/cut flow), preserving backward compatibility with existing jobs.
export type JobKind = "sermon" | "transcribeSource" | "short" | "burnSubtitles";

// Default and max for "sermon"'s configurable fade-in/out length
// (CreateJobRequest.fadeSeconds).
export const DEFAULT_FADE_SECONDS = 1;
export const MAX_FADE_SECONDS = 5;

export interface CreateJobRequest {
    kind?: JobKind;
    startTime: number;
    endTime: number;
    clipStarts?: number[];
    clipEnds?: number[];
    outputAudioFilename?: string;
    outputVideoFilename?: string;
    introImageAssetId?: string;
    introDuration?: number;
    transitionDuration?: number;
    fps?: number;
    hardware?: HardwareOption;
    // "short" only: horizontal/vertical crop position (0..1) and zoom (>=1) for
    // the 9:16 window, whether to burn in captions (default true), and a display
    // title (persisted so saved shorts show a friendly name). cropY only has an
    // effect once zoomed in (a zoom=1 window already spans the full height).
    cropX?: number;
    cropY?: number;
    zoom?: number;
    // "short": burn captions unless explicitly false (best-effort — degrades to
    // no captions).
    captions?: boolean;
    // "short" only: append the church end card (a branded 9:16 image) after the
    // clip, with a quick crossfade into it and a 3s hold. Default true.
    endCard?: boolean;
    title?: string;
    // "short" only: the sermon or transcribe job this short was cut from. Used
    // purely to group a source's exported shorts under its row in the job queue.
    parentJobId?: string;
    // "sermon" only: when true (the default), the worker delivers the finished VTT
    // transcript to the configured SermonGuide inbox. Users can opt out per job.
    deliverTranscript?: boolean;
    // "sermon" only: fade the composed output in/out (both audio and video),
    // this many seconds at each end. 0 = no fade. Default DEFAULT_FADE_SECONDS
    // (1s — the original, previously-unconditional behavior), max
    // MAX_FADE_SECONDS. Dims the output's own existing first/last frames —
    // does not extend the output's length or read outside [startTime, endTime].
    fadeSeconds?: number;
    // "sermon" only: by default every output is scaled/padded to a standard
    // 1920x1080 canvas. Set true to skip that and keep the source's own
    // resolution/aspect ratio instead (every segment — and the intro image,
    // if any — still shares one consistent size for clean concatenation;
    // that size is just the source's own rather than a forced 1080p).
    preserveAspectRatio?: boolean;
    // "transcribeSource" (retry mode) and "burnSubtitles": the OTHER job whose
    // finished Result.videoPath this one operates on — transcribing it (if it
    // has no transcript yet) or burning captions into a new derived copy of
    // it. Must belong to the same session and already have a finished video.
    sourceJobId?: string;
    // "burnSubtitles" only, required: the reviewed WebVTT text to burn in,
    // already 0-based against sourceJobId's own finished video (produced by
    // transcribing that exact video — see processTranscribeSourceJob's retry
    // mode). The API rejects the job if this is missing/empty.
    captionsVtt?: string;
}

export interface JobResponse {
    jobId: string;
    sessionId: string;
    assetId: string;
    status: JobStatus;
    requestedHardware: HardwareOption;
    effectiveHardware: HardwareOption | null;
    queueName: string;
    payload: CreateJobRequest;
    failureReason: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    result: ResultResponse | null;
    progress: {
        stage: string;
        stageProgress: number;
        overallProgress: number;
        audioProgress: number;
        videoProgress: number;
        transcriptProgress: number;
        message: string;
        updatedAt: string;
    } | null;
}

export interface ClipProcessJobData {
    jobId: string;
}

export interface ResultResponse {
    resultId: string;
    jobId: string;
    sessionId: string;
    videoPath: string | null;
    audioPath: string | null;
    transcriptPath: string | null;
    manifestPath: string | null;
    sizeBytes: string | null;
    duration: number | null;
    expiresAt: string;
    createdAt: string;
}
