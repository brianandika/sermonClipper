import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Asset, Job, Result } from '../types';
import {
  createShortJob,
  createShortsSourceFromJob,
  createTranscribeJob,
  getAsset,
  getAssetSourceUrl,
  getAssetTranscriptText,
  getJob,
  getJobs,
  getResult,
  getResultArtifact,
  uploadAsset,
} from '../api';

interface ShortsFlowProps {
  // The asset the user uploaded in this session (if any) — offered as a source.
  uploadedAsset: Asset | null;
  // The chosen shorts source (lifted to App so switching tabs never restarts work).
  source: Asset | null;
  onSourceChange: (asset: Asset | null) => void;
  // In-flight transcription job id for `source` (also lifted to App).
  prepJobId: string | null;
  onPrepJobId: (jobId: string | null) => void;
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

type MomentStatus = 'idle' | 'processing' | 'completed' | 'failed';

interface Moment {
  id: string;
  title: string;
  start: number;
  end: number;
  cropX: number;
  zoom: number;
  captions: boolean;
  status: MomentStatus;
  jobId?: string;
  result?: Result;
  message?: string;
}

// A full-height 9:16 window spans (9/16) / (16/9) = 81/256 of a 16:9 frame's
// width. Must match computeShortCrop / buildShortVideoFilter in the worker.
const WINDOW_FRACTION = 81 / 256;
const TERMINAL_STATUSES = ['completed', 'failed', 'canceled', 'expired'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let momentSeq = 0;
const nextMomentId = () => {
  momentSeq += 1;
  return `moment-${momentSeq}`;
};

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
  return base || 'short';
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

function cropWindowStyle(cropX: number, zoom: number): CSSProperties {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  // Zoom in (>1) tightens the window in both dimensions; zoom out (<1) grows it
  // until it captures the whole frame (clamped to the video box — the export
  // adds black bars around what exceeds the frame).
  const widthPct = Math.min(100, (WINDOW_FRACTION / z) * 100);
  const heightPct = Math.min(100, (1 / z) * 100);
  const leftPct = cropX * (100 - widthPct);
  const topPct = (100 - heightPct) / 2;
  return { left: `${leftPct}%`, width: `${widthPct}%`, top: `${topPct}%`, height: `${heightPct}%` };
}

export default function ShortsFlow({
  uploadedAsset,
  source,
  onSourceChange,
  prepJobId,
  onPrepJobId,
}: ShortsFlowProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Picker state
  const [sermons, setSermons] = useState<Job[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  // Transcription state
  const [prepMessage, setPrepMessage] = useState('');
  const [prepError, setPrepError] = useState<string | null>(null);

  // Editor state
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesError, setCuesError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(source?.duration ?? 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const phase: 'picker' | 'needsTranscript' | 'editor' = !source
    ? 'picker'
    : source.transcriptPath
      ? 'editor'
      : 'needsTranscript';

  const videoSourceUrl = useMemo(() => (source ? getAssetSourceUrl(source.assetId) : ''), [source]);

  // Load recent processed sermons for the picker.
  useEffect(() => {
    if (phase !== 'picker') return;
    let cancelled = false;
    setPickerError(null);
    getJobs()
      .then((jobs) => {
        if (cancelled) return;
        const done = jobs.filter(
          (jb) => jb.status === 'completed' && Boolean(jb.result?.videoPath) && (jb.payload?.kind ?? 'sermon') === 'sermon',
        );
        setSermons(done);
      })
      .catch((err) => {
        if (!cancelled) setPickerError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  // Poll the in-flight transcription; when it finishes, refresh the source so it
  // has a transcriptPath and the editor opens. Resumes cleanly on re-mount
  // because prepJobId lives in App state (and the API is idempotent).
  useEffect(() => {
    if (phase !== 'needsTranscript' || !prepJobId || !source) return;
    let cancelled = false;
    setPrepError(null);
    const assetId = source.assetId;
    (async () => {
      for (let i = 0; i < 1200 && !cancelled; i += 1) {
        const current = await getJob(prepJobId);
        if (current.progress?.message) {
          const pct = current.progress.transcriptProgress;
          setPrepMessage(pct ? `${current.progress.message} (${pct}%)` : current.progress.message);
        }
        if (TERMINAL_STATUSES.includes(current.status)) {
          if (current.status === 'completed') {
            const updated = await getAsset(assetId);
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
  }, [phase, prepJobId, source, onSourceChange, onPrepJobId]);

  // Load transcript cues once the source is transcript-ready.
  useEffect(() => {
    if (phase !== 'editor' || !source) return;
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
  }, [phase, source]);

  // Reset the editor when the underlying source changes (not on transcript refresh).
  useEffect(() => {
    setMoments([]);
    setActiveId(null);
    setCurrentTime(0);
    setCues([]);
    setDuration(source?.duration ?? 0);
  }, [source?.assetId]);

  const activeMoment = moments.find((moment) => moment.id === activeId) ?? null;
  const previewCropX = activeMoment?.cropX ?? 0.5;
  const previewZoom = activeMoment?.zoom ?? 1;

  const clampTime = (value: number) => {
    if (!Number.isFinite(value) || value < 0) return 0;
    if (duration > 0) return Math.min(value, duration);
    return value;
  };

  // The cue currently under the playhead — highlighted and scrolled into view so
  // the transcript follows along as the video plays.
  const cueRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeCueIndex = useMemo(
    () => cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end),
    [cues, currentTime],
  );

  useEffect(() => {
    if (phase !== 'editor' || activeCueIndex < 0) return;
    cueRefs.current[activeCueIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeCueIndex, phase]);

  // Nudge the playhead by a small delta for fine start/end trimming.
  const stepBy = (delta: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = clampTime(videoRef.current.currentTime + delta);
  };

  // ---- Source picker handlers ------------------------------------------------
  const useSermon = async (sermonJob: Job) => {
    setPickerBusy(true);
    setPickerError(null);
    try {
      const derived = await createShortsSourceFromJob(sermonJob.jobId);
      onSourceChange(derived);
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerBusy(false);
    }
  };

  const continueWithUpload = () => {
    if (uploadedAsset) onSourceChange(uploadedAsset);
  };

  const uploadNew = async (file: File) => {
    setPickerBusy(true);
    setPickerError(null);
    try {
      const uploaded = await uploadAsset(file);
      onSourceChange(uploaded);
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerBusy(false);
    }
  };

  const changeSource = () => {
    onSourceChange(null);
    onPrepJobId(null);
    setPrepError(null);
  };

  // ---- Transcription handler -------------------------------------------------
  const startTranscription = async () => {
    if (!source) return;
    setPrepError(null);
    setPrepMessage('Queuing transcription…');
    try {
      const job = await createTranscribeJob(source.assetId);
      onPrepJobId(job.jobId);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- Moment / export handlers ---------------------------------------------
  const updateMoment = (id: string, patch: Partial<Moment>) => {
    setMoments((prev) => prev.map((moment) => (moment.id === id ? { ...moment, ...patch } : moment)));
  };

  const addMoment = (start: number, end: number, title: string) => {
    const id = nextMomentId();
    const safeStart = clampTime(start);
    const safeEnd = clampTime(end > safeStart ? end : safeStart + 15);
    setMoments((prev) => [
      ...prev,
      {
        id,
        title: title || `Short ${prev.length + 1}`,
        start: Number(safeStart.toFixed(3)),
        end: Number(safeEnd.toFixed(3)),
        cropX: 0.5,
        zoom: 1,
        captions: true,
        status: 'idle',
      },
    ]);
    setActiveId(id);
  };

  const addBlankMoment = () => {
    const start = videoRef.current ? videoRef.current.currentTime : currentTime;
    addMoment(start, start + 20, '');
  };

  const removeMoment = (id: string) => {
    setMoments((prev) => prev.filter((moment) => moment.id !== id));
    setActiveId((prev) => (prev === id ? null : prev));
  };

  const setBoundToCurrent = (id: string, bound: 'start' | 'end') => {
    if (!videoRef.current) return;
    const value = Number(clampTime(videoRef.current.currentTime).toFixed(3));
    updateMoment(id, { [bound]: value } as Partial<Moment>);
  };

  const jumpTo = (seconds: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = clampTime(seconds);
  };

  const momentError = (moment: Moment): string | null => {
    if (!Number.isFinite(moment.start) || !Number.isFinite(moment.end)) return 'Start and end must be numbers';
    if (moment.start < 0) return 'Start must be ≥ 0';
    if (moment.end <= moment.start) return 'End must be after start';
    if (duration > 0 && moment.end > duration + 0.001) return 'End is beyond the video length';
    return null;
  };

  const exportMoment = async (id: string) => {
    if (!source) return;
    const moment = moments.find((item) => item.id === id);
    if (!moment) return;

    const validation = momentError(moment);
    if (validation) {
      updateMoment(id, { status: 'failed', message: validation });
      return;
    }

    updateMoment(id, { status: 'processing', message: 'Queued…', result: undefined });

    try {
      const job = await createShortJob({
        assetId: source.assetId,
        startTime: moment.start,
        endTime: moment.end,
        cropX: moment.cropX,
        zoom: moment.zoom,
        captions: moment.captions,
        outputVideoFilename: `${slugify(moment.title)}.mp4`,
      });
      updateMoment(id, { jobId: job.jobId });

      let finished: Job | null = null;
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const current = await getJob(job.jobId);
        if (current.progress?.message) {
          updateMoment(id, { message: current.progress.message });
        }
        if (TERMINAL_STATUSES.includes(current.status)) {
          finished = current;
          break;
        }
        await sleep(1500);
      }

      if (!finished || finished.status !== 'completed') {
        throw new Error(finished?.failureReason || 'Short processing did not complete');
      }

      const result = await getResult(job.jobId);
      updateMoment(id, { status: 'completed', result, message: finished.progress?.message ?? 'Short ready' });
    } catch (err) {
      updateMoment(id, { status: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  };

  // "Export all" (re)exports every short that isn't already mid-export, so the
  // count keeps including shorts you've already processed.
  const exportAll = () => {
    moments
      .filter((moment) => moment.status !== 'processing')
      .forEach((moment) => {
        void exportMoment(moment.id);
      });
  };

  const exportAllCount = moments.filter((m) => m.status !== 'processing').length;

  // ---- Render ---------------------------------------------------------------
  if (phase === 'picker') {
    return (
      <div className="container shorts-page">
        <header className="shorts-header">
          <p className="shorts-eyebrow">Shorts</p>
          <h1 className="shorts-title">Choose a source</h1>
          <p className="shorts-subtitle">Make 9:16 vertical clips from a finished sermon (reuses its transcript) or from a new upload.</p>
        </header>

        {pickerError && <p className="shorts-error">{pickerError}</p>}

        <section className="shorts-source-group">
          <h2 className="shorts-section-title">★ From a processed sermon <span className="shorts-badge">recommended · no re-transcription</span></h2>
          {sermons.length === 0 ? (
            <p className="shorts-hint">No finished sermons yet. Process one in the Editor, or upload a new video below.</p>
          ) : (
            <div className="shorts-source-list">
              {sermons.map((sermon) => {
                const name = sermon.payload?.outputVideoFilename || sermon.payload?.outputAudioFilename || `Sermon ${sermon.jobId.slice(0, 8)}`;
                const hasTranscript = Boolean(sermon.result?.transcriptPath);
                return (
                  <div key={sermon.jobId} className="shorts-source-row">
                    <div className="shorts-source-meta">
                      <span className="shorts-source-name">{name}</span>
                      <span className="shorts-source-sub">
                        {new Date(sermon.createdAt).toLocaleString()} · {hasTranscript ? '✓ transcript' : 'no transcript (will prepare once)'}
                      </span>
                    </div>
                    <button type="button" className="btn" disabled={pickerBusy} onClick={() => useSermon(sermon)}>
                      Use this
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {uploadedAsset && (
          <section className="shorts-source-group">
            <h2 className="shorts-section-title">Continue with current upload</h2>
            <div className="shorts-source-row">
              <div className="shorts-source-meta">
                <span className="shorts-source-name">{uploadedAsset.originalFilename}</span>
                <span className="shorts-source-sub">
                  {uploadedAsset.transcriptPath ? '✓ transcript' : 'no transcript yet — prepared once when you continue'}
                </span>
              </div>
              <button type="button" className="btn" disabled={pickerBusy} onClick={continueWithUpload}>
                Continue
              </button>
            </div>
          </section>
        )}

        <section className="shorts-source-group">
          <h2 className="shorts-section-title">Upload a new video</h2>
          <p className="shorts-hint">Transcribed once here (a few minutes for a full sermon).</p>
          <label className="btn shorts-upload-btn">
            {pickerBusy ? 'Uploading…' : 'Choose file…'}
            <input
              type="file"
              accept="video/*"
              style={{ display: 'none' }}
              disabled={pickerBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadNew(file);
                event.target.value = '';
              }}
            />
          </label>
        </section>
      </div>
    );
  }

  if (phase === 'needsTranscript') {
    return (
      <div className="container shorts-page">
        <header className="shorts-header">
          <p className="shorts-eyebrow">Shorts</p>
          <h1 className="shorts-title">Prepare transcript</h1>
          <p className="shorts-subtitle">Source: {source?.originalFilename}</p>
        </header>

        {prepJobId ? (
          <div className="shorts-prep">
            <p className="shorts-prep-message">{prepMessage || 'Transcribing…'}</p>
            <div className="shorts-spinner" aria-hidden="true" />
            <p className="shorts-hint">This runs once for this source. You can leave this tab — it won't restart.</p>
          </div>
        ) : (
          <div className="shorts-prep">
            {prepError && <p className="shorts-error">{prepError}</p>}
            <p className="shorts-hint">This video has no transcript yet. Preparing one lets you pick moments and burn in captions. It only runs once.</p>
            <div className="shorts-prep-actions">
              <button type="button" className="btn" onClick={startTranscription}>
                {prepError ? 'Retry transcript' : 'Prepare transcript & continue'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={changeSource}>
                Choose a different source
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // phase === 'editor'
  return (
    <div className="container shorts-page">
      <header className="shorts-header">
        <p className="shorts-eyebrow">Shorts</p>
        <div className="shorts-source-header">
          <div>
            <h1 className="shorts-title">Build 9:16 vertical clips</h1>
            <p className="shorts-subtitle">Source: {source?.originalFilename}</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={changeSource}>
            Change source
          </button>
        </div>
      </header>

      {cuesError && <p className="shorts-error">Couldn’t load the transcript: {cuesError}</p>}

      <div className="shorts-layout">
        <section className="shorts-preview-col">
          <div className="shorts-preview">
            <video
              ref={videoRef}
              className="shorts-video"
              controls
              onLoadedMetadata={(event) => {
                const value = event.currentTarget.duration;
                if (Number.isFinite(value) && value > 0) setDuration(value);
              }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            >
              <source src={videoSourceUrl} type={source?.mimeType || 'video/mp4'} />
              Your browser does not support video playback.
            </video>
            <div className="shorts-crop-window" style={cropWindowStyle(previewCropX, previewZoom)} aria-hidden="true">
              <span className="shorts-crop-label">9:16</span>
            </div>
          </div>
          <p className="shorts-playhead">
            Playhead: <strong>{formatTimecode(currentTime)}</strong>
            {duration > 0 ? ` / ${formatTimecode(duration)}` : ''}
            {activeMoment ? ` · Framing “${activeMoment.title}”` : ' · Select a short to frame it'}
          </p>
          <div className="shorts-stepper" role="group" aria-label="Fine seek">
            <button type="button" className="btn btn-secondary" onClick={() => stepBy(-1)} title="Back 1 second">⏪ 1s</button>
            <button type="button" className="btn btn-secondary" onClick={() => stepBy(-0.1)} title="Back 0.1 second">◀ 0.1s</button>
            <button type="button" className="btn btn-secondary" onClick={() => stepBy(0.1)} title="Forward 0.1 second">0.1s ▶</button>
            <button type="button" className="btn btn-secondary" onClick={() => stepBy(1)} title="Forward 1 second">1s ⏩</button>
          </div>
          <button type="button" className="btn add-clip" onClick={addBlankMoment}>
            Add another short
          </button>
        </section>

        <section className="shorts-transcript-col">
          <h2 className="shorts-section-title">Transcript</h2>
          {cues.length === 0 ? (
            <p className="shorts-hint">No transcript cues were found for this source.</p>
          ) : (
            <div className="shorts-transcript" role="list">
              {cues.map((cue, index) => (
                <button
                  key={`cue-${index}`}
                  type="button"
                  role="listitem"
                  ref={(el) => { cueRefs.current[index] = el; }}
                  className={`shorts-cue${index === activeCueIndex ? ' active' : ''}`}
                  onClick={() => jumpTo(cue.start)}
                  title="Jump the video to this point"
                >
                  <span className="shorts-cue-time">{formatTimecode(cue.start)}</span>
                  <span className="shorts-cue-text">{cue.text || '…'}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="shorts-moments">
        <div className="shorts-moments-head">
          <h2 className="shorts-section-title">Shorts ({moments.length})</h2>
          {moments.length > 0 && (
            <button type="button" className="btn" onClick={exportAll} disabled={exportAllCount === 0}>
              Export all shorts ({exportAllCount})
            </button>
          )}
        </div>

        {moments.length === 0 ? (
          <p className="shorts-hint">
            Click a transcript line to jump the video there, then use “Add another short” to capture a moment.
          </p>
        ) : (
          <div className="shorts-moment-grid">
            {moments.map((moment) => {
              const error = moment.status !== 'completed' ? momentError(moment) : null;
              const isActive = moment.id === activeId;
              return (
                <article
                  key={moment.id}
                  className={`results-card shorts-moment${isActive ? ' active' : ''}`}
                  onClick={() => setActiveId(moment.id)}
                >
                  <div className="results-card-head">
                    <input
                      className="shorts-moment-title"
                      type="text"
                      value={moment.title}
                      onChange={(event) => updateMoment(moment.id, { title: event.target.value })}
                      onFocus={() => setActiveId(moment.id)}
                      aria-label="Short title"
                    />
                    <button
                      type="button"
                      className="btn remove-clip"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeMoment(moment.id);
                      }}
                    >
                      Remove
                    </button>
                  </div>

                  <div className="shorts-range">
                    <label>
                      Start
                      <input
                        type="text"
                        value={moment.start.toFixed(3)}
                        onChange={(event) => updateMoment(moment.id, { start: Number.parseFloat(event.target.value) })}
                      />
                    </label>
                    <button type="button" className="btn set-start-time" onClick={() => setBoundToCurrent(moment.id, 'start')}>
                      Set
                    </button>
                    <button type="button" className="btn" onClick={() => jumpTo(moment.start)}>
                      Jump
                    </button>
                  </div>

                  <div className="shorts-range">
                    <label>
                      End
                      <input
                        type="text"
                        value={moment.end.toFixed(3)}
                        onChange={(event) => updateMoment(moment.id, { end: Number.parseFloat(event.target.value) })}
                      />
                    </label>
                    <button type="button" className="btn set-end-time" onClick={() => setBoundToCurrent(moment.id, 'end')}>
                      Set
                    </button>
                    <button type="button" className="btn" onClick={() => jumpTo(moment.end)}>
                      Jump
                    </button>
                  </div>

                  <label className="shorts-slider">
                    <span>Horizontal position</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={moment.cropX}
                      onChange={(event) => updateMoment(moment.id, { cropX: Number.parseFloat(event.target.value) })}
                    />
                  </label>

                  <label className="shorts-slider">
                    <span>Zoom ({moment.zoom.toFixed(2)}× {moment.zoom < 1 ? '— zoomed out, black bars' : ''})</span>
                    <input
                      type="range"
                      min={MIN_ZOOM}
                      max={MAX_ZOOM}
                      step={0.05}
                      value={moment.zoom}
                      onChange={(event) => updateMoment(moment.id, { zoom: Number.parseFloat(event.target.value) })}
                    />
                  </label>

                  <label className="shorts-toggle">
                    <input
                      type="checkbox"
                      checked={moment.captions}
                      onChange={(event) => updateMoment(moment.id, { captions: event.target.checked })}
                    />
                    Burn in captions
                  </label>

                  {error && <p className="shorts-error">{error}</p>}

                  {moment.status === 'processing' && (
                    <p className="results-pending-copy">{moment.message || 'Processing…'}</p>
                  )}

                  {moment.status === 'failed' && moment.message && !error && (
                    <p className="shorts-error">{moment.message}</p>
                  )}

                  {moment.status === 'completed' && moment.result?.videoPath && (
                    <>
                      <video controls className="results-video-player shorts-result-player">
                        <source src={getResultArtifact(moment.result.resultId, 'video')} type="video/mp4" />
                      </video>
                      <a
                        href={getResultArtifact(moment.result.resultId, 'video')}
                        download={`${slugify(moment.title)}.mp4`}
                        className="btn results-download-btn"
                      >
                        Download Short
                      </a>
                      {moment.message && <p className="results-pending-copy">{moment.message}</p>}
                    </>
                  )}

                  {moment.status === 'idle' || moment.status === 'failed' ? (
                    <button
                      type="button"
                      className="btn results-download-btn"
                      disabled={Boolean(error)}
                      onClick={(event) => {
                        event.stopPropagation();
                        void exportMoment(moment.id);
                      }}
                    >
                      {moment.status === 'failed' ? 'Retry export' : 'Export this short'}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
