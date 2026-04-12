import { Job, Result } from '../types';
import { getResultArtifact } from '../api';

interface ResultsFlowProps {
  job: Job;
  result: Result;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0:00';
  }

  const totalSeconds = Math.round(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatStatus(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export default function ResultsFlow({ job, result }: ResultsFlowProps) {
  const audioUrl = getResultArtifact(result.resultId, 'audio');
  const videoUrl = getResultArtifact(result.resultId, 'video');
  const duration = job.payload.endTime - job.payload.startTime;

  return (
    <div className="container results-page">
      <header className="results-header">
        <p className="results-eyebrow">Export ready</p>
        <h1 className="results-title">Your sermon clips are ready</h1>
        <p className="results-subtitle">Preview each artifact and download the final files below.</p>
      </header>

      <section className="results-summary" aria-label="Job summary">
        <article className="results-summary-card">
          <p className="results-summary-label">Status</p>
          <p className="results-summary-value">{formatStatus(job.status)}</p>
        </article>
        <article className="results-summary-card">
          <p className="results-summary-label">Final duration</p>
          <p className="results-summary-value">{formatDuration(duration)}</p>
        </article>
      </section>

      <section className="results-grid" aria-label="Result artifacts">
        <article className="results-card">
          <div className="results-card-head">
            <h2>Audio Result</h2>
            <span className="results-chip">MP3</span>
          </div>
          <audio controls className="results-audio-player">
            <source src={audioUrl} type="audio/mpeg" />
            Your browser doesn't support audio playback.
          </audio>
          <a href={audioUrl} download="result.mp3" className="btn results-download-btn">
            Download Audio
          </a>
        </article>

        <article className="results-card">
          <div className="results-card-head">
            <h2>Video Result</h2>
            <span className="results-chip">MP4</span>
          </div>
          <video controls className="results-video-player">
            <source src={videoUrl} type="video/mp4" />
            Your browser doesn't support video playback.
          </video>
          <a href={videoUrl} download="result.mp4" className="btn results-download-btn">
            Download Video
          </a>
        </article>
      </section>
    </div>
  );
}
