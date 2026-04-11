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

// Jobs
export const createJob = async (jobData: {
  assetId: string;
  startTime: number;
  endTime: number;
  clipStarts: number[];
  clipEnds: number[];
  introImageAssetId?: string;
  introDuration?: number;
  transitionDuration?: number;
  fps?: number;
  hardware?: HardwareOption;
}) => {
  const { data } = await api.post('/jobs', jobData);
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

export const getResultArtifact = (resultId: string, type: 'audio' | 'video') => {
  return `${API_BASE}/results/${resultId}/${type}`;
};
