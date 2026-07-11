// Pure helpers for the "short" (9:16 vertical) pipeline: crop geometry and the
// VTT -> ASS caption conversion. Kept in their own module (with no side effects)
// so they can be unit-tested without booting the worker in main.ts.

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// Round down to the nearest even integer. H.264 requires even dimensions and
// even crop offsets, and the CSS preview must use the same numbers so the
// on-screen window matches the encoded output exactly.
export function evenFloor(value: number): number {
    const floored = Math.floor(value);
    return floored - (floored % 2);
}

export interface ShortCrop {
    cropW: number;
    cropH: number;
    x: number;
    y: number;
}

// From a source W x H frame and zoom z (>=1), carve a full-height-ish 9:16
// window. Higher zoom -> smaller window (tighter crop). cropX in [0,1] slides
// the window left..right; cropY in [0,1] slides it top..bottom (only has slack
// once zoomed in, since a zoom=1 window already spans the full height).
// Mirrors the CSS preview in ShortsFlow.tsx.
export function computeShortCrop(
    width: number,
    height: number,
    zoom: number,
    cropX: number,
    cropY = 0.5,
): ShortCrop {
    const safeWidth = Math.max(2, Math.floor(width));
    const safeHeight = Math.max(2, Math.floor(height));
    const z = Math.max(1, Number.isFinite(zoom) ? zoom : 1);

    let cropH = evenFloor(safeHeight / z);
    cropH = Math.max(2, Math.min(cropH, evenFloor(safeHeight)));

    let cropW = evenFloor((cropH * 9) / 16);
    // Never exceed the source width (e.g. an already-narrow source).
    cropW = Math.max(2, Math.min(cropW, evenFloor(safeWidth)));

    const maxX = Math.max(0, safeWidth - cropW);
    const x = Math.min(Math.max(0, evenFloor(maxX * clamp(cropX, 0, 1))), maxX);
    const maxY = Math.max(0, safeHeight - cropH);
    const y = Math.min(Math.max(0, evenFloor(maxY * clamp(cropY, 0, 1))), maxY);

    return { cropW, cropH, x, y };
}

// The crop fraction the CSS preview uses for a zoom=1 window, exported so the
// frontend and worker stay in lockstep: a full-height 9:16 window spans
// (9/16) / (16/9) = 81/256 ≈ 0.3164 of a 16:9 container's width.
export const SHORT_WINDOW_WIDTH_FRACTION = 81 / 256;

export interface VttCue {
    start: number;
    end: number;
    text: string;
}

// Parse "HH:MM:SS.mmm" or "MM:SS.mmm" (comma decimals tolerated) into seconds.
export function parseVttTimestamp(raw: string): number | null {
    const parts = raw.trim().replace(",", ".").split(":");
    if (parts.length < 2 || parts.length > 3) {
        return null;
    }

    const nums = parts.map((part) => Number.parseFloat(part));
    if (nums.some((num) => !Number.isFinite(num))) {
        return null;
    }

    if (parts.length === 3) {
        return nums[0] * 3600 + nums[1] * 60 + nums[2];
    }

    return nums[0] * 60 + nums[1];
}

// Extract cues from a WebVTT string. Tolerant of the WEBVTT header, optional
// numeric cue identifiers, cue settings after the end timestamp, and CRLF.
export function parseVttCues(vtt: string): VttCue[] {
    const lines = vtt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const cues: VttCue[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        const arrowIndex = line.indexOf("-->");

        if (arrowIndex === -1) {
            index += 1;
            continue;
        }

        const startRaw = line.slice(0, arrowIndex).trim();
        // Everything after "-->" starts with the end time, possibly followed by
        // cue settings (e.g. "line:90%"). Take the first whitespace token.
        const endRaw = line.slice(arrowIndex + 3).trim().split(/\s+/)[0] ?? "";
        const start = parseVttTimestamp(startRaw);
        const end = parseVttTimestamp(endRaw);

        index += 1;
        const textLines: string[] = [];
        while (index < lines.length && lines[index].trim() !== "") {
            textLines.push(lines[index]);
            index += 1;
        }

        if (start !== null && end !== null && end > start) {
            cues.push({ start, end, text: textLines.join("\n") });
        }
    }

    return cues;
}

// Escape a cue's text for the ASS "Dialogue" line: drop inline VTT tags, join
// wrapped lines with the ASS hard-newline "\N", and neutralize the "{...}"
// override-block delimiters so transcript punctuation can't inject styling.
export function escapeAssText(raw: string): string {
    return raw
        .replace(/<[^>]*>/g, "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\\N")
        .replace(/\{/g, "(")
        .replace(/\}/g, ")");
}

// Captions aim for 2 lines but may stretch to 3 to avoid leaving a lone
// trailing line (a "hanging" word/line on its own). Each line should comfortably
// fit the 1080-wide frame at the caption font size.
export const CAPTION_MAX_CHARS_PER_LINE = 22;
export const CAPTION_PREFERRED_LINES = 2;
export const CAPTION_MAX_LINES = 3;

// Flatten a cue's text to a single upper-case line: strip inline tags, collapse
// whitespace, neutralize "{...}" override delimiters. Word-wrapping is applied
// separately so we control the exact line count.
export function normalizeCaptionText(raw: string): string {
    return raw
        .replace(/<[^>]*>/g, "")
        .replace(/\{/g, "(")
        .replace(/\}/g, ")")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

// Greedily word-wrap a flat string into lines no longer than maxCharsPerLine.
export function wrapCaptionLines(text: string, maxCharsPerLine: number): string[] {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
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

// Split a flat caption string into a sequence of on-screen captions. Each
// caption prefers `preferredLines` lines but may take one more (up to
// `maxLines`) to absorb what would otherwise be a lone trailing line — so a
// long sermon sentence becomes several 2–3 line captions with no orphan.
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

// ASS uses "H:MM:SS.cc" (centiseconds). Carry rounding at the cs boundary so we
// never emit ".100".
export function formatAssTime(totalSeconds: number): string {
    const clamped = Math.max(0, totalSeconds);
    let hours = Math.floor(clamped / 3600);
    let minutes = Math.floor((clamped % 3600) / 60);
    let seconds = Math.floor(clamped % 60);
    let centis = Math.round((clamped - Math.floor(clamped)) * 100);

    if (centis === 100) {
        centis = 0;
        seconds += 1;
        if (seconds === 60) {
            seconds = 0;
            minutes += 1;
            if (minutes === 60) {
                minutes = 0;
                hours += 1;
            }
        }
    }

    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    const cc = String(centis).padStart(2, "0");
    return `${hours}:${mm}:${ss}.${cc}`;
}

const ASS_HEADER = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    // WrapStyle 0 = smart auto-wrapping, so long lines wrap instead of running
    // off the sides of the frame.
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Bold white text, thick black outline + drop shadow, bottom-centered.
    // Wide L/R margins keep text off the edges; MarginV=560 sits the block in
    // the lower third of the 1920-tall frame.
    "Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,5,2,2,90,90,560,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
].join("\n");

export interface AssBuildResult {
    content: string;
    cueCount: number;
}

// Build an ASS subtitle file covering the clip window [clipStart, clipEnd].
// Cues that overlap the window are clipped to it and rebased so the clip starts
// at t=0; cues entirely outside are dropped.
export function buildAssFromVtt(vtt: string, clipStart: number, clipEnd: number): AssBuildResult {
    const cues = parseVttCues(vtt);
    const events: string[] = [];

    for (const cue of cues) {
        if (cue.end <= clipStart || cue.start >= clipEnd) {
            continue;
        }

        const start = Math.max(0, cue.start - clipStart);
        const end = Math.min(clipEnd, cue.end) - clipStart;
        if (end <= start) {
            continue;
        }

        // Split a long cue into a sequence of 2–3 line captions (never a lone
        // trailing line) and spread the cue's on-screen time evenly across them.
        const chunks = chunkCaptions(normalizeCaptionText(cue.text));
        if (chunks.length === 0) {
            continue;
        }

        const perChunk = (end - start) / chunks.length;
        chunks.forEach((chunk, index) => {
            const chunkStart = start + perChunk * index;
            const chunkEnd = index === chunks.length - 1 ? end : start + perChunk * (index + 1);
            events.push(`Dialogue: 0,${formatAssTime(chunkStart)},${formatAssTime(chunkEnd)},Default,,0,0,0,,${chunk}`);
        });
    }

    const content = events.length > 0
        ? `${ASS_HEADER}\n${events.join("\n")}\n`
        : `${ASS_HEADER}\n`;

    return { content, cueCount: events.length };
}

// Escape a file path for use inside an ffmpeg "-vf" filtergraph value (the
// ass=<path> option). Backslashes, colons and single quotes are special to the
// filtergraph parser; commas would split the filter chain.
export function escapeAssPathForFilter(path: string): string {
    return path
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;

// Round to the nearest even integer (H.264 needs even dimensions/offsets).
function toEven(value: number): number {
    const rounded = Math.round(value);
    return rounded - (rounded % 2);
}

// Assemble the full "-vf" chain for a short and optionally burn captions.
//
// zoom >= 1: crop a 9:16 window from the source and scale it to fill 1080x1920.
// zoom  < 1: zoom OUT — scale the whole frame down (keeping its aspect ratio)
//   and letterbox it into the 1080x1920 canvas with even black bars. As zoom
//   drops, more of the frame is visible; below ~0.316 the full width fits and
//   black bars appear top and bottom (and eventually the sides too). cropX pans
//   horizontally whenever the scaled frame is wider than the canvas.
//
// cropY (0..1) pans the 9:16 window vertically in the zoom >= 1 case; it only
// has slack once zoomed in (a zoom=1 window already spans the full height). In
// the zoom < 1 case the frame is letterboxed, so vertical stays centered.
export function buildShortVideoFilter(
    width: number,
    height: number,
    zoom: number,
    cropX: number,
    cropY = 0.5,
    assFilePath?: string,
): string {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : 1));
    const chain: string[] = [];

    if (z >= 1) {
        const crop = computeShortCrop(width, height, z, cropX, cropY);
        chain.push(`crop=${crop.cropW}:${crop.cropH}:${crop.x}:${crop.y}`, "scale=1080:1920", "setsar=1");
    }
    else {
        // Scale the source so its height maps to z * 1920 of the canvas.
        const displayH = Math.max(2, toEven(1920 * z));
        const displayW = Math.max(2, toEven(displayH * (width / height)));
        const visibleW = Math.min(1080, displayW);
        const visibleH = Math.min(1920, displayH);
        const panRange = Math.max(0, displayW - visibleW);
        const cropXoff = toEven(clamp(Math.round(cropX * panRange), 0, panRange));
        const cropYoff = toEven(Math.max(0, (displayH - visibleH) / 2));
        const padX = toEven(Math.max(0, (1080 - visibleW) / 2));
        const padY = toEven(Math.max(0, (1920 - visibleH) / 2));

        chain.push(
            `scale=${displayW}:${displayH}`,
            `crop=${visibleW}:${visibleH}:${cropXoff}:${cropYoff}`,
            `pad=1080:1920:${padX}:${padY}:black`,
            "setsar=1",
        );
    }

    if (assFilePath) {
        chain.push(`ass=${escapeAssPathForFilter(assFilePath)}`);
    }

    return chain.join(",");
}
