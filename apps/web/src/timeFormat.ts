// Shared minutes:seconds.milliseconds formatting for editable time fields
// (Start/End/clip-cut times) across the Editor and Shorts tabs. Minutes are
// not capped at 59 (a sermon can run well past an hour), and there's no hours
// segment — just growing minutes, e.g. "75:03.500".

export function formatMinSec(totalSeconds: number): string {
  const clamped = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  let wholeSeconds = Math.floor(clamped);
  let ms = Math.round((clamped - wholeSeconds) * 1000);
  if (ms >= 1000) {
    ms -= 1000;
    wholeSeconds += 1;
  }
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// Parses "M:SS(.mmm)?" (the format this UI displays). Falls back to a plain
// seconds number so a pasted raw value (or an old saved draft) still works.
export function parseMinSec(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+):([0-5]?\d)(?:[.,](\d{1,3}))?$/);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const ms = Number((match[3] ?? '0').padEnd(3, '0'));
    return minutes * 60 + seconds + ms / 1000;
  }

  const plain = Number.parseFloat(trimmed);
  return Number.isFinite(plain) ? plain : null;
}
