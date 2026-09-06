import { useEffect, useMemo, useRef, useState } from 'react';
import { Asset, Job } from '../types';
import {
  createClipJob,
  createClipTranscribeJob,
  getAssetSourceUrl,
  getClipsForAsset,
  getJob,
  getResult,
  getResultArtifact,
  getResultTranscriptText,
} from '../api';

interface ClipFlowProps {
  // The uploaded source to clip. Always set before this tab is shown — it is
  // only reachable via "Upload to Clip".
  source: Asset;
  onSourceChange: (asset: Asset) => void;
  // In-flight clip-transcription job id (lifted to App, same reason as
  // ShortsFlow's prepJobId — switching tabs never remounts and re-fires it).
  // Unlike Shorts, this is scoped to the clip's own [start, end, fade], not
  // the whole source — see createClipTranscribeJob.
  prepJobId: string | null;
  onPrepJobId: (jobId: string | null) => void;
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

// What [start, end, fade] a prepared transcript actually covers. Compared
// against the current controls to detect a stale transcript (the user moved
// the trim points or toggled fade after preparing).
interface PreparedFor {
  start: number;
  end: number;
  fade: boolean;
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

// The inverse of parseVtt: serialize edited cues back into WebVTT text to send
// as captionsVtt on export. Cues emptied out during review are dropped.
function formatVttTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function cuesToVtt(cues: Cue[]): string {
  const body = cues
    .filter((cue) => cue.text.trim().length > 0)
    .map((cue) => `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text.trim()}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// Pull the human-readable message out of an axios error's response body
// (NestJS exceptions serialize to { statusCode, message, ... }) instead of the
// generic "Request failed with status code 400" axios itself produces.
function axiosErrorMessage(err: unknown): string | null {
  const data = (err as { response?: { data?: { message?: unknown } } })?.response?.data;
  const message = data?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && message.length > 0) return String(message[0]);
  return null;
}

function describeError(err: unknown): string {
  return axiosErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
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
  void onSourceChange; // reserved: nothing here mutates the source asset itself
  const videoRef = useRef<HTMLVideoElement>(null);
  const cueRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sourceDuration = source.duration ?? 0;

  // Trim range
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(sourceDuration > 0 ? sourceDuration : 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(sourceDuration);
  const [title, setTitle] = useState('');

  // Fade toggle
  const [fade, setFade] = useState(false);

  // Subtitles toggle + clip-scoped transcript prep/review. Unlike Shorts, this
  // transcript is NEVER written to the asset — it only ever covers this one
  // clip's own window, held entirely client-side until export.
  const [burnSubtitles, setBurnSubtitles] = useState(false);
  const [prepMessage, setPrepMessage] = useState('');
  const [prepError, setPrepError] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesError, setCuesError] = useState<string | null>(null);
  const [preparedFor, setPreparedFor] = useState<PreparedFor | null>(null);
  // What [start, end, fade] the in-flight prepJobId was launched for — read
  // when it completes, since the controls may have moved on by then.
  const preparingForRef = useRef<PreparedFor | null>(null);

  // Export
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [savedClips, setSavedClips] = useState<Job[]>([]);

  // A prepared transcript is stale once the range or fade it was prepared for
  // no longer matches the current controls — the effective (fade-widened)
  // window it covers has shifted, so the burned-in captions would desync.
  const isStale = cues.length > 0 && preparedFor !== null
    && (preparedFor.start !== start || preparedFor.end !== end || preparedFor.fade !== fade);

  const activeCueIndex = useMemo(
    () => cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end),
    [cues, currentTime],
  );

  useEffect(() => {
    if (activeCueIndex < 0) return;
    cueRefs.current[activeCueIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeCueIndex]);

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

  // Poll an in-flight clip-transcription job; when it finishes, fetch its
  // (small, clip-scoped) transcript and load it for review. Resumes cleanly
  // on re-mount because prepJobId lives in App state.
  useEffect(() => {
    if (!prepJobId) return;
    if (!preparingForRef.current) {
      // Re-mounted with an already-in-flight job (e.g. tab switch) — best
      // effort: assume it covers the controls as they currently stand.
      preparingForRef.current = { start, end, fade };
    }
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
            try {
              const result = await getResult(prepJobId);
              if (!result.resultId) throw new Error('Transcript job finished but produced no result');
              const text = await getResultTranscriptText(result.resultId);
              if (!cancelled) {
                setCues(parseVtt(text));
                setPreparedFor(preparingForRef.current);
                setCuesError(null);
              }
            } catch (err) {
              if (!cancelled) setCuesError(describeError(err));
            } finally {
              if (!cancelled) onPrepJobId(null);
            }
          } else if (!cancelled) {
            setPrepError(current.failureReason || 'Transcription failed');
            onPrepJobId(null);
          }
          preparingForRef.current = null;
          return;
        }
        await sleep(1500);
      }
    })().catch((err) => {
      if (!cancelled) setPrepError(describeError(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepJobId]);

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
    setCuesError(null);
    setPrepMessage('Queuing transcription…');
    preparingForRef.current = { start, end, fade };
    try {
      const job = await createClipTranscribeJob({ assetId: source.assetId, startTime: start, endTime: end, fade });
      onPrepJobId(job.jobId);
    } catch (err) {
      preparingForRef.current = null;
      setPrepError(describeError(err));
    }
  };

  const updateCue = (index: number, text: string) => {
    setCues((prev) => prev.map((cue, i) => (i === index ? { ...cue, text } : cue)));
  };

  const removeCue = (index: number) => {
    setCues((prev) => prev.filter((_, i) => i !== index));
  };

  // ---- Export --------------------------------------------------------------
  const validationError = rangeError(start, end, duration);
  const subtitlesBlocked = burnSubtitles && (cues.length === 0 || isStale);
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
        captionsVtt: burnSubtitles ? cuesToVtt(cues) : undefined,
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
      setExportError(describeError(err));
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

      <div className="shorts-editor-body">
        <section className="shorts-preview-col">
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

          {burnSubtitles && (cues.length === 0 || (!prepJobId && isStale)) && (
            <div className="shorts-prep">
              {prepJobId ? (
                <>
                  <p className="shorts-prep-message">{prepMessage || 'Transcribing…'}</p>
                  <div className="shorts-spinner" aria-hidden="true" />
                  <p className="shorts-hint">
                    Transcribing just this clip — much faster than the whole video. You can leave this tab; it won't restart.
                  </p>
                </>
              ) : (
                <>
                  {prepError && <p className="shorts-error">{prepError}</p>}
                  {cuesError && <p className="shorts-error">Couldn’t load the transcript: {cuesError}</p>}
                  {isStale && (
                    <p className="shorts-hint">
                      Your clip's start, end, or fade setting changed since this transcript was prepared — it no longer
                      matches. Re-prepare it before exporting with subtitles.
                    </p>
                  )}
                  {!isStale && (
                    <p className="shorts-hint">
                      This clip has no transcript yet. Preparing one transcribes just your selected range — not the
                      whole video — so you can review it before it's burned in.
                    </p>
                  )}
                  <button type="button" className="btn" onClick={startTranscription} disabled={Boolean(validationError)}>
                    {prepError || isStale ? 'Re-prepare transcript' : 'Prepare transcript'}
                  </button>
                </>
              )}
            </div>
          )}

          {exportError && <p className="shorts-error">{exportError}</p>}

          <button type="button" className="btn results-download-btn" disabled={exportDisabled} onClick={runExport}>
            {exporting ? (exportMessage || 'Exporting…') : 'Export clip'}
          </button>
        </section>

        <section className="shorts-transcript-col">
          <h3 className="shorts-section-title">Transcript</h3>
          {cues.length === 0 ? (
            <p className="shorts-hint">
              {burnSubtitles ? 'Prepare a transcript above to see it here.' : 'Check "Burn in subtitles" to prepare a transcript for this clip.'}
            </p>
          ) : (
            <div className="shorts-transcript" role="list">
              {cues.map((cue, cueIndex) => (
                <button
                  key={`cue-${cueIndex}`}
                  type="button"
                  role="listitem"
                  ref={(el) => { cueRefs.current[cueIndex] = el; }}
                  className={`shorts-cue${cueIndex === activeCueIndex ? ' active' : ''}`}
                  onClick={() => jumpTo(cue.start)}
                  title="Jump this player to this point"
                >
                  <span className="shorts-cue-time">{formatTimecode(cue.start)}</span>
                  <span className="shorts-cue-text">{cue.text || '…'}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {burnSubtitles && cues.length > 0 && (
        <section className="shorts-transcript-editor">
          <h2 className="shorts-section-title">Review transcript</h2>
          <p className="shorts-hint">
            Check for mistakes before they're burned into the video — timestamps stay as they are. Edits here apply
            automatically when you export; nothing is saved until then.
          </p>
          {isStale && (
            <p className="shorts-error">
              This transcript no longer matches your current clip range/fade — re-prepare it above before exporting.
            </p>
          )}
          <div className="shorts-transcript-edit-list">
            {cues.map((cue, index) => (
              <div key={`cue-edit-${index}`} className="shorts-transcript-edit-row">
                <span className="shorts-cue-time">{formatTimecode(cue.start)}</span>
                <input
                  className="shorts-transcript-edit-input"
                  type="text"
                  value={cue.text}
                  onChange={(event) => updateCue(index, event.target.value)}
                  aria-label={`Cue at ${formatTimecode(cue.start)}`}
                />
                <button type="button" className="btn remove-clip" title="Delete this cue" onClick={() => removeCue(index)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

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
