import { useEffect, useMemo, useRef, useState } from 'react';
import { CaptionFormat, EditableTranscriptCue, Job, SubtitlesDraft } from '../types';
import { formatMinSec, parseMinSec } from '../timeFormat';
import {
  createBurnSubtitlesJob,
  createRetryTranscriptJob,
  getJob,
  getResult,
  getResultArtifact,
  getResultTranscriptText,
} from '../api';
import SubtitleTimeline from './SubtitleTimeline';

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

// Shared by both the numeric Start/End inputs and the timeline drag handles,
// so a cue can never invert or run past what's actually known about the
// video. `durationHint` is Infinity until the video's own duration is known
// (a brief window before onLoadedMetadata fires) so early edits aren't
// wrongly clamped to 0.
const MIN_CUE_DURATION = 0.1;
function clampCueTimes(start: number, end: number, durationHint: number): { start: number; end: number } {
  const safeDuration = durationHint > 0 ? durationHint : Number.POSITIVE_INFINITY;
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, safeDuration - MIN_CUE_DURATION));
  const e = Math.max(s + MIN_CUE_DURATION, Math.min(Number.isFinite(end) ? end : s + MIN_CUE_DURATION, safeDuration));
  return { start: s, end: e };
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

  // Playback state for the timeline: currentTime/isPlaying come from the
  // <video> element itself; videoDuration falls back to the job's own
  // measured output duration until metadata loads (usually instant, since
  // it's a same-origin file).
  const videoRef = useRef<HTMLVideoElement>(null);
  const cueRowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoDuration, setVideoDuration] = useState(sourceJob.result?.duration ?? 0);
  // The cue last clicked (in the timeline or the transcript list) — kept in
  // sync both ways, and used to bring that block to the front of the
  // timeline (see SubtitleTimeline's .selected z-index) so trimming it never
  // has an edge hidden behind a neighbor it's been dragged to overlap.
  const [selectedCueIndex, setSelectedCueIndex] = useState<number | null>(null);

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

  // Shared commit path for both the numeric Start/End inputs and the timeline
  // drag handles — always clamps against the video's own duration so a cue
  // can never invert or run past the end of the video.
  const updateCueTime = (index: number, patch: { start?: number; end?: number }) => {
    onDraftChange({
      cues: draft.cues.map((cue, i) => {
        if (i !== index) return cue;
        const { start, end } = clampCueTimes(patch.start ?? cue.start, patch.end ?? cue.end, videoDuration);
        return { ...cue, start, end };
      }),
    });
  };

  const seekTo = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, time);
    }
  };

  // Selecting a cue (from either the timeline or the transcript list) marks
  // it in both places: the timeline brings it to front, the list scrolls it
  // into view.
  const selectCue = (index: number) => {
    setSelectedCueIndex(index);
    cueRowRefs.current[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const activeCueIndex = useMemo(
    () => draft.cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end),
    [draft.cues, currentTime],
  );

  useEffect(() => {
    if (activeCueIndex < 0) return;
    cueRowRefs.current[activeCueIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeCueIndex]);

  const handleBurn = async () => {
    if (draft.cues.length === 0) return;
    const isSrt = draft.captionFormat === 'srt';
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
        captionFormat: draft.captionFormat,
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
        throw new Error(finished?.failureReason || (isSrt ? 'Exporting the .srt did not complete' : 'Burning in subtitles did not complete'));
      }
      setBurnedJob(finished);
    } catch (err) {
      setBurnError(err instanceof Error ? err.message : String(err));
    } finally {
      setBurning(false);
    }
  };

  const sourceVideoUrl = sourceJob.result ? getResultArtifact(sourceJob.result.resultId, 'video') : null;
  const burnedVideoUrl = burnedJob?.result?.videoPath ? getResultArtifact(burnedJob.result.resultId, 'video') : null;
  const burnedSrtUrl = burnedJob?.result?.srtPath ? getResultArtifact(burnedJob.result.resultId, 'srt') : null;

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
        <h1 className="shorts-title">Review transcript & export subtitles</h1>
        <p className="shorts-subtitle">Source job: {sourceJob.jobId.slice(0, 8)}</p>
      </header>

      {sourceVideoUrl && (
        <div className="subtitle-preview-video-wrap" style={{ marginBottom: '1.25rem' }}>
          <video
            ref={videoRef}
            controls
            className="shorts-video"
            src={sourceVideoUrl}
            onLoadedMetadata={(event) => {
              const value = event.currentTarget.duration;
              if (Number.isFinite(value) && value > 0) setVideoDuration(value);
            }}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          >
            Your browser doesn't support video playback.
          </video>
          {/* Live WYSIWYG-ish preview of the ACTIVE (possibly edited) cue, so
              dragging a boundary on the timeline shows immediately where the
              caption will actually appear/disappear against the picture —
              not just against the transcript list's numbers. */}
          {activeCueIndex >= 0 && draft.cues[activeCueIndex]?.text && (
            <div className="subtitle-preview-overlay">{draft.cues[activeCueIndex].text}</div>
          )}
        </div>
      )}

      {draft.cues.length > 0 && (
        <SubtitleTimeline
          cues={draft.cues}
          duration={videoDuration}
          currentTime={currentTime}
          isPlaying={isPlaying}
          activeCueIndex={activeCueIndex}
          selectedCueIndex={selectedCueIndex}
          onSeek={seekTo}
          onSelectCue={selectCue}
          onCueTimeChange={(index, start, end) => updateCueTime(index, { start, end })}
        />
      )}

      <section className="shorts-transcript-editor">
        <div className="shorts-transcript-editor-head">
          <h2 className="shorts-section-title">Transcript</h2>
        </div>
        <p className="shorts-hint">Fix typos, adjust times, delete lines you don't want captioned, then choose an output below.</p>
        {draft.cues.length === 0 ? (
          <p className="shorts-hint">No transcript cues were found for this video.</p>
        ) : (
          <div className="shorts-transcript-edit-list">
            {draft.cues.map((cue, index) => (
              <div
                key={`cue-${index}`}
                ref={(el) => { cueRowRefs.current[index] = el; }}
                className={`shorts-transcript-edit-row${index === activeCueIndex ? ' active' : ''}`}
                onClick={() => setSelectedCueIndex(index)}
              >
                <button
                  type="button"
                  className="shorts-cue-time shorts-cue-time-btn"
                  title="Jump to this cue"
                  onClick={() => seekTo(cue.start)}
                >
                  {formatTimecode(cue.start)}
                </button>
                <input
                  className="shorts-transcript-edit-time"
                  type="text"
                  value={formatMinSec(cue.start)}
                  placeholder="m:ss.mmm"
                  aria-label={`Start time for cue at ${formatTimecode(cue.start)}`}
                  onChange={(event) => {
                    const parsed = parseMinSec(event.target.value);
                    if (parsed !== null) updateCueTime(index, { start: parsed });
                  }}
                />
                <span className="shorts-transcript-edit-time-sep">–</span>
                <input
                  className="shorts-transcript-edit-time"
                  type="text"
                  value={formatMinSec(cue.end)}
                  placeholder="m:ss.mmm"
                  aria-label={`End time for cue at ${formatTimecode(cue.start)}`}
                  onChange={(event) => {
                    const parsed = parseMinSec(event.target.value);
                    if (parsed !== null) updateCueTime(index, { end: parsed });
                  }}
                />
                <input
                  className="shorts-transcript-edit-input"
                  type="text"
                  value={cue.text}
                  onChange={(event) => updateCueText(index, event.target.value)}
                  aria-label={`Cue text at ${formatTimecode(cue.start)}`}
                />
                <button type="button" className="btn remove-clip" title="Delete this cue" onClick={() => removeCue(index)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="shorts-transcript-editor" style={{ marginTop: '1.25rem' }}>
        <h2 className="shorts-section-title">Output</h2>
        <div className="shorts-caption-format-choice" role="radiogroup" aria-label="Subtitle output format">
          <label className="shorts-toggle">
            <input
              type="radio"
              name="captionFormat"
              checked={draft.captionFormat === 'burned'}
              onChange={() => onDraftChange({ captionFormat: 'burned' as CaptionFormat })}
            />
            Burn into video
          </label>
          <label className="shorts-toggle">
            <input
              type="radio"
              name="captionFormat"
              checked={draft.captionFormat === 'srt'}
              onChange={() => onDraftChange({ captionFormat: 'srt' as CaptionFormat })}
            />
            Export as .srt file
          </label>
        </div>
        <p className="shorts-hint">
          {draft.captionFormat === 'srt'
            ? "Downloads a .srt subtitle file — the video itself isn't touched."
            : 'Burns the captions permanently into a new copy of the video.'}
        </p>
      </section>

      {burnError && <p className="shorts-error">{burnError}</p>}

      <div className="shorts-prep-actions" style={{ marginTop: '1.25rem' }}>
        <button type="button" className="btn" disabled={burning || draft.cues.length === 0} onClick={handleBurn}>
          {burning
            ? (draft.captionFormat === 'srt' ? 'Exporting SRT…' : 'Burning in subtitles…')
            : (draft.captionFormat === 'srt' ? 'Export SRT' : 'Burn in Subtitles')}
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

      {burnedJob && burnedSrtUrl && (
        <section className="shorts-transcript-editor" style={{ marginTop: '1.25rem' }}>
          <h2 className="shorts-section-title">Subtitles ready</h2>
          <p className="shorts-hint">The video itself wasn't changed — here's your .srt file.</p>
          <a href={burnedSrtUrl} download="subtitles.srt" className="btn results-download-btn" style={{ marginTop: '0.75rem', display: 'inline-block' }}>
            Download .srt
          </a>
        </section>
      )}
    </div>
  );
}
