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
// the window left..right. Mirrors the CSS preview in ShortsFlow.tsx.
export function computeShortCrop(width: number, height: number, zoom: number, cropX: number): ShortCrop {
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
    const y = Math.max(0, evenFloor((safeHeight - cropH) / 2));

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
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Bold white text, thick black outline + drop shadow, bottom-centered and
    // lifted off the bottom edge — the standard readable "shorts" caption look.
    "Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,5,2,2,80,80,240,1",
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

        const text = escapeAssText(cue.text);
        if (!text) {
            continue;
        }

        events.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`);
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

// Assemble the full "-vf" chain for a short: crop the 9:16 window, scale to
// 1080x1920, reset SAR, then optionally burn captions.
export function buildShortVideoFilter(crop: ShortCrop, assFilePath?: string): string {
    const chain = [
        `crop=${crop.cropW}:${crop.cropH}:${crop.x}:${crop.y}`,
        "scale=1080:1920",
        "setsar=1",
    ];

    if (assFilePath) {
        chain.push(`ass=${escapeAssPathForFilter(assFilePath)}`);
    }

    return chain.join(",");
}
