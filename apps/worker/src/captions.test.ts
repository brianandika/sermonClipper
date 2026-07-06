// Standalone unit tests for the pure caption/crop helpers. Run with:
//   npm run test --workspace @sermon-clipper/worker
// (which invokes `tsx src/captions.test.ts`). No test framework required.
import assert from "node:assert/strict";
import {
    buildAssFromVtt,
    buildShortVideoFilter,
    CAPTION_MAX_CHARS_PER_LINE,
    chunkCaptions,
    computeShortCrop,
    escapeAssPathForFilter,
    escapeAssText,
    evenFloor,
    formatAssTime,
    normalizeCaptionText,
    parseVttCues,
    parseVttTimestamp,
    wrapCaptionLines,
} from "./captions";

let passed = 0;
function test(name: string, fn: () => void) {
    fn();
    passed += 1;
    process.stdout.write(`  ok - ${name}\n`);
}

const SAMPLE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello world

2
00:00:03.000 --> 00:00:05.500
Second cue spans
two lines

3
00:00:10.000 --> 00:00:12.000
Way outside the window
`;

// --- evenFloor -------------------------------------------------------------
test("evenFloor rounds down to even", () => {
    assert.equal(evenFloor(11), 10);
    assert.equal(evenFloor(10), 10);
    assert.equal(evenFloor(10.9), 10);
    assert.equal(evenFloor(0), 0);
});

// --- computeShortCrop ------------------------------------------------------
test("computeShortCrop on 1920x1080 zoom=1 gives full-height 9:16 window", () => {
    const crop = computeShortCrop(1920, 1080, 1, 0);
    assert.equal(crop.cropH, 1080);
    assert.equal(crop.cropW, evenFloor((1080 * 9) / 16)); // 606
    assert.equal(crop.cropW, 606);
    assert.equal(crop.x, 0);
    assert.equal(crop.y, 0);
});

test("computeShortCrop all dimensions and offsets are even", () => {
    for (const zoom of [1, 1.3, 1.7, 2]) {
        for (const cropX of [0, 0.25, 0.5, 0.75, 1]) {
            const crop = computeShortCrop(1920, 1080, zoom, cropX);
            assert.equal(crop.cropW % 2, 0, `cropW even @ z${zoom} x${cropX}`);
            assert.equal(crop.cropH % 2, 0, `cropH even @ z${zoom} x${cropX}`);
            assert.equal(crop.x % 2, 0, `x even @ z${zoom} x${cropX}`);
            assert.equal(crop.y % 2, 0, `y even @ z${zoom} x${cropX}`);
        }
    }
});

test("computeShortCrop stays within source bounds", () => {
    const crop = computeShortCrop(1920, 1080, 1, 1);
    assert.ok(crop.x + crop.cropW <= 1920, "right edge within width");
    assert.ok(crop.y + crop.cropH <= 1080, "bottom edge within height");
    assert.equal(crop.x, 1920 - crop.cropW, "cropX=1 pins to right edge");
});

test("computeShortCrop zoom>1 tightens the window", () => {
    const wide = computeShortCrop(1920, 1080, 1, 0.5);
    const tight = computeShortCrop(1920, 1080, 2, 0.5);
    assert.ok(tight.cropH < wide.cropH, "zoom reduces crop height");
    assert.ok(tight.cropW < wide.cropW, "zoom reduces crop width");
});

test("computeShortCrop clamps out-of-range zoom and cropX", () => {
    const crop = computeShortCrop(1920, 1080, 0.2, 5);
    assert.equal(crop.cropH, 1080, "zoom<1 treated as 1");
    assert.equal(crop.x, 1920 - crop.cropW, "cropX>1 clamps to 1");
});

// --- parseVttTimestamp -----------------------------------------------------
test("parseVttTimestamp handles HH:MM:SS.mmm and MM:SS.mmm", () => {
    assert.equal(parseVttTimestamp("00:00:01.000"), 1);
    assert.equal(parseVttTimestamp("01:02:03.500"), 3723.5);
    assert.equal(parseVttTimestamp("02:05.250"), 125.25);
    assert.equal(parseVttTimestamp("00:00:10,000"), 10); // comma decimal
    assert.equal(parseVttTimestamp("garbage"), null);
});

// --- parseVttCues ----------------------------------------------------------
test("parseVttCues extracts cues, skipping header and ids", () => {
    const cues = parseVttCues(SAMPLE_VTT);
    assert.equal(cues.length, 3);
    assert.deepEqual(cues[0], { start: 1, end: 3, text: "Hello world" });
    assert.equal(cues[1].text, "Second cue spans\ntwo lines");
});

test("parseVttCues ignores cue settings after end time", () => {
    const cues = parseVttCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% align:center\nHi\n");
    assert.equal(cues.length, 1);
    assert.equal(cues[0].end, 2);
    assert.equal(cues[0].text, "Hi");
});

// --- escapeAssText ---------------------------------------------------------
test("escapeAssText joins lines with \\N and neutralizes braces/tags", () => {
    assert.equal(escapeAssText("line one\nline two"), "line one\\Nline two");
    assert.equal(escapeAssText("a {b} c"), "a (b) c");
    assert.equal(escapeAssText("<c.foo>styled</c> text"), "styled text");
    assert.equal(escapeAssText("   \n  "), "");
});

// --- formatAssTime ---------------------------------------------------------
test("formatAssTime formats centiseconds with rounding carry", () => {
    assert.equal(formatAssTime(0), "0:00:00.00");
    assert.equal(formatAssTime(3723.5), "1:02:03.50");
    assert.equal(formatAssTime(1.999), "0:00:02.00"); // rounds up, carries
    assert.equal(formatAssTime(-5), "0:00:00.00"); // clamped
});

// --- buildAssFromVtt (the bug-prone one) -----------------------------------
test("buildAssFromVtt slices to window and rebases to zero", () => {
    // Window [2, 4]: cue1 (1-3) overlaps -> [0, 1]; cue2 (3-5.5) overlaps -> [1, 2];
    // cue3 (10-12) dropped.
    const { content, cueCount } = buildAssFromVtt(SAMPLE_VTT, 2, 4);
    assert.equal(cueCount, 2);
    // Captions are burned in uppercase; short cues stay a single caption.
    assert.match(content, /Dialogue: 0,0:00:00\.00,0:00:01\.00,Default,,0,0,0,,HELLO WORLD/);
    assert.match(content, /Dialogue: 0,0:00:01\.00,0:00:02\.00,Default,,0,0,0,,SECOND CUE SPANS TWO\\NLINES/);
    assert.doesNotMatch(content, /Way outside/i);
});

test("buildAssFromVtt drops cues that touch only at the boundary", () => {
    // cue ending exactly at clipStart, and cue starting exactly at clipEnd.
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nBefore\n\n00:00:04.000 --> 00:00:06.000\nAfter\n";
    const { cueCount } = buildAssFromVtt(vtt, 2, 4);
    assert.equal(cueCount, 0);
});

test("buildAssFromVtt with no cues in range still yields a valid header", () => {
    const { content, cueCount } = buildAssFromVtt(SAMPLE_VTT, 100, 200);
    assert.equal(cueCount, 0);
    assert.match(content, /\[Events\]/);
    assert.doesNotMatch(content, /Dialogue:/);
});

// --- caption chunking (never exceed 2 lines) --------------------------------
test("normalizeCaptionText flattens, strips tags, uppercases", () => {
    assert.equal(normalizeCaptionText("Hello   world\nagain"), "HELLO WORLD AGAIN");
    assert.equal(normalizeCaptionText("<c>styled</c> {x}"), "STYLED (X)");
});

test("wrapCaptionLines never exceeds the per-line budget", () => {
    const lines = wrapCaptionLines(
        "WHICH IS THAT GOD FREES US IN CHRIST TO LIVE GODLY LIVES",
        CAPTION_MAX_CHARS_PER_LINE,
    );
    for (const line of lines) {
        assert.ok(line.length <= CAPTION_MAX_CHARS_PER_LINE, `"${line}" within budget`);
    }
});

test("chunkCaptions caps every caption at 2 lines", () => {
    const chunks = chunkCaptions(
        "WHICH IS THAT GOD FREES US IN CHRIST TO LIVE GODLY LIVES OF SELF CONTROL AND INTENTIONALITY FOR HIM",
    );
    assert.ok(chunks.length >= 3, "long sentence splits into several captions");
    for (const chunk of chunks) {
        const lineCount = chunk.split("\\N").length;
        assert.ok(lineCount <= 2, `caption has ${lineCount} lines (<=2)`);
    }
});

test("buildAssFromVtt splits a long cue into multiple ≤2-line captions timed in order", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:09.000\n"
        + "which is that God frees us in Christ to live godly lives of self control and intentionality for him\n";
    const { content, cueCount } = buildAssFromVtt(vtt, 0, 9);
    assert.ok(cueCount >= 3, "long cue becomes several captions");

    const dialogues = content.split("\n").filter((line) => line.startsWith("Dialogue:"));
    let prevEnd = -1;
    for (const line of dialogues) {
        const text = line.split(",,")[1] ?? "";
        assert.ok(text.split("\\N").length <= 2, "no caption exceeds 2 lines");
        // times ascend and don't overlap
        const [, startRaw, endRaw] = line.match(/Dialogue: 0,([^,]+),([^,]+),/) ?? [];
        const toSec = (t: string) => {
            const [h, m, s] = t.split(":");
            return Number(h) * 3600 + Number(m) * 60 + Number.parseFloat(s);
        };
        const s = toSec(startRaw);
        const e = toSec(endRaw);
        assert.ok(s >= prevEnd - 1e-6, "captions do not overlap");
        assert.ok(e > s, "caption has positive duration");
        prevEnd = e;
    }
});

// --- escapeAssPathForFilter / buildShortVideoFilter ------------------------
test("escapeAssPathForFilter escapes filtergraph-special characters", () => {
    assert.equal(escapeAssPathForFilter("/work/a b/captions.ass"), "/work/a b/captions.ass");
    assert.equal(escapeAssPathForFilter("C:\\x\\y.ass"), "C\\:\\\\x\\\\y.ass");
});

test("buildShortVideoFilter assembles crop/scale/setsar with optional captions", () => {
    const crop = computeShortCrop(1920, 1080, 1, 0.5);
    assert.equal(
        buildShortVideoFilter(crop),
        `crop=${crop.cropW}:${crop.cropH}:${crop.x}:${crop.y},scale=1080:1920,setsar=1`,
    );
    assert.equal(
        buildShortVideoFilter(crop, "/w/captions.ass"),
        `crop=${crop.cropW}:${crop.cropH}:${crop.x}:${crop.y},scale=1080:1920,setsar=1,ass=/w/captions.ass`,
    );
});

process.stdout.write(`\n${passed} caption tests passed\n`);
