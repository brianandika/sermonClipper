import { useEffect, useMemo, useRef, useState } from 'react';
// Imported by relative path straight to the TypeScript source, not through
// the built @sermon-clipper/shared package. tsc compiles that package to
// CommonJS, and neither its barrel's re-exports nor even the leaf module's
// own plain exports resolve reliably through Vite/Rollup's static analysis
// of a symlinked npm-workspace package in production builds (confirmed by
// trial — both "@sermon-clipper/shared" and "@sermon-clipper/shared/captionText"
// fail with "is not exported by ..." despite Node's require() resolving both
// fine, and despite the leaf module using plain, statically-visible
// `exports.x = ...` assignments). Importing the .ts source directly sidesteps
// the whole CJS interop question: esbuild/Rollup just transpile it like any
// other same-repo module, no package resolution involved.
import { CAPTION_PREFERRED_LINES, chunkCaptions, LANDSCAPE_CAPTION_MAX_CHARS_PER_LINE, normalizeCaptionText } from '../../../../packages/shared/src/captionText';
import { CaptionFormat, EditableTranscriptCue, Job, SubtitlesDraft } from '../types';
import { formatMinSec, parseMinSec } from '../timeFormat';
import {
  canRedoCues,
  canUndoCues,
  clampCueTimes,
  emptyCueHistory,
  getHistoryShortcut,
  insertCueAfter,
  insertCueAtTime,
  isFocusVisibleTarget,
  prepareExportCues,
  shouldLeaveSpaceToTarget,
  type CueCommitOptions,
  type InsertResult,
} from '../subtitleEditing';
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
  // Every edit to the cue list goes through here (not onDraftChange) so it
  // lands in the undo history; the updater runs against the latest cues.
  onCuesChange: (
    updater: (cues: EditableTranscriptCue[]) => EditableTranscriptCue[],
    options?: CueCommitOptions,
  ) => void;
  onUndo: () => void;
  onRedo: () => void;
}

// Mac uses Cmd for undo/redo, everything else Ctrl — matches getHistoryShortcut.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
const UNDO_HINT = IS_MAC ? '⌘Z' : 'Ctrl+Z';
const REDO_HINT = IS_MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z';

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

export default function SubtitlesFlow({ sourceJob, draft, onDraftChange, onCuesChange, onUndo, onRedo }: SubtitlesFlowProps) {
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
  // Row to focus once it has rendered (set when a new line is inserted).
  const pendingFocusIndexRef = useRef<number | null>(null);
  // Keyboard-handling state: see the keydown effect below.
  const keyDownHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const keyUpHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const spaceHijackedRef = useRef(false);
  const pointerHeldRef = useRef(false);
  // Whether the currently focused element got focus via the keyboard, recorded
  // at focus time (see isFocusVisibleTarget for why it can't be checked later).
  const focusedViaKeyboardRef = useRef(false);
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
        if (!cancelled) onDraftChange({ cues: parseVtt(text), cuesLoaded: true, ...emptyCueHistory() });
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
            if (!cancelled) onDraftChange({ cues: parseVtt(text), cuesLoaded: true, prepJobId: null, ...emptyCueHistory() });
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

  // All cue edits below hand `onCuesChange` a pure updater that returns the
  // SAME array when nothing actually changed, so a no-op never becomes an undo
  // step. Keyed edits (typing) share one undo step per burst.
  const updateCueText = (index: number, text: string) => {
    onCuesChange(
      (cues) => (cues[index] && cues[index].text !== text
        ? cues.map((cue, i) => (i === index ? { ...cue, text } : cue))
        : cues),
      { coalesceKey: `text:${index}` },
    );
  };

  const removeCue = (index: number) => {
    onCuesChange((cues) => cues.filter((_, i) => i !== index));
    // Keep the selection on the same cue as the list shifts up under it.
    setSelectedCueIndex((selected) => {
      if (selected === null || selected === index) return null;
      return selected > index ? selected - 1 : selected;
    });
  };

  // Shared commit path for both the numeric Start/End inputs and the timeline
  // drag handles — always clamps against the video's own duration so a cue
  // can never invert or run past the end of the video.
  const updateCueTime = (index: number, patch: { start?: number; end?: number }, options?: CueCommitOptions) => {
    onCuesChange((cues) => {
      const cue = cues[index];
      if (!cue) return cues;
      const { start, end } = clampCueTimes(patch.start ?? cue.start, patch.end ?? cue.end, videoDuration);
      if (Math.abs(start - cue.start) < 1e-9 && Math.abs(end - cue.end) < 1e-9) return cues;
      return cues.map((c, i) => (i === index ? { ...c, start, end } : c));
    }, options);
  };

  const seekTo = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, time);
    }
  };

  // Adds a new, empty line: commits it, selects it, jumps the video to it, and
  // (via pendingFocusIndexRef, consumed after the row renders) puts the cursor
  // in its text box ready to type.
  const commitInsert = (result: InsertResult) => {
    onCuesChange(() => result.cues);
    setSelectedCueIndex(result.index);
    pendingFocusIndexRef.current = result.index;
    seekTo(result.cues[result.index].start);
  };
  const insertLineAfter = (index: number) => commitInsert(insertCueAfter(draft.cues, index, videoDuration));
  const insertLineAtPlayhead = () => commitInsert(insertCueAtTime(draft.cues, currentTime, videoDuration));

  // Stepping through history clears the selection: the index it pointed at may
  // now be a different line (or gone) after an insert/delete is undone.
  const undoEdit = () => {
    setSelectedCueIndex(null);
    onUndo();
  };
  const redoEdit = () => {
    setSelectedCueIndex(null);
    onRedo();
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

  // The lines actually shown right now, computed with the SAME wrap/chunk
  // functions the real landscape burn-in uses (see the worker's
  // buildAssFromVtt + landscapeCaptionStyle) — not the browser's own text
  // wrapping — so this preview's line breaks (and, for a long cue split into
  // several on-screen chunks, which chunk is showing right now) match the
  // burned-in result exactly rather than just approximately.
  const previewLines = useMemo(() => {
    const cue = activeCueIndex >= 0 ? draft.cues[activeCueIndex] : null;
    if (!cue || !cue.text.trim()) return [];
    // preferredLines and maxLines both = CAPTION_PREFERRED_LINES (2), matching
    // landscapeCaptionStyle's strict cap in the worker — never a 3-line caption.
    const chunks = chunkCaptions(
      normalizeCaptionText(cue.text, false),
      LANDSCAPE_CAPTION_MAX_CHARS_PER_LINE,
      CAPTION_PREFERRED_LINES,
      CAPTION_PREFERRED_LINES,
    );
    if (chunks.length === 0) return [];
    const cueDuration = cue.end - cue.start;
    const perChunk = cueDuration / chunks.length;
    const elapsed = Math.max(0, currentTime - cue.start);
    const chunkIndex = perChunk > 0 ? Math.min(chunks.length - 1, Math.floor(elapsed / perChunk)) : 0;
    return chunks[chunkIndex].split('\\N');
  }, [draft.cues, activeCueIndex, currentTime]);

  // While the video plays, keep the active line visible by scrolling ONLY the
  // transcript list's own scroller. (scrollIntoView would scroll the whole
  // page too, yanking the video and timeline out of view the moment the next
  // line becomes active.) Explicit actions — clicking a block, inserting a
  // line — still use scrollIntoView, since there the page should follow.
  useEffect(() => {
    if (activeCueIndex < 0) return;
    const row = cueRowRefs.current[activeCueIndex];
    const list = row?.parentElement;
    if (!row || !list) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollBy({ top: rowRect.top - listRect.top - 4, behavior: 'smooth' });
    }
    else if (rowRect.bottom > listRect.bottom) {
      list.scrollBy({ top: rowRect.bottom - listRect.bottom + 4, behavior: 'smooth' });
    }
  }, [activeCueIndex]);

  // After inserting a line, focus its text box and scroll it into view as soon
  // as its row exists. Runs after every render but is a no-op unless an insert
  // is pending.
  useEffect(() => {
    const index = pendingFocusIndexRef.current;
    if (index === null) return;
    const row = cueRowRefs.current[index];
    if (!row || index >= draft.cues.length) return;
    pendingFocusIndexRef.current = null;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.querySelector<HTMLInputElement>('input.shorts-transcript-edit-input')?.focus({ preventScroll: true });
  });

  // Undo/redo (or deleting) can shrink the list under the selection.
  useEffect(() => {
    setSelectedCueIndex((selected) => (selected !== null && selected >= draft.cues.length ? null : selected));
  }, [draft.cues.length]);

  // Keyboard shortcuts for the editor. One window listener, attached once;
  // the handlers live in refs reassigned every render so they always see the
  // latest props/state (a handler captured at mount would act on stale cues).
  //  - Space plays/pauses the main video instead of scrolling the page — unless
  //    the focused element wants Space itself (typing in a field, a
  //    keyboard-focused button, the native video controls).
  //  - Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z redoes, everywhere in the editor
  //    (including inside the cue text boxes, where the browser's own per-field
  //    undo would otherwise fight the app's single history).
  keyDownHandlerRef.current = (event) => {
    if (event.defaultPrevented || event.isComposing || !draft.cuesLoaded) return;

    const shortcut = getHistoryShortcut(event, IS_MAC);
    if (shortcut) {
      // A mouse drag in progress holds onto the cue it started on; undoing
      // under it would apply the drag to whatever ends up at that index.
      if (pointerHeldRef.current) return;
      event.preventDefault();
      if (shortcut === 'undo') undoEdit();
      else redoEdit();
      return;
    }

    if (event.code === 'Space' || event.key === ' ') {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const video = videoRef.current;
      if (!video || shouldLeaveSpaceToTarget(event.target as HTMLElement | null, focusedViaKeyboardRef.current)) return;
      // Stop the page scroll — also for auto-repeat, which must not toggle
      // again (holding Space would otherwise flicker play/pause).
      event.preventDefault();
      spaceHijackedRef.current = true;
      if (event.repeat) return;
      if (video.paused) void video.play().catch(() => {});
      else video.pause();
    }
  };
  keyUpHandlerRef.current = (event) => {
    // A button activates on Space *keyup*; swallow the one that belongs to a
    // Space press we already used for play/pause.
    if ((event.code === 'Space' || event.key === ' ') && spaceHijackedRef.current) {
      spaceHijackedRef.current = false;
      event.preventDefault();
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyDownHandlerRef.current(event);
    const onKeyUp = (event: KeyboardEvent) => keyUpHandlerRef.current(event);
    const onPointerDown = () => { pointerHeldRef.current = true; };
    const onPointerEnd = () => { pointerHeldRef.current = false; };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) focusedViaKeyboardRef.current = isFocusVisibleTarget(event.target);
    };
    // Losing window focus can swallow the keyup/pointerup we'd reset on.
    const onWindowBlur = () => {
      pointerHeldRef.current = false;
      spaceHijackedRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);

  // What actually gets exported: blank placeholder lines dropped, the rest in
  // chronological order (see prepareExportCues).
  const exportCues = useMemo(() => prepareExportCues(draft.cues), [draft.cues]);
  const blankLineCount = draft.cues.length - draft.cues.filter((cue) => cue.text.trim() !== '').length;

  const handleBurn = async () => {
    if (exportCues.length === 0) return;
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
        captionsVtt: buildVttText(exportCues),
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
          {/* Live preview of the ACTIVE (possibly edited) cue, wrapped with the
              exact same function the real landscape burn-in uses — so dragging
              a boundary on the timeline shows immediately both WHEN a caption
              will appear/disappear and how its lines will actually break. */}
          {previewLines.length > 0 && (
            <div className="subtitle-preview-overlay">
              {previewLines.map((line, i) => <div key={i}>{line}</div>)}
            </div>
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
          <div className="subtitle-editor-toolbar">
            <button
              type="button"
              className="btn btn-secondary subtitle-toolbar-btn"
              onClick={undoEdit}
              disabled={!canUndoCues(draft)}
              title={`Undo (${UNDO_HINT})`}
            >
              ↶ Undo
            </button>
            <button
              type="button"
              className="btn btn-secondary subtitle-toolbar-btn"
              onClick={redoEdit}
              disabled={!canRedoCues(draft)}
              title={`Redo (${REDO_HINT})`}
            >
              ↷ Redo
            </button>
            <button
              type="button"
              className="btn subtitle-toolbar-btn"
              onClick={insertLineAtPlayhead}
              title="Add a new line at the playhead (or right after the line the playhead is on)"
            >
              ＋ Add line
            </button>
          </div>
        </div>
        <p className="shorts-hint">
          Fix typos, adjust times, add or delete lines, then choose an output below.
          {' '}Space plays/pauses · {UNDO_HINT} undo · {REDO_HINT} redo.
        </p>
        {draft.cues.length === 0 ? (
          <p className="shorts-hint">No lines yet — use “Add line” to create one at the playhead.</p>
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
                    if (parsed !== null) updateCueTime(index, { start: parsed }, { coalesceKey: `start:${index}` });
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
                    if (parsed !== null) updateCueTime(index, { end: parsed }, { coalesceKey: `end:${index}` });
                  }}
                />
                <input
                  className="shorts-transcript-edit-input"
                  type="text"
                  value={cue.text}
                  placeholder="Type the caption…"
                  onChange={(event) => updateCueText(index, event.target.value)}
                  aria-label={`Cue text at ${formatTimecode(cue.start)}`}
                />
                {/* stopPropagation: the row's own onClick selects the row, which
                    would otherwise override the selection these buttons set. */}
                <button
                  type="button"
                  className="btn subtitle-row-btn"
                  title="Add a new line after this one"
                  aria-label={`Add a line after the cue at ${formatTimecode(cue.start)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    insertLineAfter(index);
                  }}
                >
                  ＋
                </button>
                <button
                  type="button"
                  className="btn remove-clip"
                  title="Delete this cue"
                  aria-label={`Delete the cue at ${formatTimecode(cue.start)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeCue(index);
                  }}
                >
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

      {blankLineCount > 0 && (
        <p className="shorts-hint" style={{ textAlign: 'center' }}>
          {exportCues.length === 0
            ? 'Type some text into at least one line to export.'
            : `${blankLineCount} empty line${blankLineCount === 1 ? '' : 's'} won't be included in the export.`}
        </p>
      )}

      <div className="shorts-prep-actions" style={{ marginTop: '1.25rem' }}>
        <button type="button" className="btn" disabled={burning || exportCues.length === 0} onClick={handleBurn}>
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
