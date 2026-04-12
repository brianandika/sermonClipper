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

export interface CreateJobRequest {
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
    videoPath: string;
    audioPath: string;
    manifestPath: string;
    sizeBytes: string | null;
    duration: number | null;
    expiresAt: string;
    createdAt: string;
}
