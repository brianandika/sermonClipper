import { useState } from 'react';
import { uploadAsset, getAsset } from '../api';
import { Asset } from '../types';

interface UploadFlowProps {
  onSuccess: (asset: Asset) => void;
}

export default function UploadFlow({ onSuccess }: UploadFlowProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    setProgress(0);
    try {
      const response = await uploadAsset(file, (percent) => setProgress(percent));
      setProgress(100);
      
      // Fetch full asset details
      const asset = await getAsset(response.assetId);
      onSuccess(asset);
    } catch (err) {
      setError(`Upload failed: ${err}`);
      setUploading(false);
    }
  };

  return (
    <div className="container">
      <h1>Upload Video</h1>
      <p>Select a video file to begin</p>

      <form onSubmit={handleSubmit} className="grid">
        <div className="flex">
          <input
            type="file"
            id="file"
            accept="video/*"
            onChange={handleFileChange}
            disabled={uploading}
          />
          <button type="submit" className="btn" disabled={!file || uploading}>
            {uploading ? `Uploading... ${progress}%` : 'Upload'}
          </button>
        </div>
      </form>

      {error && <p style={{ color: 'red', marginTop: '1rem' }}>{error}</p>}

      {uploading && (
        <div className="progress-bar" style={{ marginTop: '2rem' }}>
          <div className="progress" style={{ width: `${progress}%` }}></div>
        </div>
      )}
    </div>
  );
}
