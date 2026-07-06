import { useEffect, useState } from 'react';
import { Job, Result } from '../types';
import { getJob, getResult, getResultArtifact } from '../api';

interface ResultsFlowProps {
  job: Job;
  result: Result;
}

function formatStatus(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function ensureExtension(filename: string | undefined, extension: '.mp3' | '.mp4', fallback: string): string {
  const trimmed = filename?.trim() ?? '';
  if (!trimmed) {
    return fallback;
  }

  const withoutExt = trimmed.replace(/\.[^.]+$/, '');
  const safeBase = withoutExt.trim() || fallback.replace(/\.[^.]+$/, '');
  return `${safeBase}${extension}`;
}

function getRequestedBaseName(job: Job): string | undefined {
  const source = job.payload.outputAudioFilename ?? job.payload.outputVideoFilename;
  const trimmed = source?.trim() ?? '';
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\.[^.]+$/, '');
}

export default function ResultsFlow({ job, result }: ResultsFlowProps) {
  const [currentJob, setCurrentJob] = useState(job);
  const [currentResult, setCurrentResult] = useState(result);

  useEffect(() => {
    setCurrentJob(job);
  }, [job]);

  useEffect(() => {
    setCurrentResult(result);
  }, [result]);

  useEffect(() => {
    // Keep polling until the job is terminal so both the video (published before
    // transcription) and the transcript (added after) are picked up.
    if (['completed', 'failed', 'canceled', 'expired'].includes(currentJob.status)) {
      return;
    }

    let active = true;

    const refreshResultState = async () => {
      const [nextJob, nextResult] = await Promise.allSettled([
        getJob(currentJob.jobId),
        getResult(currentJob.jobId),
      ]);

      if (!active) {
        return;
      }

      if (nextJob.status === 'fulfilled') {
        setCurrentJob(nextJob.value);
      }

      if (nextResult.status === 'fulfilled') {
        setCurrentResult(nextResult.value);
      }
    };

    void refreshResultState();
    const intervalId = window.setInterval(() => {
      void refreshResultState();
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [currentJob.jobId, currentJob.status, currentResult.videoPath]);

  const audioUrl = getResultArtifact(currentResult.resultId, 'audio');
  const videoUrl = getResultArtifact(currentResult.resultId, 'video');
  const transcriptUrl = getResultArtifact(currentResult.resultId, 'transcript');
  // Prefer the worker's actual measured output duration (accounts for removed
  // middle clips and crossfades); fall back to the kept-span estimate.
  const requestedBaseName = getRequestedBaseName(currentJob);
  const audioDownloadName = ensureExtension(requestedBaseName, '.mp3', 'result.mp3');
  const videoDownloadName = ensureExtension(requestedBaseName, '.mp4', 'result.mp4');
  const transcriptDownloadName = `${requestedBaseName?.trim() || 'transcript'}.vtt`;
  const isVideoReady = Boolean(currentResult.videoPath);
  const isAudioReady = Boolean(currentResult.audioPath);
  const isTranscriptReady = Boolean(currentResult.transcriptPath);
  const jobIsTerminal = ['completed', 'failed', 'canceled', 'expired'].includes(currentJob.status);
  // Transcript is written together with the video, so it appears once the video
  // is ready. Hide the card if the job finished without one (disabled/failed).
  const showTranscriptCard = isTranscriptReady || !jobIsTerminal;

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
          <p className="results-summary-value">{formatStatus(currentJob.status)}</p>
        </article>
      </section>

      <section className="results-grid" aria-label="Result artifacts">
        <article className="results-card">
          <div className="results-card-head">
            <h2>Audio Result</h2>
            <span className="results-chip">MP3</span>
          </div>
          {isAudioReady ? (
            <>
              <audio controls className="results-audio-player">
                <source src={audioUrl} type="audio/mpeg" />
                Your browser doesn't support audio playback.
              </audio>
              <a href={audioUrl} download={audioDownloadName} className="btn results-download-btn">
                Download Audio
              </a>
            </>
          ) : (
            <p className="results-pending-copy">Audio is still being prepared.</p>
          )}
        </article>

        <article className="results-card">
          <div className="results-card-head">
            <h2>Video Result</h2>
            <span className="results-chip">MP4</span>
          </div>
          {isVideoReady ? (
            <>
              <video controls className="results-video-player">
                <source src={videoUrl} type="video/mp4" />
                Your browser doesn't support video playback.
              </video>
              <a href={videoUrl} download={videoDownloadName} className="btn results-download-btn">
                Download Video
              </a>
            </>
          ) : (
            <div className="results-pending-state">
              <p className="results-pending-copy">Video is still processing. You can download the MP3 now and come back for the MP4 once encoding finishes.</p>
              <p className="results-pending-status">Current job status: {formatStatus(currentJob.status)}</p>
            </div>
          )}
        </article>

        {showTranscriptCard && (
          <article className="results-card">
            <div className="results-card-head">
              <h2>Transcript</h2>
              <span className="results-chip">VTT</span>
            </div>
            {isTranscriptReady ? (
              <>
                <iframe
                  title="Sermon transcript"
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
                <a href={transcriptUrl} download={transcriptDownloadName} className="btn results-download-btn">
                  Download Captions (VTT)
                </a>
              </>
            ) : (
              <p className="results-pending-copy">Transcript is generated after the video finishes encoding.</p>
            )}
          </article>
        )}
      </section>
    </div>
  );
}
