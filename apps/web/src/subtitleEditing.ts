// Pure editing logic for the Subtitles tab (cue timing clamps, undo/redo
// history, inserting new lines, keyboard rules, export prep). Kept free of
// React/DOM so it can be unit-tested without a browser — see
// subtitleEditing.test.ts (run with `npm run test --workspace @sermon-clipper/web`).

import type { EditableTranscriptCue } from './types';

export const MIN_CUE_DURATION = 0.1;
// What a freshly inserted line lasts, and the smallest slot we'll drop one into.
export const DEFAULT_NEW_CUE_DURATION = 2;
export const MIN_INSERT_ROOM = 0.5;

const EPS = 1e-6;

// Shared by the numeric Start/End inputs, the timeline drag handles and
// insertion, so a cue can never invert or run past what's known about the
// video. `durationHint` <= 0 means "not known yet" (a brief window before the
// video's metadata loads) and is treated as unbounded rather than as 0.
export function clampCueTimes(start: number, end: number, durationHint: number): { start: number; end: number } {
  const safeDuration = durationHint > 0 ? durationHint : Number.POSITIVE_INFINITY;
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, safeDuration - MIN_CUE_DURATION));
  const e = Math.max(s + MIN_CUE_DURATION, Math.min(Number.isFinite(end) ? end : s + MIN_CUE_DURATION, safeDuration));
  return { start: s, end: e };
}

// --- Undo / redo ------------------------------------------------------------

// The slice of SubtitlesDraft that history operates on. Generic functions
// below take/return the caller's full draft type, so only these fields change.
export interface CueHistoryState {
  cues: EditableTranscriptCue[];
  cuePast: EditableTranscriptCue[][];
  cueFuture: EditableTranscriptCue[][];
  // Which kind of edit produced the latest history step, and when — lets a
  // burst of keystrokes in one field collapse into a single undo step.
  lastEditKey: string | null;
  lastEditAt: number;
}

export interface CueCommitOptions {
  // Consecutive edits with the same non-null key within COALESCE_WINDOW_MS
  // share one undo step (e.g. typing in one cue's text box). Omit for edits
  // that should always be their own step (drags, inserts, deletes).
  coalesceKey?: string;
}

export const MAX_CUE_HISTORY = 200;
export const COALESCE_WINDOW_MS = 1000;

export function emptyCueHistory(): Pick<CueHistoryState, 'cuePast' | 'cueFuture' | 'lastEditKey' | 'lastEditAt'> {
  return { cuePast: [], cueFuture: [], lastEditKey: null, lastEditAt: 0 };
}

// Records `nextCues` as the new current state. Returns `state` untouched when
// nothing changed (same array identity), so no-op edits never create steps.
// Pure — `now` is a parameter so React StrictMode's double-invoked updaters
// and the tests both get deterministic results.
export function commitCueEdit<T extends CueHistoryState>(
  state: T,
  nextCues: EditableTranscriptCue[],
  options: CueCommitOptions = {},
  now: number = Date.now(),
): T {
  if (nextCues === state.cues) return state;

  const key = options.coalesceKey ?? null;
  const coalesce = key !== null && key === state.lastEditKey && now - state.lastEditAt <= COALESCE_WINDOW_MS;

  if (coalesce) {
    return { ...state, cues: nextCues, cueFuture: [], lastEditAt: now };
  }

  const past = [...state.cuePast, state.cues];
  if (past.length > MAX_CUE_HISTORY) past.splice(0, past.length - MAX_CUE_HISTORY);
  return { ...state, cues: nextCues, cuePast: past, cueFuture: [], lastEditKey: key, lastEditAt: now };
}

export function canUndoCues(state: Pick<CueHistoryState, 'cuePast'>): boolean {
  return state.cuePast.length > 0;
}

export function canRedoCues(state: Pick<CueHistoryState, 'cueFuture'>): boolean {
  return state.cueFuture.length > 0;
}

export function undoCueEdit<T extends CueHistoryState>(state: T): T {
  if (state.cuePast.length === 0) return state;
  const previous = state.cuePast[state.cuePast.length - 1];
  return {
    ...state,
    cues: previous,
    cuePast: state.cuePast.slice(0, -1),
    cueFuture: [state.cues, ...state.cueFuture],
    lastEditKey: null,
    lastEditAt: 0,
  };
}

export function redoCueEdit<T extends CueHistoryState>(state: T): T {
  if (state.cueFuture.length === 0) return state;
  const [next, ...rest] = state.cueFuture;
  return {
    ...state,
    cues: next,
    cuePast: [...state.cuePast, state.cues],
    cueFuture: rest,
    lastEditKey: null,
    lastEditAt: 0,
  };
}

// --- Inserting a new line ---------------------------------------------------

export interface InsertResult {
  cues: EditableTranscriptCue[];
  // Where the NEW line ended up in `cues`.
  index: number;
}

function emptyCue(start: number, end: number): EditableTranscriptCue {
  return { start, end, text: '' };
}

// Smallest start time among cues starting at/after `t`, ignoring `skipIndex`.
function nextStartAtOrAfter(cues: EditableTranscriptCue[], t: number, skipIndex: number): number | null {
  let best: number | null = null;
  cues.forEach((cue, i) => {
    if (i === skipIndex) return;
    if (cue.start >= t - EPS && (best === null || cue.start < best)) best = cue.start;
  });
  return best;
}

// Inserts a new empty line directly after `cues[index]` (in the list AND in
// time). Where it lands in time:
//  1. If there's a gap after that cue, the new line fills the start of it.
//  2. If the cue butts up against the next one (the usual case for a
//     transcription, where cues touch end to end), the tail of THAT cue is
//     split off for the new line, so nothing overlaps.
//  3. If the cue is too short to split, the new line overlaps as a last resort.
export function insertCueAfter(cues: EditableTranscriptCue[], index: number, durationHint: number): InsertResult {
  const cue = cues[index];
  if (!cue) return insertCueAtTime(cues, 0, durationHint);

  const limit = durationHint > 0 ? durationHint : Number.POSITIVE_INFINITY;
  const gapStart = cue.end;
  // Another cue already covering the spot right after this one (cues can
  // overlap) means there's no real gap, whatever starts later.
  const coveredByOther = cues.some((other, i) => i !== index && other.start <= gapStart + EPS && gapStart < other.end - EPS);
  const gapEnd = Math.min(nextStartAtOrAfter(cues, gapStart, index) ?? limit, limit);
  const room = coveredByOther ? 0 : gapEnd - gapStart;

  if (room >= MIN_INSERT_ROOM) {
    const added = emptyCue(gapStart, gapStart + Math.min(DEFAULT_NEW_CUE_DURATION, room));
    return { cues: [...cues.slice(0, index + 1), added, ...cues.slice(index + 1)], index: index + 1 };
  }

  const cueLength = cue.end - cue.start;
  if (cueLength >= 2 * MIN_INSERT_ROOM) {
    const take = Math.min(DEFAULT_NEW_CUE_DURATION, cueLength / 2);
    const splitAt = cue.end - take;
    const shortened = { ...cue, end: splitAt };
    const added = emptyCue(splitAt, cue.end);
    return { cues: [...cues.slice(0, index), shortened, added, ...cues.slice(index + 1)], index: index + 1 };
  }

  const { start, end } = clampCueTimes(gapStart, gapStart + DEFAULT_NEW_CUE_DURATION, durationHint);
  return { cues: [...cues.slice(0, index + 1), emptyCue(start, end), ...cues.slice(index + 1)], index: index + 1 };
}

// Inserts a new empty line at time `time` (the playhead). If the playhead is in
// a gap between lines the new line goes right there; if it's inside a line, the
// new one goes after that line (see insertCueAfter). The new line is placed in
// the list by start time.
export function insertCueAtTime(cues: EditableTranscriptCue[], time: number, durationHint: number): InsertResult {
  const limit = durationHint > 0 ? durationHint : Number.POSITIVE_INFINITY;
  const t = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, limit - MIN_CUE_DURATION));

  const containing = cues.findIndex((cue) => t >= cue.start - EPS && t < cue.end - EPS);
  if (containing >= 0) return insertCueAfter(cues, containing, durationHint);

  // In a gap: [gapLow, gapHigh] bounded by the nearest cue ends/starts around t.
  let gapLow = 0;
  cues.forEach((cue) => {
    if (cue.end <= t + EPS && cue.end > gapLow) gapLow = cue.end;
  });
  const gapHigh = Math.min(nextStartAtOrAfter(cues, t, -1) ?? limit, limit);

  if (gapHigh - gapLow >= MIN_INSERT_ROOM) {
    const start = Math.max(gapLow, Math.min(t, gapHigh - MIN_INSERT_ROOM));
    const end = Math.min(start + DEFAULT_NEW_CUE_DURATION, gapHigh);
    return placeByStart(cues, emptyCue(start, end));
  }

  // Gap too small to hold a line: carve one out of the cue just before it.
  let previous = -1;
  cues.forEach((cue, i) => {
    if (cue.end <= t + EPS && (previous < 0 || cue.end > cues[previous].end)) previous = i;
  });
  if (previous >= 0) return insertCueAfter(cues, previous, durationHint);

  const { start, end } = clampCueTimes(t, t + DEFAULT_NEW_CUE_DURATION, durationHint);
  return placeByStart(cues, emptyCue(start, end));
}

function placeByStart(cues: EditableTranscriptCue[], added: EditableTranscriptCue): InsertResult {
  const found = cues.findIndex((cue) => cue.start > added.start + EPS);
  const index = found < 0 ? cues.length : found;
  return { cues: [...cues.slice(0, index), added, ...cues.slice(index)], index };
}

// --- Export prep --------------------------------------------------------------

// What actually gets exported: blank placeholder lines are dropped, and the
// rest are put in chronological order (WebVTT requires non-decreasing start
// times and SRT players expect it too; a drag can reorder cues in time without
// reordering the list). Stable for equal start times.
export function prepareExportCues(cues: EditableTranscriptCue[]): EditableTranscriptCue[] {
  return cues
    .map((cue, order) => ({ cue, order }))
    .filter(({ cue }) => cue.text.trim() !== '')
    .sort((a, b) => a.cue.start - b.cue.start || a.order - b.order)
    .map(({ cue }) => cue);
}

// --- Keyboard rules -----------------------------------------------------------

export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  matches?: (selector: string) => boolean;
}

// Whether `target` just received focus via the keyboard (Tab etc.) rather than
// a mouse click. Meant to be evaluated at FOCUS time (a `focusin` listener) and
// remembered: re-checking `:focus-visible` when a key is later pressed doesn't
// work, because browsers flip it to true as soon as any key is pressed on the
// focused element — so a button you merely clicked would look keyboard-focused.
export function isFocusVisibleTarget(target: KeyTargetLike): boolean {
  try {
    return target.matches ? target.matches(':focus-visible') : true;
  }
  catch {
    // Browser without :focus-visible — be conservative and keep native behavior.
    return true;
  }
}

const SPACE_ACTIVATED_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color']);

// True when the Space key should be left alone because the focused element
// handles it itself:
//  - text fields / selects / textareas / contenteditable: Space types a space
//  - <video>/<audio>: the native controls toggle playback on Space already, so
//    handling it too would toggle twice
//  - buttons, checkboxes, radios, links: Space activates them — but only when
//    they got focus from the keyboard (`focusedViaKeyboard`, recorded at focus
//    time — see isFocusVisibleTarget). One focused by a mouse click (e.g. a
//    time badge or radio you just clicked) shouldn't swallow Space.
// A range slider ignores Space natively, so it doesn't count.
export function shouldLeaveSpaceToTarget(target: KeyTargetLike | null | undefined, focusedViaKeyboard: boolean): boolean {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'VIDEO' || tag === 'AUDIO') return true;

  if (tag === 'INPUT') {
    const type = (target.type || 'text').toLowerCase();
    if (type === 'range') return false;
    if (SPACE_ACTIVATED_INPUT_TYPES.has(type)) return focusedViaKeyboard;
    return true;
  }

  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A') return focusedViaKeyboard;
  return false;
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type HistoryShortcut = 'undo' | 'redo' | null;

// Cmd+Z / Cmd+Shift+Z on Mac; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y elsewhere. The
// other platform's modifier is deliberately not accepted (e.g. Ctrl+Z on a Mac
// is not undo), and Ctrl+Y is skipped on Mac where it's an Emacs-style binding.
export function getHistoryShortcut(event: KeyEventLike, isMac: boolean): HistoryShortcut {
  if (event.altKey) return null;
  const modifierDown = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifierDown) return null;

  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !isMac && !event.shiftKey) return 'redo';
  return null;
}
