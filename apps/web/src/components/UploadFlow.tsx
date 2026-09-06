import { useState } from 'react';
import { uploadAsset, getAsset } from '../api';
import { Asset } from '../types';

interface UploadFlowProps {
  onSuccess: (asset: Asset) => void;
  onUploadForShorts: (asset: Asset) => void;
  onUploadForClip: (asset: Asset) => void;
}

type UploadIntent = 'sermon' | 'shorts' | 'generalClip';

export default function UploadFlow({ onSuccess, onUploadForShorts, onUploadForClip }: UploadFlowProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [intent, setIntent] = useState<UploadIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
    }
  };

  // All three buttons share one upload path; only the destination differs.
  const upload = async (chosen: UploadIntent) => {
    if (!file) return;

    setUploading(true);
    setIntent(chosen);
    setProgress(0);
    try {
      const response = await uploadAsset(file, (percent) => setProgress(percent));
      setProgress(100);

      // Fetch full asset details
      const asset = await getAsset(response.assetId);
      if (chosen === 'shorts') {
        onUploadForShorts(asset);
      } else if (chosen === 'generalClip') {
        onUploadForClip(asset);
      } else {
        onSuccess(asset);
      }
    } catch (err) {
      setError(`Upload failed: ${err}`);
      setUploading(false);
      setIntent(null);
    }
  };

  const busyLabel = (target: UploadIntent) =>
    uploading && intent === target ? `Uploading... ${progress}%` : null;

  return (
    <div className="container">
      <h1>Upload Video</h1>
      <p>Select a video file, then choose what to do with it.</p>

      <div className="grid">
        <div className="flex">
          <input
            type="file"
            id="file"
            accept="video/*"
            onChange={handleFileChange}
            disabled={uploading}
          />
        </div>

        <div className="flex" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            disabled={!file || uploading}
            onClick={() => upload('sermon')}
          >
            {busyLabel('sermon') ?? 'Upload for Clipping'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!file || uploading}
            onClick={() => upload('shorts')}
            style={{ background: '#0f766e' }}
          >
            {busyLabel('shorts') ?? 'Upload for Shorts'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!file || uploading}
            onClick={() => upload('generalClip')}
            style={{ background: '#7c3aed' }}
          >
            {busyLabel('generalClip') ?? 'Upload to Clip'}
          </button>
        </div>
      </div>

      <p style={{ marginTop: '0.75rem', color: '#64748b', fontSize: '0.9rem' }}>
        <strong>Clipping</strong> opens the editor to trim the sermon.{' '}
        <strong>Shorts</strong> transcribes the video so you can cut 9:16 vertical clips from it.{' '}
        <strong>Clip a video</strong> trims any video for another use — mid-service playback, an
        announcement — with optional fades and burned-in subtitles.
      </p>

      {error && <p style={{ color: 'red', marginTop: '1rem' }}>{error}</p>}

      {uploading && (
        <div className="progress-bar" style={{ marginTop: '2rem' }}>
          <div className="progress" style={{ width: `${progress}%` }}></div>
        </div>
      )}
    </div>
  );
}
