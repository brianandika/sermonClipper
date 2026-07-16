import axios from 'axios';
import {
  Job,
  Result,
  UploadResponse,
  Asset,
  FpsResponse,
  PeaksResponse,
  HardwareCapabilitiesResponse,
  HardwareOption,
  ShortSuggestion,
} from './types';

const API_BASE = '/api';

export const api = axios.create({
  baseURL: API_BASE,
});

// Sessions
export const bootstrapSession = async () => {
  const { data } = await api.post('/sessions/bootstrap');
  return data;
};

// Assets
export const uploadAsset = async (
  file: File,
  onProgress?: (percent: number) => void
): Promise<UploadResponse> => {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post('/assets/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (progressEvent) => {
      if (progressEvent.total) {
        const percentComplete = Math.round(
          (progressEvent.loaded / progressEvent.total) * 100
        );
        onProgress?.(percentComplete);
        console.log(`Upload progress: ${percentComplete}%`);
      }
    },
  });
  return data;
};

export const getAsset = async (assetId: string): Promise<Asset> => {
  const { data } = await api.get(`/assets/${assetId}`);
  return data;
};

// Reuse a completed sermon's output MP4 + transcript as a shorts source
// (referenced in place — no re-transcription). Returns the derived asset.
export const createShortsSourceFromJob = async (jobId: string): Promise<Asset> => {
  const { data } = await api.post(`/assets/from-job/${jobId}`);
  return data;
};

export const getAssetFps = async (assetId: string): Promise<FpsResponse> => {
  const { data } = await api.get(`/assets/${assetId}/fps`);
  return data;
};

export const getAssetPeaks = async (assetId: string): Promise<PeaksResponse> => {
  const { data } = await api.get(`/assets/${assetId}/peaks`);
  return data;
};

export const getAssetSourceUrl = (assetId: string) => {
  return `${API_BASE}/assets/${assetId}/source`;
};

export const getAssetTranscriptUrl = (assetId: string) => {
  return `${API_BASE}/assets/${assetId}/transcript`;
};

// Fetch the raw WebVTT text of an asset's on-demand transcript (used by the
// Shorts tab to render clickable cues). 404s until a transcribeSource job runs.
export const getAssetTranscriptText = async (assetId: string): Promise<string> => {
  const { data } = await api.get(`/assets/${assetId}/transcript`, { responseType: 'text' });
  return data as string;
};

// Ask the API (Gemini) for the best shorts moments from this source's
// transcript. Returns picks ordered best-first; the Shorts tab turns each into
// a pre-framed, editable moment. Throws if AI suggestions aren't configured.
export const suggestShorts = async (assetId: string): Promise<ShortSuggestion[]> => {
  const { data } = await api.post(`/assets/${assetId}/suggest-shorts`);
  return (data?.suggestions ?? []) as ShortSuggestion[];
};

// Overwrite an asset's transcript with edited cues (typo fixes). Writes in place,
// so a shorts source derived from a sermon also corrects the sermon transcript.
export const updateAssetTranscript = async (
  assetId: string,
  cues: { start: number; end: number; text: string }[],
): Promise<Asset> => {
  const { data } = await api.put(`/assets/${assetId}/transcript`, { cues });
  return data;
};

// Jobs
export const createJob = async (jobData: {
  assetId: string;
  startTime: number;
  endTime: number;
  clipStarts: number[];
  clipEnds: number[];
  outputAudioFilename?: string;
  outputVideoFilename?: string;
  introImageAssetId?: string;
  introDuration?: number;
  transitionDuration?: number;
  fps?: number;
  hardware?: HardwareOption;
  deliverTranscript?: boolean;
}) => {
  const { data } = await api.post('/jobs', jobData);
  return data;
};

// Transcribe an uploaded source video on demand (no clip range). Prerequisite
// for building shorts / picking moments from the transcript.
export const createTranscribeJob = async (assetId: string): Promise<Job> => {
  const { data } = await api.post('/jobs', { assetId, kind: 'transcribeSource' });
  return data;
};

// Create one 9:16 vertical short from a moment of the source.
export const createShortJob = async (params: {
  assetId: string;
  startTime: number;
  endTime: number;
  cropX: number;
  cropY: number;
  zoom: number;
  captions: boolean;
  endCard: boolean;
  title?: string;
  outputVideoFilename?: string;
  parentJobId?: string;
}): Promise<Job> => {
  const { data } = await api.post('/jobs', { kind: 'short', ...params });
  return data;
};

// All persisted shorts for a source asset (newest first) — the saved shorts
// shown in the Shorts editor so they survive tab switches and reloads.
export const getShortsForAsset = async (assetId: string): Promise<Job[]> => {
  const { data } = await api.get(`/jobs/shorts/${assetId}`);
  return data;
};

export const getHardwareCapabilities = async (): Promise<HardwareCapabilitiesResponse> => {
  const { data } = await api.get('/jobs/hardware');
  return data;
};

export const getJob = async (jobId: string): Promise<Job> => {
  const { data } = await api.get(`/jobs/${jobId}`);
  return data;
};

export const getJobs = async (): Promise<Job[]> => {
  const { data } = await api.get('/jobs');
  return data;
};

export const cancelJob = async (jobId: string): Promise<Job> => {
  const { data } = await api.post(`/jobs/${jobId}/cancel`);
  return data;
};

export const pollJob = async (
  jobId: string,
  maxAttempts: number = 300,
  intervalMs: number = 1000
): Promise<Job> => {
  let attempts = 0;
  while (attempts < maxAttempts) {
    const job = await getJob(jobId);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'canceled' || job.status === 'expired') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    attempts++;
  }
  throw new Error('Job polling timeout');
};

// Results
export const getResult = async (jobId: string): Promise<Result> => {
  const { data } = await api.get(`/results/${jobId}`);
  return data;
};

export const getResultArtifact = (resultId: string, type: 'audio' | 'video' | 'transcript') => {
  return `${API_BASE}/results/${resultId}/${type}`;
};
