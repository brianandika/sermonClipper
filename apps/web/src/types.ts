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
  transcriptPath: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type JobKind = 'sermon' | 'transcribeSource' | 'short' | 'burnSubtitles';

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
    cropX?: number;
    cropY?: number;
    zoom?: number;
    captions?: boolean;
    endCard?: boolean;
    title?: string;
    parentJobId?: string;
    fadeSeconds?: number;
    preserveAspectRatio?: boolean;
    sourceJobId?: string;
    captionsVtt?: string;
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
    audioProgress: number;
    videoProgress: number;
    transcriptProgress: number;
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
  transcriptPath?: string | null;
  manifestPath?: string | null;
  sizeBytes?: string | null;
  duration?: number | null;
  expiresAt: string;
  createdAt: string;
}

// One line of a transcript, as edited/reviewed client-side (never persisted
// until "Burn in subtitles" is clicked). Mirrors the API's TranscriptCue.
export interface EditableTranscriptCue {
  start: number;
  end: number;
  text: string;
}

// SubtitlesFlow's per-source-job state, lifted to App so switching tabs
// (which unmounts it) never loses the loaded/edited transcript or an
// in-flight prepare-transcript job — the same reason ShortsFlow/the old
// ClipFlow lift their own state. Unlike Clip's old draft, there's no
// start/end/staleness to track here at all: this operates on one already-
// finished video in full, so the transcript never goes stale underneath it.
export interface SubtitlesDraft {
  sourceJobId: string;
  cues: EditableTranscriptCue[];
  // Whether `cues` reflect a loaded/prepared transcript yet (distinct from
  // `cues.length === 0`, which could also just mean an empty transcript).
  cuesLoaded: boolean;
  prepJobId: string | null;
}

// One AI-suggested shorts moment from the sermon transcript (heading +
// rationale + a start/end span in seconds). Mirrors the API's ShortSuggestion.
export interface ShortSuggestion {
  start: number;
  end: number;
  heading: string;
  description: string;
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
  transcriptPath: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}
