// Standalone unit tests for the Subtitles tab's pure editing logic. Run with:
//   npm run test --workspace @sermon-clipper/web
// (which invokes `tsx src/subtitleEditing.test.ts`). No test framework required.
import assert from 'node:assert/strict';
import {
  COALESCE_WINDOW_MS,
  MAX_CUE_HISTORY,
  canRedoCues,
  canUndoCues,
  clampCueTimes,
  commitCueEdit,
  emptyCueHistory,
  getHistoryShortcut,
  insertCueAfter,
  insertCueAtTime,
  isFocusVisibleTarget,
  prepareExportCues,
  redoCueEdit,
  shouldLeaveSpaceToTarget,
  undoCueEdit,
  type CueHistoryState,
} from './subtitleEditing';
import type { EditableTranscriptCue } from './types';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  process.stdout.write(`  ok - ${name}\n`);
}

const cue = (start: number, end: number, text = 'x'): EditableTranscriptCue => ({ start, end, text });

function makeState(cues: EditableTranscriptCue[]): CueHistoryState {
  return { cues, ...emptyCueHistory() };
}

// Cues that touch end to end, like a real transcription.
const packed = () => [cue(0, 4, 'a'), cue(4, 10, 'b'), cue(10, 12, 'c')];

// --- clampCueTimes ----------------------------------------------------------
test('clampCueTimes keeps a cue inside [0, duration] with a minimum length', () => {
  assert.deepEqual(clampCueTimes(-5, 3, 10), { start: 0, end: 3 });
  assert.deepEqual(clampCueTimes(9.99, 50, 10), { start: 9.9, end: 10 });
  const inverted = clampCueTimes(5, 2, 10);
  assert.ok(inverted.end > inverted.start);
});

test('clampCueTimes treats an unknown (0) duration as unbounded', () => {
  assert.deepEqual(clampCueTimes(100, 200, 0), { start: 100, end: 200 });
});

// --- history ----------------------------------------------------------------
test('commit pushes the previous cues onto the undo stack and clears redo', () => {
  const a = [cue(0, 1)];
  const b = [cue(0, 2)];
  const s1 = commitCueEdit(makeState(a), b, {}, 1000);
  assert.equal(s1.cues, b);
  assert.deepEqual(s1.cuePast, [a]);
  assert.equal(canUndoCues(s1), true);
  assert.equal(canRedoCues(s1), false);
});

test('commit with the same array (a no-op edit) creates no history entry', () => {
  const a = [cue(0, 1)];
  const s = makeState(a);
  assert.equal(commitCueEdit(s, a, { coalesceKey: 'k' }, 1000), s);
});

test('undo then redo restores each state, and a new edit clears redo', () => {
  const v0 = [cue(0, 1, 'v0')];
  const v1 = [cue(0, 1, 'v1')];
  const v2 = [cue(0, 1, 'v2')];
  const v3 = [cue(0, 1, 'v3')];
  let s = makeState(v0);
  s = commitCueEdit(s, v1, {}, 1);
  s = commitCueEdit(s, v2, {}, 2);

  s = undoCueEdit(s);
  assert.equal(s.cues, v1);
  s = undoCueEdit(s);
  assert.equal(s.cues, v0);
  assert.equal(canUndoCues(s), false);
  assert.equal(undoCueEdit(s), s, 'undo with nothing to undo is a no-op');

  s = redoCueEdit(s);
  assert.equal(s.cues, v1);
  s = redoCueEdit(s);
  assert.equal(s.cues, v2);
  assert.equal(redoCueEdit(s), s, 'redo with nothing to redo is a no-op');

  s = undoCueEdit(s);
  assert.equal(canRedoCues(s), true);
  s = commitCueEdit(s, v3, {}, 3);
  assert.equal(canRedoCues(s), false, 'a new edit discards the redo stack');
});

test('edits with the same coalesce key inside the window share one undo step', () => {
  const v0 = [cue(0, 1, '')];
  let s = makeState(v0);
  const typed = ['h', 'he', 'hel', 'hell', 'hello'].map((text) => [cue(0, 1, text)]);
  typed.forEach((cues, i) => {
    s = commitCueEdit(s, cues, { coalesceKey: 'text:0' }, 1000 + i * 100);
  });
  assert.equal(s.cuePast.length, 1, 'one step for the whole burst');
  assert.equal(s.cues, typed[4]);
  s = undoCueEdit(s);
  assert.equal(s.cues, v0, 'one undo reverts the whole burst');
});

test('a pause longer than the window, or a different key, starts a new step', () => {
  let s = makeState([cue(0, 1, '')]);
  s = commitCueEdit(s, [cue(0, 1, 'a')], { coalesceKey: 'text:0' }, 1000);
  s = commitCueEdit(s, [cue(0, 1, 'ab')], { coalesceKey: 'text:0' }, 1000 + COALESCE_WINDOW_MS + 1);
  assert.equal(s.cuePast.length, 2, 'pause starts a new step');
  s = commitCueEdit(s, [cue(0, 1, 'abc')], { coalesceKey: 'text:1' }, 1000 + COALESCE_WINDOW_MS + 2);
  assert.equal(s.cuePast.length, 3, 'different key starts a new step');
});

test('an un-keyed edit in between breaks coalescing', () => {
  let s = makeState([cue(0, 1, '')]);
  s = commitCueEdit(s, [cue(0, 1, 'a')], { coalesceKey: 'text:0' }, 1000);
  s = commitCueEdit(s, [cue(0, 2, 'a')], {}, 1100);
  s = commitCueEdit(s, [cue(0, 2, 'ab')], { coalesceKey: 'text:0' }, 1200);
  assert.equal(s.cuePast.length, 3);
});

test('undo resets coalescing so the next edit is its own step', () => {
  let s = makeState([cue(0, 1, '')]);
  s = commitCueEdit(s, [cue(0, 1, 'a')], { coalesceKey: 'text:0' }, 1000);
  s = undoCueEdit(s);
  s = commitCueEdit(s, [cue(0, 1, 'z')], { coalesceKey: 'text:0' }, 1050);
  assert.equal(s.cuePast.length, 1);
  assert.equal(s.cues[0].text, 'z');
});

test('history is capped', () => {
  let s = makeState([cue(0, 1, '0')]);
  for (let i = 1; i <= MAX_CUE_HISTORY + 25; i += 1) {
    s = commitCueEdit(s, [cue(0, 1, String(i))], {}, i);
  }
  assert.equal(s.cuePast.length, MAX_CUE_HISTORY);
  assert.equal(s.cuePast[s.cuePast.length - 1][0].text, String(MAX_CUE_HISTORY + 24), 'newest steps are kept');
});

// --- insertCueAfter ---------------------------------------------------------
test('insertCueAfter fills a gap right after the row', () => {
  const cues = [cue(0, 4, 'a'), cue(10, 12, 'b')];
  const { cues: out, index } = insertCueAfter(cues, 0, 20);
  assert.equal(index, 1);
  assert.equal(out.length, 3);
  assert.deepEqual(out[1], { start: 4, end: 6, text: '' });
  assert.deepEqual(out[0], cues[0], 'existing rows are untouched');
  assert.deepEqual(out[2], cues[1]);
});

test('insertCueAfter limits the new line to a small gap', () => {
  const { cues: out } = insertCueAfter([cue(0, 4), cue(5, 8)], 0, 20);
  assert.deepEqual(out[1], { start: 4, end: 5, text: '' });
});

test('insertCueAfter splits the tail off a row that touches the next one', () => {
  const { cues: out, index } = insertCueAfter(packed(), 1, 20);
  assert.equal(index, 2);
  assert.equal(out.length, 4);
  assert.deepEqual(out[1], { start: 4, end: 8, text: 'b' }, 'row shortened');
  assert.deepEqual(out[2], { start: 8, end: 10, text: '' }, 'new line takes the tail');
  assert.deepEqual(out[3], packed()[2]);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].start >= out[i - 1].end - 1e-9, 'no overlaps');
  }
});

test('insertCueAfter splits the last row when it ends at the end of the video', () => {
  const { cues: out, index } = insertCueAfter(packed(), 2, 12);
  assert.equal(index, 3);
  // Row c (10-12) is only 2s long, so the new line takes half of it.
  assert.deepEqual(out[2], { start: 10, end: 11, text: 'c' });
  assert.deepEqual(out[3], { start: 11, end: 12, text: '' });
});

test('insertCueAfter on the last row with room before the end of the video', () => {
  const { cues: out } = insertCueAfter([cue(0, 4, 'a')], 0, 30);
  assert.deepEqual(out[1], { start: 4, end: 6, text: '' });
});

test('insertCueAfter on a row too short to split falls back to overlapping, inside the video', () => {
  const { cues: out, index } = insertCueAfter([cue(0, 0.6, 'a'), cue(0.6, 1.0, 'b')], 0, 1.0);
  assert.equal(index, 1);
  assert.equal(out.length, 3);
  assert.ok(out[1].start >= 0 && out[1].end <= 1.0 + 1e-9);
  assert.ok(out[1].end - out[1].start >= 0.1 - 1e-9);
});

test('insertCueAfter treats an overlapping neighbor as no gap', () => {
  const cues = [cue(0, 4, 'a'), cue(2, 8, 'overlaps a'), cue(20, 22, 'far')];
  const { cues: out } = insertCueAfter(cues, 0, 30);
  assert.equal(out[0].end < 4, true, 'row a had its tail split off instead of using the far gap');
  assert.equal(out[1].text, '');
});

test('insertCueAfter with an unknown video duration still works', () => {
  const { cues: out } = insertCueAfter([cue(0, 4, 'a')], 0, 0);
  assert.deepEqual(out[1], { start: 4, end: 6, text: '' });
});

// --- insertCueAtTime --------------------------------------------------------
test('insertCueAtTime in a gap places the line at the playhead', () => {
  const { cues: out, index } = insertCueAtTime([cue(0, 4, 'a'), cue(10, 12, 'b')], 6, 20);
  assert.equal(index, 1);
  assert.deepEqual(out[1], { start: 6, end: 8, text: '' });
});

test('insertCueAtTime before the first cue goes first in the list', () => {
  const { cues: out, index } = insertCueAtTime([cue(4.24, 10, 'a')], 1, 50);
  assert.equal(index, 0);
  assert.deepEqual(out[0], { start: 1, end: 3, text: '' });
});

test('insertCueAtTime after the last cue goes last in the list', () => {
  const { cues: out, index } = insertCueAtTime([cue(0, 4, 'a')], 30, 50);
  assert.equal(index, 1);
  assert.deepEqual(out[1], { start: 30, end: 32, text: '' });
});

test('insertCueAtTime near the end of a gap shifts back so the line fits', () => {
  const { cues: out } = insertCueAtTime([cue(0, 5, 'a'), cue(10, 12, 'b')], 9.9, 50);
  const added = out[1];
  assert.ok(added.start >= 5 && added.end <= 10 + 1e-9);
  assert.ok(added.end - added.start >= 0.5 - 1e-9);
});

test('insertCueAtTime inside a cue inserts after that cue (no overlap)', () => {
  const { cues: out, index } = insertCueAtTime(packed(), 6, 20);
  assert.equal(index, 2);
  assert.equal(out[1].text, 'b');
  assert.equal(out[2].text, '');
  assert.equal(out[1].end, out[2].start);
});

test('insertCueAtTime in a gap too small for a line carves one out of the previous cue', () => {
  const cues = [cue(0, 4, 'a'), cue(4.2, 10, 'b')];
  const { cues: out } = insertCueAtTime(cues, 4.1, 20);
  assert.equal(out.length, 3);
  assert.equal(out[1].text, '');
  assert.ok(out[0].end <= 4 + 1e-9);
});

test('insertCueAtTime into an empty transcript', () => {
  const { cues: out, index } = insertCueAtTime([], 7, 60);
  assert.equal(index, 0);
  assert.deepEqual(out, [{ start: 7, end: 9, text: '' }]);
});

test('insertCueAtTime clamps a playhead past the end of the video', () => {
  const { cues: out } = insertCueAtTime([], 99, 10);
  assert.ok(out[0].start <= 10 - 0.1 + 1e-9 && out[0].end <= 10 + 1e-9);
  assert.ok(out[0].end > out[0].start);
});

// --- export prep -------------------------------------------------------------
test('prepareExportCues drops blank lines and sorts by start time (stable)', () => {
  const out = prepareExportCues([
    cue(10, 12, 'late'),
    cue(1, 2, '   '),
    cue(5, 6, 'first tie'),
    cue(0, 1, 'earliest'),
    cue(5, 7, 'second tie'),
  ]);
  assert.deepEqual(out.map((c) => c.text), ['earliest', 'first tie', 'second tie', 'late']);
});

test('prepareExportCues of only blank lines is empty', () => {
  assert.deepEqual(prepareExportCues([cue(0, 1, ''), cue(1, 2, ' ')]), []);
});

// --- keyboard rules ----------------------------------------------------------
const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });

test('Space is left alone in text-like fields (however they got focus)', () => {
  for (const viaKeyboard of [true, false]) {
    assert.equal(shouldLeaveSpaceToTarget(el('INPUT', { type: 'text' }), viaKeyboard), true);
    assert.equal(shouldLeaveSpaceToTarget(el('INPUT'), viaKeyboard), true);
    assert.equal(shouldLeaveSpaceToTarget(el('INPUT', { type: 'number' }), viaKeyboard), true);
    assert.equal(shouldLeaveSpaceToTarget(el('TEXTAREA'), viaKeyboard), true);
    assert.equal(shouldLeaveSpaceToTarget(el('SELECT'), viaKeyboard), true);
    assert.equal(shouldLeaveSpaceToTarget(el('DIV', { isContentEditable: true }), viaKeyboard), true);
  }
});

test('Space is left to a focused video (it toggles natively)', () => {
  assert.equal(shouldLeaveSpaceToTarget(el('VIDEO'), false), true);
  assert.equal(shouldLeaveSpaceToTarget(el('VIDEO'), true), true);
});

test('Space is hijacked on the page body and on a range slider', () => {
  assert.equal(shouldLeaveSpaceToTarget(el('BODY'), false), false);
  assert.equal(shouldLeaveSpaceToTarget(el('DIV'), true), false);
  assert.equal(shouldLeaveSpaceToTarget(el('INPUT', { type: 'range' }), true), false);
  assert.equal(shouldLeaveSpaceToTarget(null, false), false);
  assert.equal(shouldLeaveSpaceToTarget({}, true), false);
});

test('Space activates keyboard-focused buttons/radios natively but not mouse-focused ones', () => {
  assert.equal(shouldLeaveSpaceToTarget(el('BUTTON'), true), true);
  assert.equal(shouldLeaveSpaceToTarget(el('BUTTON'), false), false);
  assert.equal(shouldLeaveSpaceToTarget(el('INPUT', { type: 'radio' }), true), true);
  assert.equal(shouldLeaveSpaceToTarget(el('INPUT', { type: 'radio' }), false), false);
  assert.equal(shouldLeaveSpaceToTarget(el('INPUT', { type: 'checkbox' }), false), false);
  assert.equal(shouldLeaveSpaceToTarget(el('A'), true), true);
  assert.equal(shouldLeaveSpaceToTarget(el('A'), false), false);
});

test('isFocusVisibleTarget reflects :focus-visible, and is conservative when unsupported', () => {
  assert.equal(isFocusVisibleTarget({ tagName: 'BUTTON', matches: (sel: string) => sel === ':focus-visible' }), true);
  assert.equal(isFocusVisibleTarget({ tagName: 'BUTTON', matches: () => false }), false);
  assert.equal(isFocusVisibleTarget({ tagName: 'BUTTON' }), true, 'no matches() -> assume keyboard');
  const throwing = {
    tagName: 'BUTTON',
    matches: () => {
      throw new Error('unsupported selector');
    },
  };
  assert.equal(isFocusVisibleTarget(throwing), true, 'browser without :focus-visible -> assume keyboard');
});

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test('Mac: Cmd+Z undoes, Cmd+Shift+Z redoes, Ctrl+Z does nothing', () => {
  assert.equal(getHistoryShortcut(key('z', { metaKey: true }), true), 'undo');
  assert.equal(getHistoryShortcut(key('Z', { metaKey: true, shiftKey: true }), true), 'redo');
  assert.equal(getHistoryShortcut(key('z', { ctrlKey: true }), true), null);
  assert.equal(getHistoryShortcut(key('y', { ctrlKey: true }), true), null);
  assert.equal(getHistoryShortcut(key('y', { metaKey: true }), true), null);
});

test('Windows/Linux: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo, Cmd does nothing', () => {
  assert.equal(getHistoryShortcut(key('z', { ctrlKey: true }), false), 'undo');
  assert.equal(getHistoryShortcut(key('Z', { ctrlKey: true, shiftKey: true }), false), 'redo');
  assert.equal(getHistoryShortcut(key('y', { ctrlKey: true }), false), 'redo');
  assert.equal(getHistoryShortcut(key('z', { metaKey: true }), false), null);
});

test('history shortcuts ignore Alt combos and plain keys', () => {
  assert.equal(getHistoryShortcut(key('z', { metaKey: true, altKey: true }), true), null);
  assert.equal(getHistoryShortcut(key('z'), true), null);
  assert.equal(getHistoryShortcut(key('z'), false), null);
  assert.equal(getHistoryShortcut(key('a', { metaKey: true }), true), null);
});

process.stdout.write(`\n${passed} subtitle editing tests passed\n`);
