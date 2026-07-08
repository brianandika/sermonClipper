export const SESSION_COOKIE_NAME = "sermon_clipper_session";

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

// Discriminates the three worker pipelines. Absent ⇒ "sermon" (the original
// landscape trim/cut flow), preserving backward compatibility with existing jobs.
export type JobKind = "sermon" | "transcribeSource" | "short";

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
    captions?: boolean;
    title?: string;
    // "short" only: the sermon or transcribe job this short was cut from. Used
    // purely to group a source's exported shorts under its row in the job queue.
    parentJobId?: string;
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
