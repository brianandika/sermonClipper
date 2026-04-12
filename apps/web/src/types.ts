// Types for the API
export interface Session {
  sessionId: string;
  expiresAt: string;
}

export interface Asset {
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

export interface Clip {
  id?: string;
  startTime: number;
  endTime: number;
}

export type HardwareOption = 'auto' | 'cpu' | 'intel' | 'cuda' | 'apple' | 'vaapi';

export interface PeaksResponse {
  data: number[];
  length: number;
  bits: number;
  sampleRate: number;
}

export interface FpsResponse {
  fps: number;
  duration: number;
}

export interface HardwareCapabilitiesResponse {
  detected: HardwareOption;
  available: HardwareOption[];
}

export interface Job {
  jobId: string;
  sessionId: string;
  assetId: string;
  status: string;
  requestedHardware: string;
  effectiveHardware: string | null;
  queueName: string;
  payload: {
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
  };
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: Result | null;
  progress: {
    stage: string;
    stageProgress: number;
    overallProgress: number;
    message: string;
    updatedAt: string;
  } | null;
}

export interface Result {
  resultId: string;
  jobId: string;
  sessionId: string;
  audioPath: string | null;
  videoPath: string | null;
  manifestPath?: string | null;
  sizeBytes?: string | null;
  duration?: number | null;
  expiresAt: string;
  createdAt: string;
}

export interface UploadResponse {
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
