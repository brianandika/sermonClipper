// Minimal WebVTT -> SubRip (.srt) conversion. No clipping/rebasing here —
// callers that need a time-windowed export (e.g. the worker burning captions
// into a derived clip) have their own cue model for that; this is the plain,
// whole-file conversion used for a straight "download my transcript as .srt"
// request.

export interface VttCue {
    start: number;
    end: number;
    text: string;
}

function parseVttTimestamp(raw: string): number | null {
    const trimmed = raw.trim();
    const match = trimmed.match(/^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/);
    if (!match) return null;
    const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
    const minutes = Number.parseInt(match[2], 10);
    const seconds = Number.parseInt(match[3], 10);
    const millis = Number.parseInt(match[4], 10);
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function parseVttCues(vtt: string): VttCue[] {
    const lines = vtt.replace(/\r\n/g, "\n").split("\n");
    const cues: VttCue[] = [];
    let i = 0;
    while (i < lines.length) {
        const arrow = lines[i].indexOf("-->");
        if (arrow === -1) {
            i += 1;
            continue;
        }
        const start = parseVttTimestamp(lines[i].slice(0, arrow));
        const end = parseVttTimestamp(lines[i].slice(arrow + 3).trim().split(/\s+/)[0] ?? "");
        i += 1;
        const textLines: string[] = [];
        while (i < lines.length && lines[i].trim() !== "") {
            textLines.push(lines[i].replace(/<[^>]*>/g, "").trim());
            i += 1;
        }
        if (start !== null && end !== null && end > start) {
            cues.push({ start, end, text: textLines.join("\n").trim() });
        }
    }
    return cues;
}

function formatSrtTimestamp(totalSeconds: number): string {
    const clamped = Math.max(0, totalSeconds);
    let hours = Math.floor(clamped / 3600);
    let minutes = Math.floor((clamped % 3600) / 60);
    let seconds = Math.floor(clamped % 60);
    let millis = Math.round((clamped - Math.floor(clamped)) * 1000);

    if (millis === 1000) {
        millis = 0;
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

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

// Renders cues as a standard numbered SRT document, preserving each cue's own
// text/line breaks as-is (no uppercasing, wrapping, or reflow).
export function cuesToSrt(cues: VttCue[]): string {
    return cues
        .map((cue, index) => `${index + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`)
        .join("\n\n") + (cues.length > 0 ? "\n" : "");
}

export function vttToSrt(vtt: string): string {
    return cuesToSrt(parseVttCues(vtt));
}
