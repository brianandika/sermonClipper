import { Job, Result } from '../types';
import { getResultArtifact } from '../api';

interface ResultsFlowProps {
  job: Job;
  result: Result;
  onReset: () => void;
}

export default function ResultsFlow({ job, result, onReset }: ResultsFlowProps) {
  const audioUrl = getResultArtifact(result.resultId, 'audio');
  const videoUrl = getResultArtifact(result.resultId, 'video');
  const keptClipCount = job.payload.clipStarts?.length ?? 0;
  const duration = job.payload.endTime - job.payload.startTime;

  return (
    <div className="container">
      <h1>Processing Complete!</h1>

      <div style={{ marginBottom: '2rem' }}>
        <p>Job Status: <strong>{job.status}</strong></p>
        <p>Duration: {duration}s</p>
        <p>Kept clips: {keptClipCount}</p>
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <h2>Audio Result (MP3)</h2>
        <audio controls style={{ width: '100%' }}>
          <source src={audioUrl} type="audio/mpeg" />
          Your browser doesn't support audio playback.
        </audio>
        <a href={audioUrl} download="result.mp3" className="btn" style={{ marginTop: '1rem', display: 'inline-block' }}>
          Download Audio
        </a>
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <h2>Video Result (MP4)</h2>
        <video controls style={{ width: '100%', maxWidth: '600px' }}>
          <source src={videoUrl} type="video/mp4" />
          Your browser doesn't support video playback.
        </video>
        <a href={videoUrl} download="result.mp4" className="btn" style={{ marginTop: '1rem', display: 'inline-block' }}>
          Download Video
        </a>
      </div>

      <button className="btn" onClick={onReset} style={{ marginTop: '2rem', width: '100%' }}>
        Process Another Video
      </button>
    </div>
  );
}
