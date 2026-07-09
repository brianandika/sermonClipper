import { Asset, Job } from '../types';
import { getAssetSourceUrl, getAssetTranscriptUrl } from '../api';

interface TranscribeResultsFlowProps {
  job: Job;
  asset: Asset;
  onOpenShorts: (job: Job) => void;
  shortsBusy: boolean;
}

// Result view for a transcribe-only job. Such jobs write no Result row (they only
// set the asset's transcript), so the video and transcript come straight from the
// uploaded asset. Mirrors the clip Results page layout, minus the audio card.
export default function TranscribeResultsFlow({ job, asset, onOpenShorts, shortsBusy }: TranscribeResultsFlowProps) {
  const videoUrl = getAssetSourceUrl(asset.assetId);
  const transcriptUrl = getAssetTranscriptUrl(asset.assetId);
  const hasTranscript = Boolean(asset.transcriptPath);
  const videoDownloadName = asset.originalFilename?.trim() || 'video.mp4';

  return (
    <div className="container results-page">
      <header className="results-header">
        <p className="results-eyebrow">Transcription ready</p>
        <h1 className="results-title">Your transcript is ready</h1>
        <p className="results-subtitle">Review the uploaded video and its transcript, then create shorts.</p>
      </header>

      <section className="results-summary" aria-label="Job summary">
        <article className="results-summary-card">
          <p className="results-summary-label">Status</p>
          <p className="results-summary-value">Completed</p>
        </article>
      </section>

      <div className="results-shorts-cta">
        <div>
          <p className="results-shorts-cta-title">✂ Create Shorts from this video</p>
          <p className="results-shorts-cta-copy">Uses this video and transcript — pick moments and export 9:16 vertical clips.</p>
        </div>
        <button type="button" className="btn" disabled={shortsBusy} onClick={() => onOpenShorts(job)}>
          {shortsBusy ? 'Opening…' : 'Open Shorts'}
        </button>
      </div>

      <section className="results-grid" aria-label="Result artifacts">
        <article className="results-card">
          <div className="results-card-head">
            <h2>Video</h2>
            <span className="results-chip">Source</span>
          </div>
          <video controls className="results-video-player">
            <source src={videoUrl} type={asset.mimeType || 'video/mp4'} />
            Your browser doesn't support video playback.
          </video>
          <a href={videoUrl} download={videoDownloadName} className="btn results-download-btn">
            Download Video
          </a>
        </article>

        <article className="results-card">
          <div className="results-card-head">
            <h2>Transcript</h2>
            <span className="results-chip">VTT</span>
          </div>
          {hasTranscript ? (
            <>
              <iframe
                title="Transcript"
                src={transcriptUrl}
                className="results-transcript-preview"
                style={{
                  width: '100%',
                  height: '180px',
                  border: '1px solid rgba(148, 163, 184, 0.4)',
                  borderRadius: '8px',
                  background: '#fff',
                }}
              />
              <a href={transcriptUrl} download="transcript.vtt" className="btn results-download-btn">
                Download Captions (VTT)
              </a>
            </>
          ) : (
            <p className="results-pending-copy">No transcript was found for this video.</p>
          )}
        </article>
      </section>
    </div>
  );
}
