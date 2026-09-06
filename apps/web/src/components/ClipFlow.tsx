import { useEffect, useRef, useState } from 'react';
import { Asset, Job } from '../types';
import {
  createClipJob,
  createTranscribeJob,
  getAsset,
  getAssetSourceUrl,
  getAssetTranscriptText,
  getClipsForAsset,
  getJob,
  getResultArtifact,
  updateAssetTranscript,
} from '../api';

interface ClipFlowProps {
  // The uploaded source to clip. Always set before this tab is shown — it is
  // only reachable via "Upload to Clip".
  source: Asset;
  onSourceChange: (asset: Asset) => void;
  // In-flight transcription job id for `source` (lifted to App, same reason as
  // ShortsFlow's prepJobId — switching tabs never remounts and re-fires it).
  prepJobId: string | null;
  onPrepJobId: (jobId: string | null) => void;
}

interface Cue {
  start: number;
  end: number;
  text: string;
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

function parseVtt(text: string): Cue[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues: Cue[] = [];
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

function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'clip';
}

function rangeError(start: number, end: number, duration: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Start and end must be numbers';
  if (start < 0) return 'Start must be ≥ 0';
  if (end <= start) return 'End must be after start';
  if (duration > 0 && end > duration + 0.001) return 'End is beyond the video length';
  return null;
}

export default function ClipFlow({ source, onSourceChange, prepJobId, onPrepJobId }: ClipFlowProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceDuration = source.duration ?? 0;

  // Trim range
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(sourceDuration > 0 ? sourceDuration : 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(sourceDuration);
  const [title, setTitle] = useState('');

  // Fade toggle
  const [fade, setFade] = useState(false);

  // Subtitles toggle + transcript prep/review
  const [burnSubtitles, setBurnSubtitles] = useState(false);
  const [prepMessage, setPrepMessage] = useState('');
  const [prepError, setPrepError] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesError, setCuesError] = useState<string | null>(null);
  const [draftCues, setDraftCues] = useState<Cue[]>([]);
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [transcriptSaveError, setTranscriptSaveError] = useState<string | null>(null);

  // Export
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [savedClips, setSavedClips] = useState<Job[]>([]);

  const hasTranscript = Boolean(source.transcriptPath);

  // Load this source's previously exported clips on mount.
  useEffect(() => {
    let cancelled = false;
    getClipsForAsset(source.assetId)
      .then((jobs) => {
        if (!cancelled) setSavedClips(jobs.filter((job) => job.status === 'completed' && Boolean(job.result?.videoPath)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.assetId]);

  // Load the transcript once it exists, so the review panel and cue list have
  // something to show as soon as "Burn in subtitles" is checked.
  useEffect(() => {
    if (!hasTranscript) return;
    let cancelled = false;
    setCuesError(null);
    getAssetTranscriptText(source.assetId)
      .then((text) => {
        if (!cancelled) setCues(parseVtt(text));
      })
      .catch((err) => {
        if (!cancelled) setCuesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [hasTranscript, source.assetId]);

  // Poll an in-flight transcription; when it finishes, refresh the source (now
  // transcript-ready) and load its cues. Resumes cleanly on re-mount because
  // prepJobId lives in App state and the API is idempotent.
  useEffect(() => {
    if (!prepJobId) return;
    let cancelled = false;
    setPrepError(null);
    (async () => {
      for (let i = 0; i < 1200 && !cancelled; i += 1) {
        const current = await getJob(prepJobId);
        if (current.progress?.message) {
          const pct = current.progress.transcriptProgress;
          setPrepMessage(pct ? `${current.progress.message} (${pct}%)` : current.progress.message);
        }
        if (TERMINAL_STATUSES.includes(current.status)) {
          if (current.status === 'completed') {
            const updated = await getAsset(source.assetId);
            if (!cancelled) {
              onSourceChange(updated);
              onPrepJobId(null);
            }
          } else if (!cancelled) {
            setPrepError(current.failureReason || 'Transcription failed');
            onPrepJobId(null);
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
  }, [prepJobId, source.assetId]);

  // Once cues load (or reload after an edit), reseed the draft so the review
  // panel always reflects the saved transcript.
  useEffect(() => {
    setDraftCues(cues.map((cue) => ({ ...cue })));
  }, [cues]);

  const clampTime = (value: number) => {
    if (!Number.isFinite(value) || value < 0) return 0;
    if (duration > 0) return Math.min(value, duration);
    return value;
  };

  const setBoundToCurrent = (bound: 'start' | 'end') => {
    const video = videoRef.current;
    if (!video) return;
    const value = Number(clampTime(video.currentTime).toFixed(3));
    if (bound === 'start') setStart(value);
    else setEnd(value);
  };

  const jumpTo = (seconds: number) => {
    if (videoRef.current) videoRef.current.currentTime = clampTime(seconds);
  };

  // ---- Transcript handlers ----------------------------------------------
  const startTranscription = async () => {
    setPrepError(null);
    setPrepMessage('Queuing transcription…');
    try {
      const job = await createTranscribeJob(source.assetId);
      onPrepJobId(job.jobId);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateDraftCue = (index: number, text: string) => {
    setDraftCues((prev) => prev.map((cue, i) => (i === index ? { ...cue, text } : cue)));
  };

  const removeDraftCue = (index: number) => {
    setDraftCues((prev) => prev.filter((_, i) => i !== index));
  };

  const saveTranscript = async () => {
    setSavingTranscript(true);
    setTranscriptSaveError(null);
    try {
      const updated = await updateAssetTranscript(source.assetId, draftCues);
      const text = await getAssetTranscriptText(source.assetId);
      setCues(parseVtt(text));
      onSourceChange(updated);
    } catch (err) {
      setTranscriptSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTranscript(false);
    }
  };

  // ---- Export --------------------------------------------------------------
  const validationError = rangeError(start, end, duration);
  const subtitlesBlocked = burnSubtitles && (!hasTranscript || cues.length === 0);
  const exportDisabled = exporting || Boolean(validationError) || subtitlesBlocked;

  const runExport = async () => {
    if (validationError || subtitlesBlocked) return;
    setExporting(true);
    setExportError(null);
    setExportMessage('Queued…');
    try {
      const job = await createClipJob({
        assetId: source.assetId,
        startTime: start,
        endTime: end,
        fade,
        captions: burnSubtitles,
        title,
        outputVideoFilename: `${slugify(title || 'clip')}.mp4`,
      });

      let finished: Job | null = null;
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const current = await getJob(job.jobId);
        if (current.progress?.message) setExportMessage(current.progress.message);
        if (TERMINAL_STATUSES.includes(current.status)) {
          finished = current;
          break;
        }
        await sleep(1500);
      }

      if (!finished || finished.status !== 'completed') {
        throw new Error(finished?.failureReason || 'Clip processing did not complete');
      }

      setSavedClips((prev) => [finished as Job, ...prev]);
      setExportMessage('');
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const clipLength = Math.max(0, end - start);
  const totalOutputLength = fade ? clipLength + 6 : clipLength;

  return (
    <div className="container shorts-page">
      <header className="shorts-header">
        <p className="shorts-eyebrow">Clip</p>
        <h1 className="shorts-title">Clip a video</h1>
        <p className="shorts-subtitle">Source: {source.originalFilename}</p>
      </header>

      <div className="shorts-preview">
        <video
          ref={videoRef}
          className="shorts-video"
          controls
          onLoadedMetadata={(event) => {
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) {
              setDuration(value);
              if (end <= 0) setEnd(Number(value.toFixed(3)));
            }
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        >
          <source src={getAssetSourceUrl(source.assetId)} type={source.mimeType || 'video/mp4'} />
          Your browser does not support video playback.
        </video>
      </div>

      <p className="shorts-playhead">
        Playhead: <strong>{formatTimecode(currentTime)}</strong>
        {duration > 0 ? ` / ${formatTimecode(duration)}` : ''}
      </p>

      <div className="shorts-range">
        <label>
          Start
          <input type="text" value={start.toFixed(3)} onChange={(event) => setStart(Number.parseFloat(event.target.value))} />
        </label>
        <button type="button" className="btn set-start-time" onClick={() => setBoundToCurrent('start')}>Set</button>
        <button type="button" className="btn" onClick={() => jumpTo(start)}>Jump</button>
      </div>

      <div className="shorts-range">
        <label>
          End
          <input type="text" value={end.toFixed(3)} onChange={(event) => setEnd(Number.parseFloat(event.target.value))} />
        </label>
        <button type="button" className="btn set-end-time" onClick={() => setBoundToCurrent('end')}>Set</button>
        <button type="button" className="btn" onClick={() => jumpTo(end)}>Jump</button>
      </div>

      <p className="shorts-hint">
        Clip length: {formatTimecode(clipLength)}
        {fade ? ` — output will be about ${formatTimecode(totalOutputLength)} with fades` : ''}
      </p>

      {validationError && <p className="shorts-error">{validationError}</p>}

      <label>
        Title (optional)
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Missions update"
          style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
        />
      </label>

      <label className="shorts-toggle">
        <input type="checkbox" checked={fade} onChange={(event) => setFade(event.target.checked)} />
        Fade in and out (3 seconds, to black)
      </label>
      <p className="shorts-hint">
        Adds up to 3 seconds before and after your selection, using a bit of the surrounding footage.
        Your trimmed clip itself isn't shortened or dimmed.
      </p>

      <label className="shorts-toggle">
        <input type="checkbox" checked={burnSubtitles} onChange={(event) => setBurnSubtitles(event.target.checked)} />
        Burn in subtitles
      </label>

      {burnSubtitles && !hasTranscript && (
        <div className="shorts-prep">
          {prepJobId ? (
            <>
              <p className="shorts-prep-message">{prepMessage || 'Transcribing…'}</p>
              <div className="shorts-spinner" aria-hidden="true" />
              <p className="shorts-hint">
                This transcribes the whole video and only runs once for this file — long recordings take a while.
                You can leave this tab; it won't restart.
              </p>
            </>
          ) : (
            <>
              {prepError && <p className="shorts-error">{prepError}</p>}
              <p className="shorts-hint">This video has no transcript yet. Preparing one lets you review it before it's burned in.</p>
              <button type="button" className="btn" onClick={startTranscription}>
                {prepError ? 'Retry transcript' : 'Prepare transcript'}
              </button>
            </>
          )}
        </div>
      )}

      {burnSubtitles && hasTranscript && (
        <section className="shorts-transcript-editor">
          <h2 className="shorts-section-title">Review transcript</h2>
          <p className="shorts-hint">
            Check for mistakes before they're burned into the video. Timestamps stay as they are.
            Saving also updates the transcript everywhere else this video is used.
          </p>
          {cuesError && <p className="shorts-error">Couldn’t load the transcript: {cuesError}</p>}
          {transcriptSaveError && <p className="shorts-error">{transcriptSaveError}</p>}
          <div className="shorts-transcript-edit-list">
            {draftCues.map((cue, index) => (
              <div key={`draft-${index}`} className="shorts-transcript-edit-row">
                <span className="shorts-cue-time">{formatTimecode(cue.start)}</span>
                <input
                  className="shorts-transcript-edit-input"
                  type="text"
                  value={cue.text}
                  onChange={(event) => updateDraftCue(index, event.target.value)}
                  aria-label={`Cue at ${formatTimecode(cue.start)}`}
                />
                <button type="button" className="btn remove-clip" title="Delete this cue" onClick={() => removeDraftCue(index)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn" onClick={saveTranscript} disabled={savingTranscript}>
            {savingTranscript ? 'Saving…' : 'Save transcript'}
          </button>
        </section>
      )}

      {subtitlesBlocked && (
        <p className="shorts-hint">Prepare and review the transcript above before exporting with subtitles.</p>
      )}

      {exportError && <p className="shorts-error">{exportError}</p>}

      <button type="button" className="btn results-download-btn" disabled={exportDisabled} onClick={runExport}>
        {exporting ? (exportMessage || 'Exporting…') : 'Export clip'}
      </button>

      {savedClips.length > 0 && (
        <section className="shorts-saved">
          <h2 className="shorts-section-title">Clips from this video ({savedClips.length})</h2>
          <div className="shorts-saved-grid">
            {savedClips.map((job) => {
              const resultId = job.result?.resultId;
              const clipTitle = job.payload?.title
                || (job.payload?.outputVideoFilename ? job.payload.outputVideoFilename.replace(/\.[^.]+$/, '') : 'Clip');
              return (
                <article key={job.jobId} className="results-card shorts-saved-card">
                  <div className="results-card-head">
                    <h3 className="shorts-saved-title">{clipTitle}</h3>
                    <span className="results-chip">MP4</span>
                  </div>
                  {resultId && (
                    <video controls className="results-video-player shorts-saved-player">
                      <source src={getResultArtifact(resultId, 'video')} type="video/mp4" />
                    </video>
                  )}
                  {resultId && (
                    <a className="btn results-download-btn" href={getResultArtifact(resultId, 'video')} download={`${slugify(clipTitle)}.mp4`}>
                      Download
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
