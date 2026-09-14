// Caption text wrapping/chunking, shared between the worker's actual burn-in
// (captions.ts's buildAssFromVtt) and the web Subtitles tab's live preview
// overlay — using the SAME functions (not just the same algorithm written
// twice) is what makes the preview an accurate stand-in for the real output.
//
// The api/worker import this via "@sermon-clipper/shared" as usual (Node's
// require() resolves it fine). The web app instead imports this file
// directly by relative path to its TypeScript source — see the comment at
// that import site (SubtitlesFlow.tsx) for why: the built package, whether
// through its barrel or this module directly, doesn't resolve reliably
// through Vite/Rollup's static CJS analysis for a symlinked npm-workspace
// package in a production build.

// Captions aim for 2 lines but may stretch to 3 to avoid leaving a lone
// trailing line (a "hanging" word/line on its own). Each line should comfortably
// fit the 1080-wide frame at the caption font size (this is the shorts default;
// see LANDSCAPE_CAPTION_MAX_CHARS_PER_LINE for the landscape/Subtitles-tab one).
export const CAPTION_MAX_CHARS_PER_LINE = 22;
export const CAPTION_PREFERRED_LINES = 2;
export const CAPTION_MAX_LINES = 3;

// The Subtitles tab's landscape burn-in always wraps at this width regardless
// of the video's resolution (only font size scales with height — see
// landscapeCaptionStyle in the worker's captions.ts). Exported here so the
// web preview can match it exactly instead of hardcoding a second copy.
export const LANDSCAPE_CAPTION_MAX_CHARS_PER_LINE = 42;

// Flatten a cue's text to a single line: strip inline tags, collapse
// whitespace, neutralize "{...}" override delimiters. Word-wrapping is applied
// separately so we control the exact line count. Uppercased by default (the
// punchy shorts look); pass uppercase=false for standard-looking subtitles.
export function normalizeCaptionText(raw: string, uppercase = true): string {
    const cleaned = raw
        .replace(/<[^>]*>/g, "")
        .replace(/\{/g, "(")
        .replace(/\}/g, ")")
        .replace(/\s+/g, " ")
        .trim();
    return uppercase ? cleaned.toUpperCase() : cleaned;
}

function greedyWrap(words: string[], maxCharsPerLine: number): string[] {
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        if (!current) {
            current = word;
        }
        else if (current.length + 1 + word.length <= maxCharsPerLine) {
            current += ` ${word}`;
        }
        else {
            lines.push(current);
            current = word;
        }
    }

    if (current) {
        lines.push(current);
    }

    return lines;
}

// Word-wrap a flat string into lines no longer than maxCharsPerLine, balanced
// so consecutive lines end up close to equal length rather than a lopsided
// "line 1 crammed full, line 2 nearly empty" split. A plain greedy fill
// (take words until the next one wouldn't fit) is already optimal for the
// NUMBER of lines it produces, but not for how evenly it distributes words
// across them — so: first find that optimal line count via a plain greedy
// pass at the hard cap, then re-wrap at a narrower target width (the total
// text length divided evenly across that many lines), widening the target
// one character at a time only if that would otherwise need more lines than
// the greedy minimum (a single long word can force this).
export function wrapCaptionLines(text: string, maxCharsPerLine: number): string[] {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
        return [];
    }

    const minLineCount = greedyWrap(words, maxCharsPerLine).length;
    if (minLineCount <= 1) {
        return greedyWrap(words, maxCharsPerLine);
    }

    const totalLength = words.reduce((sum, word) => sum + word.length, 0) + (words.length - 1);
    let target = Math.ceil(totalLength / minLineCount);
    let lines = greedyWrap(words, target);
    while (lines.length > minLineCount && target < maxCharsPerLine) {
        target += 1;
        lines = greedyWrap(words, target);
    }

    return lines;
}

// Split a flat caption string into a sequence of on-screen captions. Each
// caption prefers `preferredLines` lines but may take one more (up to
// `maxLines`) to absorb what would otherwise be a lone trailing line — so a
// long sermon sentence becomes several 2–3 line captions with no orphan.
// Lines within a chunk are joined with the ASS hard-newline "\N" — callers
// rendering elsewhere (e.g. the web preview, as separate DOM lines) split on
// that same delimiter rather than re-wrapping themselves, so they see
// exactly the same line breaks the burned-in version will.
export function chunkCaptions(
    text: string,
    maxCharsPerLine = CAPTION_MAX_CHARS_PER_LINE,
    preferredLines = CAPTION_PREFERRED_LINES,
    maxLines = CAPTION_MAX_LINES,
): string[] {
    const lines = wrapCaptionLines(text, maxCharsPerLine);
    const chunks: string[] = [];
    let index = 0;

    while (index < lines.length) {
        const remaining = lines.length - index;
        let take = Math.min(preferredLines, remaining);
        // If taking the preferred count would strand exactly one line at the
        // end, pull it into this caption instead (up to maxLines).
        if (remaining - take === 1 && take < maxLines) {
            take += 1;
        }
        chunks.push(lines.slice(index, index + take).join("\\N"));
        index += take;
    }

    return chunks;
}
