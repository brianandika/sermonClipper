import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { EditableTranscriptCue } from '../types';

interface SubtitleTimelineProps {
  cues: EditableTranscriptCue[];
  // Total video duration in seconds. The timeline renders nothing until this
  // is known (a positive number) — see SubtitlesFlow's guard.
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  activeCueIndex: number;
  onSeek: (time: number) => void;
  onSelectCue: (index: number) => void;
  // Committed only on drag release (not on every pointermove) — see the
  // module doc comment below for why.
  onCueTimeChange: (index: number, start: number, end: number) => void;
}

// A caption track, similar in spirit to Premiere Pro's Text-based editing
// captions strip: a horizontal ruler + a row of draggable/resizable blocks,
// one per cue, positioned and sized proportionally to time. Dragging a
// block's body moves it (keeping its duration); dragging an edge trims that
// side. Cue *order* in the array is never changed by dragging — only start/
// end — so a block can end up visually out of sequence relative to its
// neighbors (matching how caption/subtitle tracks in NLEs behave: captions
// are independent time ranges, not clips that exclude each other).
//
// Drag updates are applied to local `dragPreview` state only, and committed
// to the parent (via onCueTimeChange) on pointerup. Every cue in a long
// sermon transcript (hundreds) is a rendered block, so pushing a live update
// up through parent state on every pointermove would re-render the whole
// transcript list too; a local preview keeps dragging smooth regardless of
// transcript length.
//
// Drag tracking is done with WINDOW-level pointermove/pointerup listeners
// rather than per-element setPointerCapture. The resize handles are only a
// few pixels wide, so the instant a drag moves the cursor off that sliver
// (which happens almost immediately once you're actually resizing), capture
// is exactly what's supposed to keep move/up events routed to the handle
// regardless of where the cursor physically is. But capture is not
// universally reliable (some environments throw NotFoundError on
// setPointerCapture for a pointer id that isn't tracked as "active" by their
// pointer-capture implementation, silently breaking the drag with no visual
// feedback) — window listeners sidestep that dependency entirely: they don't
// care what element is under the cursor, so a narrow handle or a very short
// cue block never loses the drag.
const MIN_PX_PER_SECOND = 4;
const MAX_PX_PER_SECOND = 80;
const DEFAULT_PX_PER_SECOND = 14;
const MIN_CUE_DURATION = 0.1;
const DRAG_THRESHOLD_PX = 4;
const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 24;

type DragMode = 'move' | 'resize-start' | 'resize-end';

interface DragState {
  pointerId: number;
  mode: DragMode;
  cueIndex: number;
  startClientX: number;
  origStart: number;
  origEnd: number;
  dragging: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatTickLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

// Picks a "nice" tick spacing (in seconds) so ticks land roughly `targetPx`
// apart on screen at the current zoom level.
function pickTickInterval(pxPerSecond: number): number {
  const targetPx = 90;
  const rawSeconds = targetPx / pxPerSecond;
  const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return niceSteps.find((step) => step >= rawSeconds) ?? niceSteps[niceSteps.length - 1];
}

export default function SubtitleTimeline({
  cues,
  duration,
  currentTime,
  isPlaying,
  activeCueIndex,
  onSeek,
  onSelectCue,
  onCueTimeChange,
}: SubtitleTimelineProps) {
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SECOND);
  const [dragPreview, setDragPreview] = useState<{ index: number; start: number; end: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbingRef = useRef(false);

  // Kept in refs (not just closed over) so the window-level listeners —
  // attached once for the component's lifetime — always see the latest
  // values without needing to be torn down and re-attached every render.
  // This includes the callback props: onCueTimeChange in particular closes
  // (transitively, in SubtitlesFlow) over the current `draft.cues` array, so
  // calling a version captured at mount would silently overwrite every other
  // edit made since with stale pre-edit data — a real bug caught in manual
  // QA (a second cue's edit reverted a first one's).
  const pxPerSecondRef = useRef(pxPerSecond);
  pxPerSecondRef.current = pxPerSecond;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const dragPreviewRef = useRef(dragPreview);
  dragPreviewRef.current = dragPreview;
  const onCueTimeChangeRef = useRef(onCueTimeChange);
  onCueTimeChangeRef.current = onCueTimeChange;
  const onSelectCueRef = useRef(onSelectCue);
  onSelectCueRef.current = onSelectCue;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const totalWidth = Math.max(1, duration * pxPerSecond);
  const ticks = useMemo(() => {
    const interval = pickTickInterval(pxPerSecond);
    const marks: number[] = [];
    for (let t = 0; t <= duration; t += interval) {
      marks.push(t);
    }
    return marks;
  }, [duration, pxPerSecond]);

  // Auto-scroll to keep the playhead in view, but only while actually
  // playing — otherwise this would fight a user who is scrolled elsewhere to
  // manually adjust a cue.
  useEffect(() => {
    if (!isPlaying) return;
    const el = scrollRef.current;
    if (!el) return;
    const playheadX = currentTime * pxPerSecond;
    if (playheadX < el.scrollLeft + 24 || playheadX > el.scrollLeft + el.clientWidth - 24) {
      el.scrollLeft = Math.max(0, playheadX - el.clientWidth / 3);
    }
  }, [currentTime, pxPerSecond, isPlaying]);

  const seekFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const time = clamp((clientX - rect.left) / pxPerSecondRef.current, 0, durationRef.current);
    onSeekRef.current(time);
  };

  // --- Block drag (move/resize) — window-level tracking, see doc comment above.
  useEffect(() => {
    const onWindowPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startClientX;
      if (!drag.dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        drag.dragging = true;
      }
      event.preventDefault();
      const dt = dx / pxPerSecondRef.current;
      const duration_ = durationRef.current;
      let newStart = drag.origStart;
      let newEnd = drag.origEnd;

      if (drag.mode === 'move') {
        const cueDuration = drag.origEnd - drag.origStart;
        newStart = clamp(drag.origStart + dt, 0, Math.max(0, duration_ - cueDuration));
        newEnd = newStart + cueDuration;
      }
      else if (drag.mode === 'resize-start') {
        newStart = clamp(drag.origStart + dt, 0, drag.origEnd - MIN_CUE_DURATION);
      }
      else {
        newEnd = clamp(drag.origEnd + dt, drag.origStart + MIN_CUE_DURATION, duration_);
      }

      setDragPreview({ index: drag.cueIndex, start: newStart, end: newEnd });
    };

    const onWindowPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const wasDrag = drag.dragging;
      dragRef.current = null;

      if (wasDrag) {
        const preview = dragPreviewRef.current;
        setDragPreview(null);
        if (preview && preview.index === drag.cueIndex) {
          onCueTimeChangeRef.current(drag.cueIndex, preview.start, preview.end);
        }
      }
      else {
        // A tap (no drag): select the cue and jump playback to its start.
        onSelectCueRef.current(drag.cueIndex);
        const cue = cuesRef.current[drag.cueIndex];
        if (cue) onSeekRef.current(cue.start);
      }
    };

    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
    };
    // Mount-once: every value this reads (pxPerSecond, duration, cues, the
    // callback props) is read through a ref that's kept current every
    // render, precisely so this never needs to depend on them directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    scrubbingRef.current = true;
    seekFromClientX(event.clientX);
  };

  // --- Ruler scrub — also window-level, for the same reason as block drags:
  // a fast drag can easily leave the ruler's own (short, 24px-tall) strip.
  useEffect(() => {
    const onWindowPointerMove = (event: PointerEvent) => {
      if (!scrubbingRef.current) return;
      seekFromClientX(event.clientX);
    };
    const onWindowPointerUp = () => {
      scrubbingRef.current = false;
    };
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBlockPointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number, mode: DragMode) => {
    event.stopPropagation();
    const cue = cues[index];
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      cueIndex: index,
      startClientX: event.clientX,
      origStart: cue.start,
      origEnd: cue.end,
      dragging: false,
    };
  };

  // A normal vertical mouse wheel scrolls the (horizontal-only) timeline
  // sideways, matching the scroll convention of most NLE/DAW timelines.
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    el.scrollLeft += delta;
  };

  if (!(duration > 0)) {
    return null;
  }

  return (
    <div className="subtitle-timeline">
      <div className="subtitle-timeline-toolbar">
        <span className="subtitle-timeline-zoom-label">Zoom</span>
        <input
          type="range"
          min={MIN_PX_PER_SECOND}
          max={MAX_PX_PER_SECOND}
          value={pxPerSecond}
          onChange={(event) => setPxPerSecond(Number(event.target.value))}
          aria-label="Timeline zoom"
        />
      </div>
      <div className="subtitle-timeline-scroll" ref={scrollRef} onWheel={onWheel}>
        <div className="subtitle-timeline-inner" style={{ width: totalWidth }}>
          <div
            className="subtitle-timeline-ruler"
            style={{ height: RULER_HEIGHT }}
            onPointerDown={onRulerPointerDown}
          >
            {ticks.map((t) => (
              <div key={t} className="subtitle-timeline-tick" style={{ left: t * pxPerSecond }}>
                <span>{formatTickLabel(t)}</span>
              </div>
            ))}
          </div>
          <div
            className="subtitle-timeline-track"
            ref={trackRef}
            style={{ height: TRACK_HEIGHT }}
            onPointerDown={onRulerPointerDown}
          >
            {cues.map((cue, index) => {
              const preview = dragPreview && dragPreview.index === index ? dragPreview : null;
              const start = preview?.start ?? cue.start;
              const end = preview?.end ?? cue.end;
              const left = start * pxPerSecond;
              const width = Math.max(6, (end - start) * pxPerSecond);
              const isActive = index === activeCueIndex;
              return (
                <div
                  key={index}
                  className={`subtitle-timeline-block${isActive ? ' active' : ''}${preview ? ' dragging' : ''}`}
                  style={{ left, width }}
                  title={cue.text || '(empty cue)'}
                  onPointerDown={(event) => onBlockPointerDown(event, index, 'move')}
                >
                  <div
                    className="subtitle-timeline-handle left"
                    onPointerDown={(event) => onBlockPointerDown(event, index, 'resize-start')}
                  />
                  <span className="subtitle-timeline-block-text">{cue.text || '(empty)'}</span>
                  <div
                    className="subtitle-timeline-handle right"
                    onPointerDown={(event) => onBlockPointerDown(event, index, 'resize-end')}
                  />
                </div>
              );
            })}
          </div>
          <div className="subtitle-timeline-playhead" style={{ left: currentTime * pxPerSecond }} />
        </div>
      </div>
      <p className="shorts-hint">Drag a block to move it, or its edges to trim/extend. Click the ruler to seek.</p>
    </div>
  );
}
