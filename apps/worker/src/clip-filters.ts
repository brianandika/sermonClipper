// Pure filter-chain helpers for the "clip" (general-purpose) pipeline. No side
// effects, so they're unit-testable without booting the worker.
import { escapeAssPathForFilter } from "./captions";

// Trim to 3 decimals and drop trailing zeros so filter strings stay readable.
function fmt(seconds: number): string {
    return String(Number(seconds.toFixed(3)));
}

export interface ClipWindow {
    // What ffmpeg should actually read: -ss effectiveStart -t (effectiveEnd -
    // effectiveStart). Equal to [startTime, endTime] when fade is off.
    effectiveStart: number;
    effectiveEnd: number;
    // Seconds of real, adjacent source footage pulled in at each end and faded
    // from/to black. 0 on either side when fade is off, or when there isn't
    // enough source footage before startTime / after endTime to fade with.
    fadeInSeconds: number;
    fadeOutSeconds: number;
}

// The fade WIDENS the read window outward — it never dims or shortens the
// marked [startTime, endTime] selection itself. Each side is clamped
// independently by how much real source footage actually exists there, so a
// clip starting at startTime=1 only gets a 1s fade-in, and a clip ending at
// the very last frame of the source gets no fade-out at all. sourceDuration
// should come from a fresh ffprobe of the source file (see main.ts), not a
// possibly-stale Asset.duration column.
//
// fadeInRequested/fadeOutRequested are independent so a multi-segment clip
// (cut gaps removed) can fade-in only its FIRST segment and fade-out only its
// LAST one — segments in between never fade, regardless of the fade toggle.
// A single-segment clip (no gaps) passes the same boolean for both, which is
// exactly the original symmetric behavior.
//
// fadeSeconds is the caller-supplied requested length (the worker passes
// CLIP_FADE_SECONDS from @sermon-clipper/shared — this module intentionally
// takes it as a plain argument rather than importing shared, so it stays a
// trivially unit-testable pure function with no dependency graph).
export function resolveClipWindow(
    startTime: number,
    endTime: number,
    sourceDuration: number,
    fadeInRequested: boolean,
    fadeOutRequested: boolean,
    fadeSeconds: number,
): ClipWindow {
    const fadeInSeconds = fadeInRequested && fadeSeconds > 0
        ? Math.max(0, Math.min(fadeSeconds, startTime))
        : 0;

    const availableAfter = Number.isFinite(sourceDuration) ? Math.max(0, sourceDuration - endTime) : fadeSeconds;
    const fadeOutSeconds = fadeOutRequested && fadeSeconds > 0
        ? Math.max(0, Math.min(fadeSeconds, availableAfter))
        : 0;

    return {
        effectiveStart: startTime - fadeInSeconds,
        effectiveEnd: endTime + fadeOutSeconds,
        fadeInSeconds,
        fadeOutSeconds,
    };
}

export interface ClipVideoFilterOptions {
    window: ClipWindow;
    assFilePath?: string;     // absolute path; omit for no captions
}

// Order is deliberate: burn captions FIRST, then fade. A fade placed before the
// `ass` filter would leave the subtitles fully opaque over a black frame. This
// is a load-bearing invariant, not a style preference — do not reorder these
// two even for a "cleanup".
export function buildClipVideoFilter(options: ClipVideoFilterOptions): string {
    const { window } = options;
    const effectiveDuration = window.effectiveEnd - window.effectiveStart;
    const chain: string[] = [];
    if (options.assFilePath) {
        chain.push(`ass=${escapeAssPathForFilter(options.assFilePath)}`);
    }
    if (window.fadeInSeconds > 0) {
        chain.push(`fade=t=in:st=0:d=${fmt(window.fadeInSeconds)}`);
    }
    if (window.fadeOutSeconds > 0) {
        chain.push(
            `fade=t=out:st=${fmt(effectiveDuration - window.fadeOutSeconds)}`
            + `:d=${fmt(window.fadeOutSeconds)}`,
        );
    }
    // Always last: guarantees an encoder-friendly pixel format even when nothing
    // else is in the chain (the trim itself still requires a re-encode).
    chain.push("format=yuv420p");
    return chain.join(",");
}

// Matching audio fade. Returns null when there's no fade at all (or no audio
// track), so the caller can omit "-af" entirely.
export function buildClipAudioFilter(window: ClipWindow): string | null {
    if (!(window.fadeInSeconds > 0) && !(window.fadeOutSeconds > 0)) return null;
    const effectiveDuration = window.effectiveEnd - window.effectiveStart;
    const parts: string[] = [];
    if (window.fadeInSeconds > 0) {
        parts.push(`afade=t=in:st=0:d=${fmt(window.fadeInSeconds)}`);
    }
    if (window.fadeOutSeconds > 0) {
        parts.push(`afade=t=out:st=${fmt(effectiveDuration - window.fadeOutSeconds)}:d=${fmt(window.fadeOutSeconds)}`);
    }
    return parts.join(",");
}
