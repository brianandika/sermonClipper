import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Asset, Job, Result } from '../types';
import {
  createShortJob,
  createTranscribeJob,
  getAsset,
  getAssetSourceUrl,
  getAssetTranscriptText,
  getJob,
  getResult,
  getResultArtifact,
} from '../api';

interface ShortsFlowProps {
  asset: Asset;
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

type PrepPhase = 'preparing' | 'ready' | 'error';

// A full-height 9:16 window spans (9/16) / (16/9) = 81/256 of a 16:9 frame's
// width. Must match computeShortCrop / buildShortVideoFilter in the worker so
// the CSS preview matches the encoded output.
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

function cropWindowStyle(cropX: number, zoom: number): CSSProperties {
  const widthPct = (WINDOW_FRACTION / Math.max(1, zoom)) * 100;
  const leftPct = cropX * (100 - widthPct);
  return { left: `${leftPct}%`, width: `${widthPct}%` };
}

export default function ShortsFlow({ asset }: ShortsFlowProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoSourceUrl = useMemo(() => getAssetSourceUrl(asset.assetId), [asset.assetId]);

  const [phase, setPhase] = useState<PrepPhase>('preparing');
  const [prepMessage, setPrepMessage] = useState('Checking for a transcript…');
  const [prepError, setPrepError] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);

  const [duration, setDuration] = useState<number>(asset.duration ?? 0);
  const [currentTime, setCurrentTime] = useState(0);

  const [moments, setMoments] = useState<Moment[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Prepare the transcript once on entry: transcribe the source on demand if it
  // has no transcript yet, then load the VTT cues for moment-picking.
  useEffect(() => {
    let cancelled = false;

    const prepare = async () => {
      try {
        setPhase('preparing');
        setPrepError(null);
        setPrepMessage('Checking for a transcript…');

        const fresh = await getAsset(asset.assetId);
        if (fresh.duration && !duration) {
          setDuration(fresh.duration);
        }

        if (!fresh.transcriptPath) {
          setPrepMessage('Transcribing the source video… this runs once per upload.');
          const job = await createTranscribeJob(asset.assetId);

          for (let attempt = 0; attempt < 1200; attempt += 1) {
            if (cancelled) return;
            const current = await getJob(job.jobId);
            if (current.progress?.message) {
              const pct = current.progress.transcriptProgress;
              setPrepMessage(pct ? `${current.progress.message} (${pct}%)` : current.progress.message);
            }
            if (TERMINAL_STATUSES.includes(current.status)) {
              if (current.status !== 'completed') {
                throw new Error(current.failureReason || 'Transcription failed');
              }
              break;
            }
            await sleep(1500);
          }
        }

        const vtt = await getAssetTranscriptText(asset.assetId);
        if (cancelled) return;
        setCues(parseVtt(vtt));
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setPrepError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    };

    prepare();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.assetId]);

  const activeMoment = moments.find((moment) => moment.id === activeId) ?? null;
  const previewCropX = activeMoment?.cropX ?? 0.5;
  const previewZoom = activeMoment?.zoom ?? 1;

  const clampTime = (value: number) => {
    if (!Number.isFinite(value) || value < 0) return 0;
    if (duration > 0) return Math.min(value, duration);
    return value;
  };

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

  const addMomentFromCue = (cue: Cue) => {
    const title = cue.text.split(/\s+/).slice(0, 6).join(' ');
    addMoment(cue.start, cue.end, title);
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
        assetId: asset.assetId,
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

  const exportAll = () => {
    moments
      .filter((moment) => moment.status === 'idle' || moment.status === 'failed')
      .forEach((moment) => {
        void exportMoment(moment.id);
      });
  };

  const exportableCount = moments.filter((m) => m.status === 'idle' || m.status === 'failed').length;

  if (phase === 'preparing') {
    return (
      <div className="container">
        <div className="shorts-prep">
          <h1 className="shorts-title">Preparing Shorts</h1>
          <p className="shorts-prep-message">{prepMessage}</p>
          <div className="shorts-spinner" aria-hidden="true" />
          <p className="shorts-hint">
            We transcribe the uploaded video so you can pick moments and burn in captions. This can take a few minutes
            for a long sermon; you only pay this cost once per upload.
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="container">
        <div className="shorts-prep">
          <h1 className="shorts-title">Shorts unavailable</h1>
          <p className="shorts-error">{prepError}</p>
          <p className="shorts-hint">
            A transcript is required to build shorts. Confirm the worker has transcription enabled, then revisit this
            tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container shorts-page">
      <header className="shorts-header">
        <p className="shorts-eyebrow">Shorts</p>
        <h1 className="shorts-title">Build 9:16 vertical clips</h1>
        <p className="shorts-subtitle">
          Read the transcript, pick moments, frame each 9:16 window, and export burned-in-caption shorts. Each short is
          its own MP4.
        </p>
      </header>

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
              <source src={videoSourceUrl} type={asset.mimeType || 'video/mp4'} />
              Your browser does not support video playback.
            </video>
            <div className="shorts-crop-window" style={cropWindowStyle(previewCropX, previewZoom)} aria-hidden="true">
              <span className="shorts-crop-label">9:16</span>
            </div>
          </div>
          <p className="shorts-playhead">
            Playhead: <strong>{formatTimecode(currentTime)}</strong>
            {duration > 0 ? ` / ${formatTimecode(duration)}` : ''}
            {activeMoment ? ` · Framing “${activeMoment.title}”` : ' · Select a moment to frame it'}
          </p>
          <button type="button" className="btn add-clip" onClick={addBlankMoment}>
            Add moment at playhead
          </button>
        </section>

        <section className="shorts-transcript-col">
          <h2 className="shorts-section-title">Transcript</h2>
          {cues.length === 0 ? (
            <p className="shorts-hint">No transcript cues were found for this video.</p>
          ) : (
            <div className="shorts-transcript" role="list">
              {cues.map((cue, index) => (
                <button
                  key={`cue-${index}`}
                  type="button"
                  role="listitem"
                  className="shorts-cue"
                  onClick={() => addMomentFromCue(cue)}
                  title="Add this moment"
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
          <h2 className="shorts-section-title">Moments ({moments.length})</h2>
          {moments.length > 0 && (
            <button type="button" className="btn" onClick={exportAll} disabled={exportableCount === 0}>
              Export {exportableCount > 0 ? `${exportableCount} ` : ''}short{exportableCount === 1 ? '' : 's'}
            </button>
          )}
        </div>

        {moments.length === 0 ? (
          <p className="shorts-hint">
            Click a transcript line, or use “Add moment at playhead”, to create your first short.
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
                        onChange={(event) =>
                          updateMoment(moment.id, { start: Number.parseFloat(event.target.value) })
                        }
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
                    <span>Zoom ({moment.zoom.toFixed(2)}×)</span>
                    <input
                      type="range"
                      min={1}
                      max={2.5}
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
