# Plan: a third clipping mode — general-purpose "Clip"

> **Audience:** an engineer (or Sonnet 5) executing this end to end. Everything needed is in
> this document — file paths, anchors, and the exact snippets for the fiddly parts. You should
> not need to explore the repo to start.

## Context

Sermon Clipper has three job kinds today, discriminated by `payloadJson.kind`
(`packages/shared/src/index.ts:113`):

| kind | pipeline | output |
| --- | --- | --- |
| `sermon` (default when absent) | `processClipJob` — multi-segment trim, intro still, xfade transitions, two-pass loudnorm, Whisper at the end, SermonGuide delivery | MP3 + 1920×1080 MP4 + VTT |
| `transcribeSource` | `processTranscribeSourceJob` — extract audio → Whisper → write `Asset.transcriptPath` | VTT only, no `Result` row |
| `short` | `processShortJob` — single-pass crop to 9:16, scale 1080×1920, optional burned captions, optional end card | one MP4 |

**Goal:** a fourth kind, `clip` — a *general-purpose* clipper for anything that is neither a
sermon upload nor a vertical short. Primary real-world use: a video a pastor or presider wants
played mid-service (a missions update, a testimony, a movie excerpt).

### Requirements (from the user)

1. Trim an arbitrary video to `[startTime, endTime]`, **keeping the source aspect ratio** — no
   9:16 crop, no forced 1920×1080 pad, no 3-minute cap, no MP3, no end card, no SermonGuide
   delivery.
2. **Toggle: 3-second fade in / fade out, both to black** (video *and* audio) — and critically,
   **the fade adds 3 seconds to the front and 3 seconds to the back of the output**. The
   marked `[startTime, endTime]` selection is not shortened or dimmed to make room for the
   fade; the output is *longer* than the marked selection when this is on. See "Design: how
   the fade actually works" below — this is not a cosmetic detail, it changes the ffmpeg
   trim window itself and therefore the caption math.
3. **Toggle: burn in the transcript as standard subtitles.** When on, the transcript must be
   produced *first*, the human reviews and edits it, and only then is the video rendered.

### Answering the user's sequencing question

> "…the transcript should be created first, then give the human the option to review and edit
> the transcript before it's burned in, and then the video should be created after the
> transcript is available, right?"

**Yes — and the repo already has all three pieces**, so this is a *gating* problem, not new
infrastructure:

- **create** — `kind: "transcribeSource"` job → writes `Asset.transcriptPath`
  (`apps/worker/src/main.ts:1760`). Already idempotent: `jobs.service.ts:107` returns the
  in-flight job instead of queuing a duplicate.
- **review & edit** — `PUT /assets/:assetId/transcript` (`assets.controller.ts:176`, body
  `UpdateTranscriptRequest { cues }`) rewrites the VTT in place, and `ShortsFlow.tsx:920-951`
  already renders a per-cue editing list against it.
- **burn** — `buildAssFromVtt(vtt, clipStart, clipEnd)` slices + rebases cues to the clip window
  and `buildShortVideoFilter` appends `ass=<path>` to the filter chain
  (`apps/worker/src/captions.ts:270,373`).

The one behavioural difference from Shorts: there, captions are **best-effort** — a missing
transcript silently degrades to a caption-less encode (`main.ts:1913-1928`). For `clip`, the
subtitle toggle is **blocking**: the export button stays disabled until a transcript exists and
the user has been shown the editor.

### Design: how the fade actually works, and why captions must move with it

**The fade is not an overlay that dims the marked clip's own first/last 3 seconds.** It widens
the ffmpeg *read window* by up to 3 seconds on each side, pulling in real, adjacent footage
from the source that sits just before `startTime` and just after `endTime`, and fades *that*
newly-included footage from/to black. The marked `[startTime, endTime]` selection itself plays
at full brightness and volume the entire time, completely untouched. Concretely:

```
source timeline:  ...──────┼───────────────────────┼──────...
                            startTime               endTime
output timeline:  ┊fade-in┊  ← marked selection →  ┊fade-out┊
                   (≤3s, from                        (≤3s, to
                    black)                            black)
```

- `fadeInSeconds = min(3, startTime)` — clamped so we never ask ffmpeg to read before the
  source begins. If the marked clip starts at `startTime = 1.2`, the fade-in is only 1.2s.
- `fadeOutSeconds = min(3, sourceDuration - endTime)` — clamped symmetrically against the tail.
- The actual ffmpeg trim becomes `[startTime - fadeInSeconds, endTime + fadeOutSeconds]`, i.e.
  **longer** than the marked selection by `fadeInSeconds + fadeOutSeconds` — up to 6 seconds
  total. This is what "adds 3 seconds to the front and back" means concretely: those seconds
  are pulled from real, already-existing source footage the user didn't explicitly mark, not
  synthesized black frames or a frozen still.
- If `fade` is off, none of this applies — the trim is `[startTime, endTime]` exactly, as in
  every other job kind.

**Why this is simpler than the alternatives, not just "the ask":** the fade curve is applied
with the exact same `fade`/`afade` filters already used elsewhere in this file
(`renderAudioArtifact`, `renderSegmentsWithTransitions`) over the *edges of the widened read
window* — no new filter type, no synthetic color source, no frozen-frame trick. A rejected
alternative and why: freezing the first/last frame as a still image during a synthesized pad
(`tpad=mode=clone`) keeps the marked selection undimmed, but it means the fade shows a static
image instead of real motion, introduces a filter this codebase has never used, and has the
odd side effect of a caption freezing motionless for 3 seconds if one happened to be active at
the very edge. Widening the read window needs none of that, and shows genuine motion during
the fade.

**This is exactly why caption timing must change.** `buildAssFromVtt(vtt, clipStart, clipEnd)`
slices the transcript to a window and rebases it so the window's start becomes `t = 0`. Once
the actual ffmpeg trim starts at `startTime - fadeInSeconds` instead of `startTime`, that must
also be the window `buildAssFromVtt` rebases against — **`clipStart` for the caption call has
to be `effectiveStart`, not `request.startTime`.** Get this wrong (keep rebasing against
`request.startTime` while the encode itself starts `fadeInSeconds` earlier) and every caption
lands `fadeInSeconds` too early relative to what's on screen — worse the more fade-in was
actually applied. §3b-i works through this precisely and pins it with a test.

### Decision: transcribe the whole source, not just the clip window

v1 reuses the existing `transcribeSource` job unchanged. Cost: checking "burn in subtitles" on
a 90-minute upload transcribes all 90 minutes even for a 2-minute clip. Benefit: **zero** new
transcription code, and the transcript dedups with the Shorts flow and the existing edit
endpoint (which writes to `Asset.transcriptPath`). A windowed transcribe would need a separate
storage path, a separate fetch/edit endpoint, and new dedup semantics — out of scope. Surface
the latency in the UI copy instead ("this runs once for this video and can take a while on
long recordings"). Revisit if it hurts in practice.

### Design principle

Same as the shorts plan: reuse everything. Net new surface is **one** `JobKind` value, **three**
payload fields, **one** API route, **one** worker pipeline, **one** pure filter module, and
**one** frontend flow. No schema migration, no new queue, no new table.

---

## Step 0 — orientation (read these, nothing else)

- `packages/shared/src/index.ts` (whole file, 190 lines)
- `apps/worker/src/main.ts:1854-2121` — `processShortJob` + `dispatchJob`. **`processShortJob`
  is the template for the new pipeline.**
- `apps/worker/src/main.ts:489-507` — `detectOutputDuration`, reused in §4 to probe the
  *source's* duration (needed to clamp fade-out), despite its output-sounding name.
- `apps/worker/src/captions.ts:240-378` — ASS header, `buildAssFromVtt`, `buildShortVideoFilter`
- `apps/web/src/components/ShortsFlow.tsx:472-560, 700-760, 869-951` — phase machine, transcript
  editor handlers, transcript editor markup
- **Read §"Design: how the fade actually works" and §3b-i in full before writing any
  `clip-filters.ts` code.** The fade widens the read window outward (real adjacent source
  footage, faded from/to black) rather than dimming the marked selection's own edges — get
  this backwards and captions will desync from the picture by up to 3 seconds whenever fade
  is also on.

---

## Step 1 — shared types

**`packages/shared/src/index.ts`**

```ts
// Seconds of fade-to-black requested at each end of a general clip when `fade`
// is on. The actual applied fade is clamped per edge by how much real source
// footage exists before startTime / after endTime — see
// apps/worker/src/clip-filters.ts.
export const CLIP_FADE_SECONDS = 3;

export type JobKind = "sermon" | "transcribeSource" | "short" | "clip";
```

Extend `CreateJobRequest` (keep the existing comment style — say which kind each field is for):

```ts
    // "clip" only: extend the output by up to CLIP_FADE_SECONDS on each end,
    // pulling in adjacent source footage and fading it from/to black. The
    // marked [startTime, endTime] itself is never dimmed or shortened. Default
    // false. Each side is independently clamped to whatever real footage
    // exists before startTime / after endTime.
    fade?: boolean;
```

`captions?: boolean` already exists. Document its per-kind default there:

```ts
    // "short": burn captions unless explicitly false (best-effort — degrades to
    // no captions). "clip": burn captions only when explicitly true, and the API
    // rejects the job if the asset has no transcript.
    captions?: boolean;
```

`title`, `outputVideoFilename`, `startTime`, `endTime`, `hardware` are reused as-is.

**`apps/web/src/types.ts`** — mirror: add `'clip'` to the local `JobKind` union (line 22) and
`fade?: boolean` to `Job['payload']`.

---

## Step 2 — API

**`apps/api/src/jobs/create-job.dto.ts`**

- `JOB_KINDS` (line 18) → `["sermon", "transcribeSource", "short", "clip"]`.
- Add:

```ts
    // "clip" only: 3s fade to/from black at each end.
    @IsOptional()
    @IsBoolean()
    fade?: boolean;
```

- `startTime`/`endTime` already validate for every kind except `transcribeSource`, so `clip`
  is covered with no change.

**`apps/api/src/jobs/jobs.service.ts`**

Add a validator next to `validateShortRange` (the file-level helpers above the class):

```ts
// A general clip only needs a positive, ordered range — no length cap (unlike a
// short) and no multi-segment clip list (unlike a sermon).
function validateGeneralClipRange(payload: CreateJobDto) {
    if (!Number.isFinite(payload.startTime) || !Number.isFinite(payload.endTime)) {
        throw new BadRequestException("startTime and endTime are required");
    }
    if (payload.startTime < 0) {
        throw new BadRequestException("startTime must be >= 0");
    }
    if (payload.startTime >= payload.endTime) {
        throw new BadRequestException("startTime must be less than endTime");
    }
}
```

In `create()` (the branch at line 131), add:

```ts
        else if (kind === "clip") {
            validateGeneralClipRange(payload);

            // Burned-in subtitles are blocking for this kind: the transcript must
            // already exist (and have been reviewed) before we render.
            if (payload.captions === true) {
                const asset = await this.prisma.asset.findFirst({
                    where: { id: assetId, sessionId },
                    select: { transcriptPath: true },
                });
                if (!asset?.transcriptPath) {
                    throw new BadRequestException(
                        "Burning in subtitles requires a transcript. Prepare and review the transcript first.",
                    );
                }
            }
        }
```

Generalise the saved-jobs query (line 252) so the new flow can list its own exports:

```ts
    async listJobsForAssetByKind(sessionId: string, assetId: string, kind: JobKind) {
        return this.prisma.job.findMany({
            where: { sessionId, assetId, payloadJson: { path: ["kind"], equals: kind } },
            include: { progress: true, result: true },
            orderBy: { createdAt: "desc" },
        });
    }

    async listShortsForAsset(sessionId: string, assetId: string) {
        return this.listJobsForAssetByKind(sessionId, assetId, "short");
    }
```

Add `type JobKind` to the existing `@sermon-clipper/shared` import block at the top of the file.

**`apps/api/src/jobs/jobs.controller.ts`** — add directly below `listShortsForAsset` (line 55):

```ts
    @Get("clips/:assetId")
    async listClipsForAsset(
        @Req() request: Request,
        @Param("assetId") assetId: string,
    ): Promise<JobResponse[]> {
        const session = await this.sessionService.requireSession(request.cookies?.[SESSION_COOKIE_NAME]);
        await this.assetsService.getOwnedAsset(session.id, assetId);
        const jobs = await this.jobsService.listJobsForAssetByKind(session.id, assetId, "clip");
        return jobs.map((job) => this.jobsService.toResponse(job));
    }
```

> Route ordering matters in Nest: `clips/:assetId` must be declared **before** `:jobId`
> (line 65), same as `shorts/:assetId` already is.

Queue routing needs no change — `clip` encodes video, so it should follow the hardware
resolution like `sermon`/`short` (`jobs.service.ts:143` only special-cases `transcribeSource`).

---

## Step 3 — worker: pure helpers (new, unit-tested)

### 3a. Parameterise the ASS style

`captions.ts:241-259` hardcodes `PlayResX: 1080 / PlayResY: 1920 / Fontsize 64 / MarginV 560` —
tuned for a vertical 1080×1920 frame. A landscape clip needs its own geometry.

Refactor `ASS_HEADER` into a function, **keeping the vertical numbers as the default so shorts
output is byte-identical** (`captions.test.ts` must stay green):

```ts
export interface AssStyleOptions {
    playResX: number;
    playResY: number;
    fontSize: number;
    marginLR: number;
    marginV: number;
}

// The existing shorts look: 1080x1920, 64pt, bottom third.
export const SHORT_CAPTION_STYLE: AssStyleOptions = {
    playResX: 1080, playResY: 1920, fontSize: 64, marginLR: 90, marginV: 560,
};

// Standard subtitles for a landscape clip at the source's own resolution: text
// sized as a fraction of frame height so it reads the same on 720p and 4K, and
// sat just above the bottom edge like conventional burned-in subs.
export function landscapeCaptionStyle(width: number, height: number): AssStyleOptions {
    return {
        playResX: Math.max(2, Math.round(width)),
        playResY: Math.max(2, Math.round(height)),
        fontSize: Math.max(16, Math.round(height * 0.05)),
        marginLR: Math.round(width * 0.06),
        marginV: Math.round(height * 0.06),
    };
}

function buildAssHeader(style: AssStyleOptions): string { /* the existing ASS_HEADER lines,
    with playResX/playResY/fontSize/marginLR/marginV interpolated into the
    "PlayResX:", "PlayResY:" and "Style: Default,..." lines */ }
```

Then widen the signature (fourth arg optional, defaults to the shorts style):

```ts
export function buildAssFromVtt(
    vtt: string,
    clipStart: number,
    clipEnd: number,
    style: AssStyleOptions = SHORT_CAPTION_STYLE,
): AssBuildResult
```

Note `chunkCaptions`/`normalizeCaptionText` uppercase and wrap at
`CAPTION_MAX_CHARS_PER_LINE = 22` — right for punchy vertical shorts, wrong for standard
subtitles on a wide frame. Add an optional `maxCharsPerLine` to the chunking path and pass
`42` for landscape; leave the default at 22.

> Do **not** change the uppercase behaviour globally. If it also reads badly for standard
> subtitles, add an `uppercase: boolean` to `AssStyleOptions` (`true` for shorts, `false` for
> landscape) and gate `normalizeCaptionText` on it. Recommended.

### 3b. New module `apps/worker/src/clip-filters.ts`

```ts
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
// should come from a fresh ffprobe of the source file (see §4), not a
// possibly-stale Asset.duration column.
// fadeSeconds is the caller-supplied requested length (the worker passes
// CLIP_FADE_SECONDS from @sermon-clipper/shared — this module intentionally
// takes it as a plain argument rather than importing shared, so it stays a
// trivially unit-testable pure function with no dependency graph).
export function resolveClipWindow(
    startTime: number,
    endTime: number,
    sourceDuration: number,
    fadeRequested: boolean,
    fadeSeconds: number,
): ClipWindow {
    if (!fadeRequested || !(fadeSeconds > 0)) {
        return { effectiveStart: startTime, effectiveEnd: endTime, fadeInSeconds: 0, fadeOutSeconds: 0 };
    }

    const fadeInSeconds = Math.max(0, Math.min(fadeSeconds, startTime));
    const availableAfter = Number.isFinite(sourceDuration) ? Math.max(0, sourceDuration - endTime) : fadeSeconds;
    const fadeOutSeconds = Math.max(0, Math.min(fadeSeconds, availableAfter));

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
// `ass` filter would leave the subtitles fully opaque over a black frame. See
// "Fade + subtitles interaction" below — this is a load-bearing invariant, not
// a style preference; do not reorder these two even for a "cleanup".
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
```

**Why fade-in and fade-out can never overlap here (no `duration/2` clamp needed):** unlike an
overlay design, fade-in only ever touches the *widened pre-roll* (up to `startTime` in the
effective window) and fade-out only ever touches the *widened post-roll* (from `endTime`
onward) — two disjoint regions with the entire marked selection sitting untouched between them.
There is no "clip too short, fades collide" case to guard against; the only clamp needed is per
edge against `resolveClipWindow`'s own available-footage limit, already handled above.

**Why `st` is relative to 0:** the pipeline seeks with `-ss effectiveStart` *before* `-i`, which
rebases output timestamps to zero — so `st=0` for fade-in and `st=effectiveDuration -
fadeOutSeconds` for fade-out are both correct in the *effective* (widened) timeline.
`processShortJob`'s end-card `xfade` already relies on the same `-ss`-before-`-i` rebasing
invariant (`offset = duration - fade`).

### 3b-i. Fade + subtitles interaction — the caption window MUST widen too

This is the exact risk to get right before writing any code, and the reason `resolveClipWindow`
exists as a separate, independently-tested function rather than being inlined into the pipeline.

**The rule: everywhere a caller currently plans to pass `request.startTime`/`request.endTime`
into `buildAssFromVtt`, it must pass `window.effectiveStart`/`window.effectiveEnd` instead** —
not the marked selection, the *widened* one that `resolveClipWindow` computed. Two independent
facts explain why:

1. **The ffmpeg trim itself now starts at `effectiveStart`, not `startTime`.** `-ss
   effectiveStart -i source` rebases frame 0 of the encoded stream to `effectiveStart` in
   source time. If captions are still sliced/rebased against `startTime` (the *marked* point,
   which is `fadeInSeconds` seconds *later* than `effectiveStart` whenever fade actually
   applied), every caption comes out `fadeInSeconds` too early relative to the picture — the
   words won't match the speaker's mouth by up to 3 seconds. This is a real, silent-until-you-
   watch-it bug, not a theoretical one: it only shows up when fade is also on, so a build/test
   pass that never combines the two toggles would ship it undetected.
2. **Filter order still makes the fade apply *to* the burned-in text, not sit behind it.**
   `ass=` must come before both `fade=` filters in `buildClipVideoFilter` (enforced above).
   FFmpeg's `fade` filter dims whatever pixels already exist in the chain at that point — since
   `ass=` has already baked the subtitle text into the frame, `fade` dims the text along with
   the picture in the newly-widened pre/post-roll. This part is unchanged from the original
   (overlay) design and is still worth guarding with a test, but it is the *second-order*
   concern here — get the window right first.

**Concretely, in §4's pipeline:** compute `window = resolveClipWindow(...)` once, early, then
use `window.effectiveStart`/`window.effectiveEnd` for **both** the `buildAssFromVtt(...)` call
**and** the ffmpeg `-ss`/`-t` arguments. Never let these two derive from different variables —
that divergence *is* the bug. §3d's tests assert this window math directly (no ffmpeg needed to
catch it), and the manual verification steps require watching a caption that sits right at the
marked `startTime` boundary with fade on, specifically to catch a regression here.

**Known, intentional side effect:** a caption line that falls inside the widened fade-in/
fade-out region will dim/brighten with the picture rather than staying full-brightness — that
matches how burned-in subtitles behave under a fade in any conventional video editor. Not a
defect and needs no special-casing.

### 3c. `MediaProperties.hasAudio`

`detectMediaProperties` (`main.ts:509`) already looks up `audioStream` but discards whether it
exists, and the catch-all fallback assumes stereo. Add `hasAudio: boolean` to the
`MediaProperties` interface (line 34), set it to `audioStream !== undefined` in the try branch
and `true` in the fallback (preserving today's behaviour for every existing caller). The clip
pipeline uses it to decide between `-c:a aac` and `-an`, and to skip `-af`.

### 3d. Tests — `apps/worker/src/clip-filters.test.ts`

Follow `captions.test.ts` exactly: `node:assert/strict`, plain top-level asserts, no framework.
This is the file that has to catch a caption-window regression *without* running ffmpeg, so
weight it toward `resolveClipWindow`. Cover:

**`resolveClipWindow`** (the load-bearing one — see §3b-i):
- Fade off → `{ effectiveStart: startTime, effectiveEnd: endTime, fadeInSeconds: 0,
  fadeOutSeconds: 0 }` regardless of `sourceDuration`, for `resolveClipWindow(10, 40, 600,
  false, 3)`.
- Plenty of room on both sides → `resolveClipWindow(10, 40, 600, true, 3)` gives
  `effectiveStart: 7`, `effectiveEnd: 43`, `fadeInSeconds: 3`, `fadeOutSeconds: 3`. **Assert
  `effectiveEnd - effectiveStart === 36` (30 marked + 6 fade)** — this is the exact number a
  copy-paste-from-the-old-design mistake would get wrong.
- Starts at the very beginning of the source → `resolveClipWindow(1.2, 40, 600, true, 3)` gives
  `fadeInSeconds: 1.2`, `effectiveStart: 0` (clamped, not `-1.8`).
- Ends at the very end of the source → `resolveClipWindow(10, 599, 600, true, 3)` gives
  `fadeOutSeconds: 1`, `effectiveEnd: 600`.
- Marked selection covers the entire source → `resolveClipWindow(0, 600, 600, true, 3)` gives
  `fadeInSeconds: 0` and `fadeOutSeconds: 0` (nothing on either side to fade with) — must not
  throw or go negative.
- `sourceDuration` is `NaN`/non-finite (probe failed) → `fadeOutSeconds` falls back to the
  full requested `fadeSeconds` rather than clamping to 0 or throwing (optimistic, matches the
  fallback chain in §4 — ffmpeg will naturally stop at real EOF if this over-estimates).

**`buildClipVideoFilter`** (given a `ClipWindow`, from `resolveClipWindow` or built inline in
the test):
- No captions, fade off (`fadeInSeconds: 0, fadeOutSeconds: 0`) → exactly `"format=yuv420p"`.
- Fade only, `effectiveStart=7, effectiveEnd=43, fadeInSeconds=3, fadeOutSeconds=3` (36s
  effective duration) → exactly `fade=t=in:st=0:d=3,fade=t=out:st=33:d=3,format=yuv420p`.
- Asymmetric fade (`fadeInSeconds=1.2, fadeOutSeconds=0`, effective duration 38.8) → exactly
  `fade=t=in:st=0:d=1.2,format=yuv420p` — **no stray `fade=t=out` when that side clamped to 0.**
- Captions **and** fade → exact string via a full `assert.equal`, not a substring check:
  `ass=/tmp/captions.ass,fade=t=in:st=0:d=3,fade=t=out:st=33:d=3,format=yuv420p`. This is the
  test that would catch someone "cleaning up" the filter order in §3b-i and silently breaking
  captions-under-fade.
- A path containing `:` and `'` is escaped in the `ass=` value.

**`buildClipAudioFilter`**:
- All-zero window → `null`.
- Matches the video filter's fade-in/out `st=`/`d=` values for the same window (fade-in only,
  fade-out only, and both), confirming audio and video never drift apart.

Add to `apps/worker/package.json`:

```json
"test": "tsx src/captions.test.ts && tsx src/clip-filters.test.ts"
```

Also extend `captions.test.ts` with a `landscapeCaptionStyle` case asserting the emitted header
carries the passed `PlayResX/PlayResY`, and one asserting the **default** call still emits
`PlayResX: 1080` / `PlayResY: 1920` / `Fontsize 64` (the regression guard for shorts).

---

## Step 4 — worker pipeline: `processGeneralClipJob`

New function in `apps/worker/src/main.ts`, placed after `processShortJob` (~line 2098). Copy
`processShortJob`'s skeleton — the cancellation watcher, `enqueueProgressWrite` calls, the
single `Result` upsert + `ProcessingArtifact` at completion — and change the middle.

```ts
// clip: the general-purpose pipeline. Trim [startTime, endTime] keeping the
// source's own resolution and aspect ratio, optionally burn standard subtitles
// from the (already reviewed) asset transcript, and optionally fade to and from
// black at both ends. One MP4, no MP3, no end card, no SermonGuide delivery.
async function processGeneralClipJob(payload: ClipProcessJobData) {
```

Body, in order:

1. Load job + asset, read `request = job.payloadJson as unknown as CreateJobRequest`.
2. `const markedDuration = getDurationSeconds(request.startTime, request.endTime)`; throw if
   `!Number.isFinite(markedDuration) || markedDuration <= 0`. This validates the *marked*
   selection only — the effective (possibly fade-widened) window is computed next.
3. `const effectiveHardware = job.effectiveHardware ?? (job.requestedHardware ?? HardwareOption.auto)`.
4. `jobRoot = getJobRoot(job.sessionId, job.id)`;
   `outputVideoFilename = sanitizeOutputFilename(request.outputVideoFilename, ".mp4", "clip-video")`;
   `assFilePath = join(jobRoot, "captions.ass")`; `await mkdir(jobRoot, { recursive: true })`.
5. First `enqueueProgressWrite`: `status: preparing`, `stage: JobStage.extractClips`,
   `overallProgress: 5`, `message: "Preparing clip"`.
6. `const media = await detectMediaProperties(job.id, job.asset.sourcePath)`.
7. **Resolve the clip window — do this before anything else touches start/end times.** Probe
   the source's real duration fresh (don't trust a possibly-stale `Asset.duration` column —
   `detectOutputDuration` is a generic ffprobe-duration helper despite its name; it works
   identically against any media path, not just a job's own output):

```ts
        const sourceDuration = (await detectOutputDuration(job.id, job.asset.sourcePath))
            ?? job.asset.duration
            ?? request.endTime;

        const window = resolveClipWindow(
            request.startTime,
            request.endTime,
            sourceDuration,
            request.fade === true,
            CLIP_FADE_SECONDS,
        );
        const effectiveDuration = window.effectiveEnd - window.effectiveStart;
        const fadeNote = request.fade === true && window.fadeInSeconds === 0 && window.fadeOutSeconds === 0
            ? "fade skipped: not enough surrounding footage"
            : "";
```

   `window.effectiveStart`/`window.effectiveEnd` are now the single source of truth for *both*
   the ffmpeg trim and the caption slice — see §3b-i. Do not let any later step recompute or
   re-derive a start/end from `request.startTime`/`request.endTime` directly; thread `window`
   through instead.

8. Captions — **note the inverted default vs shorts** (`=== true`, not `!== false`), a
   **fatal** failure rather than a silent degrade (the API already promised the transcript
   exists), and **sliced against the widened window, not the marked one**:

```ts
        let captionsApplied = false;
        if (request.captions === true) {
            if (!(await canBurnCaptions())) {
                throw new Error("Cannot burn in subtitles: this worker's FFmpeg has no libass support");
            }
            if (!job.asset.transcriptPath || !existsSync(job.asset.transcriptPath)) {
                throw new Error("Cannot burn in subtitles: the source has no transcript");
            }
            const vtt = await readFile(job.asset.transcriptPath, "utf8");
            const ass = buildAssFromVtt(
                vtt,
                window.effectiveStart,   // NOT request.startTime — see §3b-i
                window.effectiveEnd,     // NOT request.endTime — see §3b-i
                landscapeCaptionStyle(media.width, media.height),
            );
            if (ass.cueCount === 0) {
                throw new Error("Cannot burn in subtitles: the transcript has no lines in this range");
            }
            await writeFile(assFilePath, ass.content);
            captionsApplied = true;
        }
```

9. Filters, built purely from `window` (no separate fade-seconds variable to keep in sync):

```ts
        const videoFilter = buildClipVideoFilter({
            window,
            assFilePath: captionsApplied ? assFilePath : undefined,
        });
        const audioFilter = media.hasAudio ? buildClipAudioFilter(window) : null;
```

10. `enqueueProgressWrite`: `status: encoding_video`, `stage: JobStage.encodeVideo`,
    `overallProgress: 15`, `videoProgress: 5`, message reflecting captions/fade/`fadeNote`.
11. Encode, in a `try { ... } finally { await rm(assFilePath, { force: true }); }` — **`-ss`
    and `-t` now come from the widened window, not the marked one**:

```ts
            await runFfmpeg(job.id, [
                "-hide_banner",
                "-y",
                "-ss", String(window.effectiveStart),
                "-i", job.asset.sourcePath,
                "-t", String(effectiveDuration),
                "-vf", videoFilter,
                ...(audioFilter ? ["-af", audioFilter] : []),
                ...getVideoEncodingArgs(effectiveHardware),
                ...(media.hasAudio ? ["-c:a", "aac"] : ["-an"]),
                "-movflags", "+faststart",
                outputVideoPath,
            ], {
                totalDurationSec: effectiveDuration,
                onProgress: createBandReporter(job.id, "videoProgress", 5, 100),
            });
```

12. `assertJobNotCanceled`, `stat`, `detectOutputDuration` (on the *output* this time — reports
    the true final length, `effectiveDuration` when fade widened it), `expiresAt` from
    `runtimeEnv.resultTtlDays` — then the same `prisma.$transaction([result.upsert(...),
    processingArtifact.create({ type: "video", ... })])` as `processShortJob:2049-2077`.
    Video-only: leave `audioPath` / `manifestPath` null.
13. Final `enqueueProgressWrite`: `completed`, `JobStage.complete`, all progress 100, message
    `"Clip ready"` (append `fadeNote` in parens if set, mirroring `processShortJob`'s
    `captionNote`/`endCardNote` pattern at `main.ts:2088-2091`).
14. `finally { stopJobCancellationWatcher(...); progressWriteChains.delete(...); }`.

**`dispatchJob` (line 2102)** — add before the `sermon` fallthrough:

```ts
    if (kind === "clip") {
        await processGeneralClipJob(payload);
        return;
    }
```

---

## Step 5 — frontend API wrappers

**`apps/web/src/api.ts`** — next to `createShortJob` (line 137):

```ts
// Create one general-purpose clip (source aspect ratio preserved) with optional
// fade-to-black at both ends and optional burned-in subtitles.
export const createClipJob = async (params: {
  assetId: string;
  startTime: number;
  endTime: number;
  fade: boolean;
  captions: boolean;
  title?: string;
  outputVideoFilename?: string;
}): Promise<Job> => {
  const { data } = await api.post('/jobs', { kind: 'clip', ...params });
  return data;
};

// All persisted general clips for a source asset (newest first).
export const getClipsForAsset = async (assetId: string): Promise<Job[]> => {
  const { data } = await api.get(`/jobs/clips/${assetId}`);
  return data;
};
```

`createTranscribeJob`, `getAssetTranscriptText`, `updateAssetTranscript`, `getAsset`,
`getResultArtifact`, `pollJob` are all reused unchanged.

---

## Step 6 — frontend: `apps/web/src/components/ClipFlow.tsx` (new)

Props: `{ source: Asset; onSourceChange: (asset: Asset) => void; prepJobId: string | null;
onPrepJobId: (id: string | null) => void }` — the same lifted-state shape as `ShortsFlow`, so
switching tabs never remounts and re-fires a transcription.

Lift the same helpers verbatim from `ShortsFlow.tsx`: `parseVtt` (85), `parseTimestamp` (77),
`formatTimecode` (110), `slugify` (128), `axiosErrorMessage` (120). If duplicating them a third
time feels wrong, extract to `apps/web/src/lib/vtt.ts` and import from both — but do that as a
separate, mechanical commit so this feature's diff stays readable.

### State

```
start, end            (numbers, seconds — seeded 0 .. source.duration)
fade                  (boolean, default false)
burnSubtitles         (boolean, default false)
title                 (string)
cues, cuesError
editingTranscript, draftCues, savingTranscript, transcriptSaveError
prepMessage, prepError
exporting, exportError, savedClips (Job[])
```

### Flow

1. **Always show the editor.** A `<video src={getAssetSourceUrl(source.assetId)} controls>`
   plus "Set in / Set out" number inputs — copy the range-row pattern from `EditorFlow.tsx`
   (and its "use the player's current time" buttons). Show the resulting clip length.
2. **Fade checkbox** — label: *"Fade in and out (3 seconds, to black)"*, helper text:
   *"Adds up to 3 seconds before and after your selection, using a bit of the surrounding
   footage. Your trimmed clip itself isn't shortened or dimmed."* Near the in/out points,
   show the resulting total output length (marked length + up to 6s), not just the marked
   length, so the extra time isn't a surprise on download. If `startTime` or
   `sourceDuration - endTime` is under 3 seconds, say so inline (*"only ~1.2s of fade-in
   available here"*) rather than silently applying less than requested — mirrors
   `resolveClipWindow`'s per-edge clamp (§3b) so the UI never promises more than the worker
   will deliver.
3. **Subtitles checkbox** — *"Burn in subtitles"*.
   - unchecked → export is enabled immediately.
   - checked **and** `!source.transcriptPath` → replace the export button with **"Prepare
     transcript"**. It calls `createTranscribeJob(source.assetId)`, stores the id via
     `onPrepJobId`, and polls exactly as `ShortsFlow.tsx:514-548` does (that effect also
     handles failure and writes `prepMessage` from `job.progress.message`). On completion,
     `getAsset` → `onSourceChange`, then `getAssetTranscriptText` → `setCues`.
     Copy: *"This transcribes the whole video and only runs once for this file — long
     recordings take a while. You can leave this tab; it won't restart."*
   - checked **and** transcript present → show the transcript review panel **expanded by
     default** (not behind an "Edit transcript" button as in Shorts — review is the point
     here), with the *same* per-cue row markup and the same `openTranscriptEditor` /
     `updateDraftCue` / `removeDraftCue` / `saveTranscript` handlers
     (`ShortsFlow.tsx:702-733, 920-951`). `saveTranscript` calls
     `updateAssetTranscript(assetId, draftCues)`, then re-fetches the VTT.
     Copy: *"Check for mistakes before they're burned into the video. Timestamps stay as they
     are. Saving also updates the transcript everywhere else this video is used."*
   - Export stays **disabled** while `burnSubtitles && (!source.transcriptPath || cues.length === 0)`,
     with the reason shown next to it.
4. **Export** → `createClipJob({ assetId, startTime: start, endTime: end, fade, captions:
   burnSubtitles, title, outputVideoFilename: `${slugify(title || 'clip')}.mp4` })`, then
   `pollJob`. On completion, prepend to `savedClips`.
5. **Finished clips** — reuse the `results-card` / `shorts-saved-*` markup from
   `ShortsFlow.tsx:955-990`: inline `<video>` preview + a download `<a>` pointing at
   `getResultArtifact(resultId, 'video')`. Load the existing ones on mount with
   `getClipsForAsset`.

Validation, mirroring `momentError` (`ShortsFlow.tsx:160`) **minus the 3-minute cap**: start
≥ 0, end > start, end ≤ `source.duration + 0.001`.

### Styling

Reuse the existing class names (`container`, `btn`, `btn-secondary`, `results-card`,
`shorts-*`). If any genuinely new element is needed, add rules to
`apps/web/public/css/styles.css` alongside the `shorts-` block.

---

## Step 7 — wiring in `App.tsx`

- `type AppFlow = 'upload' | 'editor' | 'shorts' | 'clip' | 'jobs' | 'results';`
- State: `clipSource: Asset | null`, `clipPrepJobId: string | null` (lifted for the same reason
  Shorts' are — see the comment at `App.tsx:26`). Clear both in `handleReset`.
- `UploadFlow` gets a **third** button, *"Upload to Clip"* — add an `onUploadForClip` prop and
  extend `UploadIntent` (`UploadFlow.tsx:10`, today `'clip' | 'shorts'`, where `'clip'` confusingly
  means *sermon*). Rename it to `'sermon' | 'shorts' | 'generalClip'` while you're there — it is a
  purely local type used only by `upload()` and `busyLabel()`. Update the explanatory
  paragraph (`UploadFlow.tsx:91-94`) to describe all three:
  *"**Clipping** opens the sermon editor. **Shorts** transcribes the video so you can cut 9:16
  vertical clips. **Clip a video** trims any video for another use — mid-service playback, an
  announcement — with optional fades and burned-in subtitles."*
- `handleUploadForClip(asset)` → `setClipSource(asset); setFlow('clip')`. No job is queued at
  upload time (unlike the shorts path): whether a transcript is needed isn't known yet.
- `navItems` entry: `{ key: 'clip', label: 'Clip', description: clipSource ? 'Trim any video'
  : 'Upload a video to clip', disabled: !clipSource }`, and the matching guard in
  `completeNavigation`.
- Render:

```tsx
        {flow === 'clip' && clipSource && (
          <ClipFlow
            source={clipSource}
            onSourceChange={setClipSource}
            prepJobId={clipPrepJobId}
            onPrepJobId={setClipPrepJobId}
          />
        )}
```

---

## Step 8 — `JobsFlow.tsx`

`jobKind(job)` (line 15) already returns `payload.kind ?? 'sermon'`, so clip rows appear
automatically and, having no `parentJobId`, sort as top-level. Two fixes needed:

1. `canOpenResult` (line 219) requires `job.result?.audioPath`, so it's correctly false for
   clips — but that leaves `noActions === true` and a blank Actions cell. Add:

```ts
const isClip = jobKind(job) === 'clip';
const canDownloadClip = isOwnedByCurrentSession && isClip
  && job.status === 'completed' && Boolean(job.result?.videoPath);
```

   Render a download `<a href={getResultArtifact(job.result.resultId, 'video')} download>` in
   the Actions cell, and include `canDownloadClip` in the `noActions` expression so the
   fallback text is right.
2. `canShorts` (line 224) is already gated to `sermon`/`transcribeSource` — leave it. A clip is
   not a shorts source.

`ResultsFlow.tsx:123` already gates its extra actions on `kind === 'sermon'`, so no change.

---

## Verification

```bash
npm run lint && npm run test --workspace @sermon-clipper/worker && npm run build
```

Then, manually, with API + worker + web running:

1. Upload a video that's at least a couple minutes long (so there's real footage on both sides
   of the marked selection) → **Upload to Clip**.
2. Trim to a selection starting well after `t=0` and ending well before the source's end
   (e.g. `startTime=60, endTime=70` on a 5-minute source), **fade on**, **subtitles off** →
   export. Confirm: (a) **total output length is ~16s, not ~10s** — this is the headline
   check for the whole redesign; (b) the output opens black and fades up over ~3s into
   footage that comes from *before* your marked `startTime` (not a frozen/repeated frame);
   (c) the marked 10 seconds in the middle play at full, undimmed brightness; (d) the last
   ~3 seconds fade down to black using footage from *after* your marked `endTime`; (e) frame
   size matches the source (not 1920×1080, not 1080×1920).
3. Trim a selection starting at `startTime` under 3s into the source (e.g. `startTime=1.2`) with
   fade on → confirm the fade-in is shortened to ~1.2s (not the full 3s, not negative/clamped
   to 0) and the job doesn't fail. Do the same near the source's tail for fade-out.
4. **Subtitles on** → confirm the export button is disabled, "Prepare transcript" appears, the
   transcribe job shows in the Jobs tab, and the transcript editor opens on completion.
5. **Subtitles on + fade on together, marked selection from step 2** — this is the specific
   scenario the redesign exists to get right. Pick (or edit in the transcript review panel) a
   caption line so its spoken words start within the first second of the *marked* `startTime`.
   Export, then watch the output closely at the exact moment the fade-in completes (~3s in):
   the caption for that line must appear **synchronized with the spoken words**, not ~3 seconds
   early. If it appears while the picture is still black/mid-fade and well before those words
   are actually spoken, `buildAssFromVtt` was called with `request.startTime` instead of
   `window.effectiveStart` — this is the exact regression §3b-i exists to prevent, and it is a
   blocking bug, not a nitpick. Separately, confirm a caption showing during the fade-in/out
   itself visibly dims/brightens with the picture (proving `ass` still precedes `fade`).
6. Re-run the Shorts flow end to end → confirm captions look **exactly** as before (the
   `AssStyleOptions` refactor's regression risk).
7. A source with no audio track → confirm the clip encodes (`-an`) instead of failing.
8. A marked selection that spans (almost) the entire source, fade on → confirm this degrades
   gracefully (fade shortens or is skipped per §3b, with the `fadeNote` surfaced in the job's
   progress message) rather than failing or reading past the start/end of the file.

## Out of scope (say so, don't build it)

- Windowed transcription (see the decision above).
- Multiple clips per job — one clip per job; run the flow again for another.
- Trimming a clip out of a *finished* sermon job the way Shorts derives a source
  (`POST /assets/from-job/:jobId`). Easy to add later by calling
  `createShortsSourceFromJob` and routing to `'clip'`.
- Configurable fade length or fade colour. The toggle is fixed at
  `CLIP_FADE_SECONDS = 3`, to black.
- A frozen-frame or solid-color pad at the head/tail (`tpad`) instead of widening the read
  window into real adjacent footage. Considered and rejected in "Design: how the fade actually
  works" above — a frozen still avoids reading outside the marked selection, but shows a
  static image during the fade instead of real motion, and introduces a filter this codebase
  has never used. Revisit if the widened-window design turns out to have a real problem
  (e.g. sources with nothing usable before/after the marked selection are common in practice).
