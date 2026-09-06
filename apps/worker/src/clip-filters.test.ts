// Standalone unit tests for the pure "clip" (general-purpose) filter helpers.
// Run with: npm run test --workspace @sermon-clipper/worker
// (which invokes `tsx src/captions.test.ts && tsx src/clip-filters.test.ts`).
// No test framework required.
import assert from "node:assert/strict";
import {
    buildClipAudioFilter,
    buildClipVideoFilter,
    type ClipWindow,
    resolveClipWindow,
} from "./clip-filters";

let passed = 0;
function test(name: string, fn: () => void) {
    fn();
    passed += 1;
    process.stdout.write(`  ok - ${name}\n`);
}

// --- resolveClipWindow (the load-bearing one) -------------------------------

test("resolveClipWindow: fade off (both sides) returns the marked window untouched, regardless of sourceDuration", () => {
    const window = resolveClipWindow(10, 40, 600, false, false, 3);
    assert.deepEqual(window, {
        effectiveStart: 10,
        effectiveEnd: 40,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
    });
});

test("resolveClipWindow: plenty of room on both sides widens by the full fade on each side", () => {
    const window = resolveClipWindow(10, 40, 600, true, true, 3);
    assert.equal(window.effectiveStart, 7);
    assert.equal(window.effectiveEnd, 43);
    assert.equal(window.fadeInSeconds, 3);
    assert.equal(window.fadeOutSeconds, 3);
    // 30 marked + 6 fade — the exact number a copy-paste-from-the-old-design
    // mistake would get wrong.
    assert.equal(window.effectiveEnd - window.effectiveStart, 36);
});

test("resolveClipWindow: clamps fade-in when startTime is close to the source's beginning", () => {
    const window = resolveClipWindow(1.2, 40, 600, true, true, 3);
    assert.equal(window.fadeInSeconds, 1.2);
    assert.equal(window.effectiveStart, 0);
});

test("resolveClipWindow: clamps fade-out when endTime is close to the source's end", () => {
    const window = resolveClipWindow(10, 599, 600, true, true, 3);
    assert.equal(window.fadeOutSeconds, 1);
    assert.equal(window.effectiveEnd, 600);
});

test("resolveClipWindow: marked selection spans the entire source yields zero fade on both ends", () => {
    const window = resolveClipWindow(0, 600, 600, true, true, 3);
    assert.equal(window.fadeInSeconds, 0);
    assert.equal(window.fadeOutSeconds, 0);
    assert.equal(window.effectiveStart, 0);
    assert.equal(window.effectiveEnd, 600);
});

test("resolveClipWindow: non-finite sourceDuration falls back to the full requested fade rather than clamping to 0", () => {
    const window = resolveClipWindow(10, 40, Number.NaN, true, true, 3);
    assert.equal(window.fadeOutSeconds, 3);
    assert.equal(window.effectiveEnd, 43);
});

test("resolveClipWindow: fade-in only (multi-segment interior/last segment never fades in)", () => {
    const window = resolveClipWindow(10, 40, 600, true, false, 3);
    assert.equal(window.fadeInSeconds, 3);
    assert.equal(window.fadeOutSeconds, 0);
    assert.equal(window.effectiveStart, 7);
    assert.equal(window.effectiveEnd, 40);
});

test("resolveClipWindow: fade-out only (multi-segment first/interior segment never fades out)", () => {
    const window = resolveClipWindow(10, 40, 600, false, true, 3);
    assert.equal(window.fadeInSeconds, 0);
    assert.equal(window.fadeOutSeconds, 3);
    assert.equal(window.effectiveStart, 10);
    assert.equal(window.effectiveEnd, 43);
});

// --- buildClipVideoFilter ----------------------------------------------------

const windowWithFade: ClipWindow = {
    effectiveStart: 7,
    effectiveEnd: 43,
    fadeInSeconds: 3,
    fadeOutSeconds: 3,
};

test("buildClipVideoFilter: no captions, fade off -> just format", () => {
    const noFade: ClipWindow = { effectiveStart: 10, effectiveEnd: 40, fadeInSeconds: 0, fadeOutSeconds: 0 };
    assert.equal(buildClipVideoFilter({ window: noFade }), "format=yuv420p");
});

test("buildClipVideoFilter: fade only, exact string", () => {
    assert.equal(
        buildClipVideoFilter({ window: windowWithFade }),
        "fade=t=in:st=0:d=3,fade=t=out:st=33:d=3,format=yuv420p",
    );
});

test("buildClipVideoFilter: asymmetric fade omits the stray side", () => {
    const asymmetric: ClipWindow = { effectiveStart: 8.8, effectiveEnd: 40, fadeInSeconds: 1.2, fadeOutSeconds: 0 };
    assert.equal(
        buildClipVideoFilter({ window: asymmetric }),
        "fade=t=in:st=0:d=1.2,format=yuv420p",
    );
});

test("buildClipVideoFilter: captions and fade together, ass precedes fade (exact string)", () => {
    assert.equal(
        buildClipVideoFilter({ window: windowWithFade, assFilePath: "/tmp/captions.ass" }),
        "ass=/tmp/captions.ass,fade=t=in:st=0:d=3,fade=t=out:st=33:d=3,format=yuv420p",
    );
});

test("buildClipVideoFilter: ass path with special characters is escaped", () => {
    const noFade: ClipWindow = { effectiveStart: 10, effectiveEnd: 40, fadeInSeconds: 0, fadeOutSeconds: 0 };
    assert.equal(
        buildClipVideoFilter({ window: noFade, assFilePath: "C:\\work\\it's.ass" }),
        "ass=C\\:\\\\work\\\\it\\'s.ass,format=yuv420p",
    );
});

// --- buildClipAudioFilter ----------------------------------------------------

test("buildClipAudioFilter: all-zero window returns null", () => {
    const noFade: ClipWindow = { effectiveStart: 10, effectiveEnd: 40, fadeInSeconds: 0, fadeOutSeconds: 0 };
    assert.equal(buildClipAudioFilter(noFade), null);
});

test("buildClipAudioFilter: fade-in only matches the video filter's st=/d=", () => {
    const fadeInOnly: ClipWindow = { effectiveStart: 8.8, effectiveEnd: 40, fadeInSeconds: 1.2, fadeOutSeconds: 0 };
    assert.equal(buildClipAudioFilter(fadeInOnly), "afade=t=in:st=0:d=1.2");
});

test("buildClipAudioFilter: fade-out only matches the video filter's st=/d=", () => {
    const fadeOutOnly: ClipWindow = { effectiveStart: 10, effectiveEnd: 41, fadeInSeconds: 0, fadeOutSeconds: 1 };
    assert.equal(buildClipAudioFilter(fadeOutOnly), "afade=t=out:st=30:d=1");
});

test("buildClipAudioFilter: both sides matches the video filter exactly", () => {
    assert.equal(buildClipAudioFilter(windowWithFade), "afade=t=in:st=0:d=3,afade=t=out:st=33:d=3");
});

process.stdout.write(`\n${passed} clip-filters tests passed\n`);
