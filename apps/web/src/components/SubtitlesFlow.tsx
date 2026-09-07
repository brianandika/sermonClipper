import { useEffect, useState } from 'react';
import { EditableTranscriptCue, Job, SubtitlesDraft } from '../types';
import {
  createBurnSubtitlesJob,
  createRetryTranscriptJob,
  getJob,
  getResult,
  getResultArtifact,
  getResultTranscriptText,
} from '../api';

interface SubtitlesFlowProps {
  // The completed sermon job whose video gets captioned. Always has a finished
  // video — the Subtitles tab is only reachable via a job/result's "Add
  // Subtitles" action, which gates on `result?.videoPath`.
  sourceJob: Job;
  draft: SubtitlesDraft;
  onDraftChange: (patch: Partial<SubtitlesDraft>) => void;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'canceled', 'expired'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseTimestamp(raw: string): number | null {
  const parts = raw.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((part) => Number.parseFloat(part));
  if (nums.some((num) => !Number.isFinite(num))) return null;
  return parts.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
}

function parseVtt(text: string): EditableTranscriptCue[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues: EditableTranscriptCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const arrow = lines[i].indexOf('-->');
    if (arrow === -1) {
      i += 1;
      continue;
    }
    const start = parseTimestamp(lines[i].slice(0, arrow));
    const end = parseTimestamp(lines[i].slice(arrow + 3).trim().split(/\s+/)[0] ?? '');
    i += 1;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i].replace(/<[^>]*>/g, '').trim());
      i += 1;
    }
    if (start !== null && end !== null && end > start) {
      cues.push({ start, end, text: textLines.join(' ').trim() });
    }
  }
  return cues;
}

function formatVttTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
}

function buildVttText(cues: EditableTranscriptCue[]): string {
  const body = cues
    .map((cue) => `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export default function SubtitlesFlow({ sourceJob, draft, onDraftChange }: SubtitlesFlowProps) {
  const [loadingCues, setLoadingCues] = useState(false);
  const [cuesError, setCuesError] = useState<string | null>(null);
  const [prepMessage, setPrepMessage] = useState('');
  const [prepError, setPrepError] = useState<string | null>(null);

  const [burning, setBurning] = useState(false);
  const [burnMessage, setBurnMessage] = useState('');
  const [burnProgress, setBurnProgress] = useState(0);
  const [burnError, setBurnError] = useState<string | null>(null);
  const [burnedJob, setBurnedJob] = useState<Job | null>(null);

  const hasTranscriptAlready = Boolean(sourceJob.result?.transcriptPath);

  // Auto-load the transcript once we know it exists — sermon jobs produce one
  // as a best-effort step right after rendering, so it's usually already there.
  useEffect(() => {
    if (draft.cuesLoaded || draft.prepJobId || !sourceJob.result?.transcriptPath) return;
    let cancelled = false;
    setLoadingCues(true);
    setCuesError(null);
    (async () => {
      try {
        const text = await getResultTranscriptText(sourceJob.result!.resultId);
        if (!cancelled) onDraftChange({ cues: parseVtt(text), cuesLoaded: true });
      } catch (err) {
        if (!cancelled) setCuesError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoadingCues(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceJob.jobId, draft.cuesLoaded, draft.prepJobId]);

  // Resume polling an in-flight "prepare transcript" retry job — lives in the
  // lifted draft so it survives switching away from this tab.
  useEffect(() => {
    if (!draft.prepJobId || draft.cuesLoaded) return;
    let cancelled = false;
    const prepJobId = draft.prepJobId;
    setPrepError(null);
    (async () => {
      for (let attempt = 0; attempt < 1200 && !cancelled; attempt += 1) {
        const current = await getJob(prepJobId);
        if (current.progress?.message) {
          const pct = current.progress.transcriptProgress;
          setPrepMessage(pct ? `${current.progress.message} (${pct}%)` : current.progress.message);
        }
        if (TERMINAL_STATUSES.includes(current.status)) {
          if (current.status !== 'completed') {
            if (!cancelled) {
              setPrepError(current.failureReason || 'Transcription failed');
              onDraftChange({ prepJobId: null });
            }
            return;
          }
          try {
            const result = await getResult(sourceJob.jobId);
            if (!result.transcriptPath) {
              throw new Error('Transcription finished but produced no transcript');
            }
            const text = await getResultTranscriptText(result.resultId);
            if (!cancelled) onDraftChange({ cues: parseVtt(text), cuesLoaded: true, prepJobId: null });
          } catch (err) {
            if (!cancelled) {
              setPrepError(err instanceof Error ? err.message : String(err));
              onDraftChange({ prepJobId: null });
            }
          }
          return;
        }
        await sleep(1500);
      }
    })().catch((err) => {
      if (!cancelled) setPrepError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.prepJobId, draft.cuesLoaded, sourceJob.jobId]);

  const startTranscription = async () => {
    setPrepError(null);
    setPrepMessage('Queuing transcription…');
    try {
      const job = await createRetryTranscriptJob({ assetId: sourceJob.assetId, sourceJobId: sourceJob.jobId });
      onDraftChange({ prepJobId: job.jobId });
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateCueText = (index: number, text: string) => {
    onDraftChange({ cues: draft.cues.map((cue, i) => (i === index ? { ...cue, text } : cue)) });
  };

  const removeCue = (index: number) => {
    onDraftChange({ cues: draft.cues.filter((_, i) => i !== index) });
  };

  const handleBurn = async () => {
    if (draft.cues.length === 0) return;
    setBurning(true);
    setBurnError(null);
    setBurnedJob(null);
    setBurnMessage('Queuing…');
    setBurnProgress(0);
    try {
      const created = await createBurnSubtitlesJob({
        assetId: sourceJob.assetId,
        sourceJobId: sourceJob.jobId,
        captionsVtt: buildVttText(draft.cues),
      });

      let finished: Job | null = null;
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const current = await getJob(created.jobId);
        if (current.progress?.message) setBurnMessage(current.progress.message);
        if (current.progress?.videoProgress !== undefined) setBurnProgress(current.progress.videoProgress);
        if (TERMINAL_STATUSES.includes(current.status)) {
          finished = current;
          break;
        }
        await sleep(1500);
      }

      if (!finished || finished.status !== 'completed') {
        throw new Error(finished?.failureReason || 'Burning in subtitles did not complete');
      }
      setBurnedJob(finished);
    } catch (err) {
      setBurnError(err instanceof Error ? err.message : String(err));
    } finally {
      setBurning(false);
    }
  };

  const sourceVideoUrl = sourceJob.result ? getResultArtifact(sourceJob.result.resultId, 'video') : null;
  const burnedVideoUrl = burnedJob?.result ? getResultArtifact(burnedJob.result.resultId, 'video') : null;

  if (!draft.cuesLoaded) {
    return (
      <div className="container shorts-page">
        <header className="shorts-header">
          <p className="shorts-eyebrow">Subtitles</p>
          <h1 className="shorts-title">Prepare transcript</h1>
          <p className="shorts-subtitle">Source job: {sourceJob.jobId.slice(0, 8)}</p>
        </header>

        {loadingCues ? (
          <div className="shorts-prep">
            <p className="shorts-prep-message">Loading transcript…</p>
            <div className="shorts-spinner" aria-hidden="true" />
          </div>
        ) : draft.prepJobId ? (
          <div className="shorts-prep">
            <p className="shorts-prep-message">{prepMessage || 'Transcribing…'}</p>
            <div className="shorts-spinner" aria-hidden="true" />
            <p className="shorts-hint">This runs once for this video. You can leave this tab — it won't restart.</p>
          </div>
        ) : (
          <div className="shorts-prep">
            {cuesError && <p className="shorts-error">Couldn't load the transcript: {cuesError}</p>}
            {prepError && <p className="shorts-error">{prepError}</p>}
            <p className="shorts-hint">
              {hasTranscriptAlready
                ? 'This video has a transcript, but it failed to load.'
                : "This video doesn't have a transcript yet (transcription may have been disabled, or failed). Prepare one before burning in subtitles."}
            </p>
            <div className="shorts-prep-actions">
              <button type="button" className="btn" onClick={startTranscription}>
                {prepError || cuesError ? 'Retry transcript' : 'Prepare transcript & continue'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="container shorts-page">
      <header className="shorts-header">
        <p className="shorts-eyebrow">Subtitles</p>
        <h1 className="shorts-title">Review transcript & burn in subtitles</h1>
        <p className="shorts-subtitle">Source job: {sourceJob.jobId.slice(0, 8)}</p>
      </header>

      {sourceVideoUrl && (
        <video controls className="shorts-video" src={sourceVideoUrl} style={{ marginBottom: '1.25rem' }}>
          Your browser doesn't support video playback.
        </video>
      )}

      <section className="shorts-transcript-editor">
        <div className="shorts-transcript-editor-head">
          <h2 className="shorts-section-title">Transcript</h2>
        </div>
        <p className="shorts-hint">Fix typos, delete lines you don't want captioned, then burn in subtitles below.</p>
        {draft.cues.length === 0 ? (
          <p className="shorts-hint">No transcript cues were found for this video.</p>
        ) : (
          <div className="shorts-transcript-edit-list">
            {draft.cues.map((cue, index) => (
              <div key={`cue-${index}`} className="shorts-transcript-edit-row">
                <span className="shorts-cue-time">{formatTimecode(cue.start)}</span>
                <input
                  className="shorts-transcript-edit-input"
                  type="text"
                  value={cue.text}
                  onChange={(event) => updateCueText(index, event.target.value)}
                  aria-label={`Cue at ${formatTimecode(cue.start)}`}
                />
                <button type="button" className="btn remove-clip" title="Delete this cue" onClick={() => removeCue(index)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {burnError && <p className="shorts-error">{burnError}</p>}

      <div className="shorts-prep-actions" style={{ marginTop: '1.25rem' }}>
        <button type="button" className="btn" disabled={burning || draft.cues.length === 0} onClick={handleBurn}>
          {burning ? 'Burning in subtitles…' : 'Burn in Subtitles'}
        </button>
      </div>

      {burning && (
        <div className="shorts-progress" style={{ marginTop: '1rem' }}>
          <div className="progress-bar">
            <div className="progress" style={{ width: `${burnProgress}%` }} />
          </div>
          <p className="shorts-hint">{burnMessage || 'Working…'}</p>
        </div>
      )}

      {burnedJob && burnedVideoUrl && (
        <section className="shorts-transcript-editor" style={{ marginTop: '1.25rem' }}>
          <h2 className="shorts-section-title">Captioned video</h2>
          <video controls className="shorts-video" src={burnedVideoUrl} style={{ marginTop: '0.75rem' }}>
            Your browser doesn't support video playback.
          </video>
          <a href={burnedVideoUrl} download className="btn results-download-btn" style={{ marginTop: '0.75rem', display: 'inline-block' }}>
            Download Captioned Video
          </a>
        </section>
      )}
    </div>
  );
}
