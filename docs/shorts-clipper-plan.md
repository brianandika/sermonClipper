# Plan: Optional "Shorts" (9:16 vertical clips) for Sermon Clipper

## Context

Sermon Clipper today is a landscape trim/cut tool: Upload → Editor → clip job → MP3 + 1920×1080 MP4 + WebVTT transcript (Whisper runs at the *end* of a job, on the output audio). There is **no** cropping, no vertical export, no burned-in captions, and **no LLM/AI** anywhere — the stack runs fully offline (FFmpeg + faster-whisper, all local).

We want to add an **optional** way to produce YouTube Shorts / IG Reels — 9:16 vertical clips of key sermon moments with captions burned onto the video. It must not disturb the existing sermon workflow; it lives in its own opt-in tab.

### Decisions locked with the user
1. **Standalone from an upload** — shorts are made directly from an uploaded video; we transcribe the source *on demand* (no need to run a full sermon job first).
2. **Manual moment selection for v1** — human reads the transcript and picks moments. No LLM, stays offline.
3. **Simple bold captions** — segment-level captions burned in via FFmpeg, from the transcript we generate.
4. **Horizontal-position crop** — a full-height 9:16 window the user slides left/right over the 16:9 frame (optional zoom). One crop value per short.

### Design principle
Reuse everything. Add the **minimum** new surface: one job `kind` discriminator, **one** Prisma field, **one** API endpoint, two worker branches, and one self-contained frontend tab. No new queue, no new core tables.

---

## Recommended approach

### Model: shorts are lean "jobs" distinguished by a `kind`
The BullMQ message stays `{ jobId }`; the worker already loads `job.payloadJson` at the top of processing, so a `kind: 'sermon' | 'transcribeSource' | 'short'` field (absent ⇒ `'sermon'`) in the payload is enough to branch **inside the worker** — no queue-message or queue-name changes, and hardware routing (cuda→`gpu-encode`, else→`clip-process`) is untouched.

Two new lean worker pipelines:
- **`transcribeSource`**: `extractAudio(source)` → `transcribeAudio` → write `.vtt` → `prisma.asset.update({ transcriptPath })`. **No Result row.** A null/failed transcript is **fatal** here (a short needs it), unlike the sermon path's best-effort transcription.
- **`short`**: single-pass FFmpeg — `crop` the 9:16 window → `scale=1080:1920,setsar=1` → optionally burn sliced captions (`ass=` filter) → encode one MP4. No MP3, no re-transcription, no two-pass loudnorm. Write the Result **once at completion** with a real `videoPath` (do *not* copy the sermon path's early `videoPath=""` sentinel write).

Video-only Results need **no schema change**: `Result.audioPath/videoPath/manifestPath` are already nullable and `/results/:id/audio` already 404s when audio is null.

### User flow (new self-contained "Shorts" tab)
1. **Prepare transcript** — on entry, if the asset has no `transcriptPath`, POST a `transcribeSource` job and `pollJob` to completion, then load the VTT.
2. **Pick moments** — render the VTT as clickable cues; clicking seeds a moment (start/end/title), adjustable via the `EditorFlow` Set-in/Set-out range-row pattern. Add several.
3. **Frame each short** — a 16:9 `<video>` in a `position:relative` box with a CSS overlay window + horizontal-position slider (`cropX` 0..1) and optional zoom (`zoom` ≥1); captions toggle (default on).
4. **Export** — submit N `short` jobs; `pollJob` each; render `results-card` download cards (reuse `ResultsFlow` classes) as they finish. Each short is its own MP4.

---

## Files to add / modify

**`packages/shared/src/index.ts`** — add `export type JobKind = 'sermon' | 'transcribeSource' | 'short'`; extend `CreateJobRequest` with `kind?: JobKind`, `cropX?: number`, `zoom?: number`, `captions?: boolean`. No change to `ClipProcessJobData`.

**`prisma/schema.prisma`** — add `transcriptPath String?` to `Asset` (single `prisma db push`).

**`apps/api/src/jobs/create-job.dto.ts`** — add `kind?`, `cropX?`, `zoom?`, `captions?`; use `@ValidateIf(o => o.kind === 'short')` to require `cropX∈[0,1]` and `zoom≥1`, and `@ValidateIf(o => o.kind !== 'transcribeSource')` on `startTime`/`endTime`.

**`apps/api/src/jobs/jobs.service.ts`** — gate `validateClipRanges` to `kind === 'sermon'` (short uses only start/end; transcribeSource uses neither).

**`apps/api/src/assets/assets.controller.ts` + `assets.service.ts`** — add `GET /assets/:assetId/transcript` → `sendFile(asset.transcriptPath)` as `text/vtt`, 404 if null, mirroring the ownership check in `getAssetSource`.

**`apps/worker/src/main.ts`** — in the `createQueueWorker` callback, after loading the job, dispatch on `kind`: keep `processClipJob` for `sermon`; add `processTranscribeSourceJob` and `processShortJob`. New helpers: JS crop-math (from `detectMediaProperties` W/H), `buildAssFromVtt(vtt, start, end)` (the bug-prone one — unit-test it), and a **boot-time** libass capability check (parse `ffmpeg -filters` for `subtitles`/`ass`, cached like the existing `capabilityPromise`), with a **caption-less fallback** recorded in the result message if libass is absent. Reuse `runFfmpeg`, `getVideoEncodingArgs`, `extractAudio`, `transcribeAudio`, `enqueueProgressWrite`, `getJobRoot`, AbortController cancellation.

**`apps/web/src/api.ts`** — extend `createJob` param type with the new fields; add `getAssetTranscriptUrl(assetId)` and thin `createTranscribeJob`/`createShortJob` wrappers.

**`apps/web/src/App.tsx`** — add `'shorts'` to `AppFlow`, a `navItems` entry disabled until `asset` exists (mirror `editor` gating), and render `<ShortsFlow asset={asset} />`.

**`apps/web/src/components/ShortsFlow.tsx`** *(new)* — the self-contained tab described above; reuse the `<video>`/range-row/validation patterns from `EditorFlow.tsx` and the download-card classes from `ResultsFlow.tsx`.

**`apps/web/src/components/JobsFlow.tsx`** — guard the result's audio-download link on `audioPath != null` so video-only shorts render cleanly in the shared jobs list.

### Crop math (keep JS and FFmpeg identical)
From source `W×H` and `zoom z≥1`, with `even(n)=n-(n%2)`:
`cropH = even(H/z)`; `cropW = even(cropH*9/16)`; `x = clamp(even((W-cropW)*cropX), 0, W-cropW)`; `y = even((H-cropH)/2)`. Filter: `crop=cropW:cropH:x:y,scale=1080:1920,setsar=1`. CSS preview window width fraction = `0.3164/z` of the container (full height), `left` driven by `cropX` — same numbers as the filter so preview matches output.

---

## Verification
1. Bring up the stack (`docker-compose up`); confirm the FFmpeg image reports `subtitles`/`ass` in `ffmpeg -filters` (else the caption-less fallback path is exercised).
2. Upload a short 16:9 test clip → open the **Shorts** tab → confirm a `transcribeSource` job runs and the VTT loads.
3. Create one short with captions on: pick a moment, slide the crop, export. Confirm the output MP4 is **1080×1920**, plays, has the crop framed as previewed, and shows burned-in captions timed to the clip. `ffprobe` the dimensions.
4. Create a second short with captions off and a different `cropX`/`zoom`; confirm independent job/progress/download.
5. Regression: run a normal **sermon** clip job end-to-end (Upload→Editor→Jobs→Results) and confirm MP3+MP4+VTT are unchanged.
6. Unit-test `buildAssFromVtt` in isolation (slicing, rebasing to 0, dropping non-overlapping cues, text/path escaping).

## Explicitly deferred (not in v1)
- AI / LLM moment suggestion (stays manual/offline).
- Word-by-word "karaoke" captions (needs `word_timestamps=True` + format change in `transcribe.py`).
- Free draggable/resizable crop box, auto-reframe / face-tracking, keyframed pan.
- Batch/zip export of all shorts; direct YouTube upload of shorts; multiple caption styles/fonts.
- Writing a Result/manifest for `transcribeSource` (just set `Asset.transcriptPath`).

---

## Implementation notes — deltas from the plan as built

The plan was written against a slightly idealized read of the codebase. What actually shipped, and where it differed:

1. **`kind` lives in `payloadJson`, and there was no `JobKind` type or `ClipProcessJobData` change to make.** The BullMQ message is already just `{ jobId }` and the API persists the *entire* DTO verbatim as `Job.payloadJson`, so adding `kind?` to `CreateJobDto` + `CreateJobRequest` is enough for the worker to branch. No queue-message change was needed (matches the plan's intent).

2. **Queue routing.** Hardware routing (`cuda`→`gpu-encode`, else→`clip-process`) lives in `JobHardwareService.resolve()`, not `jobs.service.ts`. `short` jobs go through `resolve()` unchanged (GPU when available). `transcribeSource` is pinned to `clip-process` in `jobs.service.create()` so transcription never occupies the scarce GPU-encode slot. **No new queue** was added.

3. **The worker is a single ~1660-line `main.ts`** with top-level (non-exported) helpers. New branches (`processTranscribeSourceJob`, `processShortJob`, `dispatchJob`) were added *inside* `main.ts`; `dispatchJob` reads `payloadJson.kind` and routes (absent ⇒ `processClipJob`). The queue-worker callback now calls `dispatchJob` instead of `processClipJob` directly.

4. **No pre-existing `capabilityPromise` in the worker to copy.** The API's `JobHardwareService` caches an ffmpeg probe, but the worker had none. Added a cached `canBurnCaptions()` that parses `ffmpeg -filters` for the `ass` filter, with a caption-less fallback recorded in the result message (as planned).

5. **The bug-prone `buildAssFromVtt` + crop math were extracted to `apps/worker/src/captions.ts`** (pure, side-effect-free) so they're unit-testable — importing `main.ts` would boot the worker. Tests in `apps/worker/src/captions.test.ts` (run via `npm run test --workspace @sermon-clipper/worker`, using the root `tsx`; **16 tests, all passing**) cover slicing, rebasing to 0, boundary-only cues, tag/brace escaping, filtergraph path escaping, and even-dimension crop geometry.

6. **`transcribeSource` writes the `.vtt` next to the asset source** (`dirname(asset.sourcePath)/transcript.vtt`) and sets `Asset.transcriptPath`. Audio is extracted to 16 kHz mono PCM WAV for whisper. A null/failed transcript is **fatal** here (re-throws → job `failed`), unlike the sermon path's best-effort transcription.

7. **`short` writes the Result once at completion** with a real `videoPath` (audio/manifest stay null). The single-pass filter is `crop=W:H:x:y,scale=1080:1920,setsar=1[,ass=<escaped path>]`. No early `videoPath=""` sentinel, no MP3, no two-pass loudnorm.

8. **Results artifact endpoints already existed** (`/results/:id/{audio,video,transcript}`, each 404-gated on the null path) — no new results route was needed; the Shorts UI reuses `getResultArtifact(resultId, 'video')`.

9. **`JobsFlow.tsx` was left unchanged.** The plan wanted an `audioPath != null` guard for video-only shorts, but the current `JobsFlow` already gates its result action on `Boolean(job.result?.audioPath)`, so video-only shorts render cleanly (they simply have no "Open Audio" action in the shared list). The Shorts tab is self-contained: it submits/polls its own jobs and renders its own result cards.

10. **`Asset.transcriptPath` was added to `AssetResponse`** (and the web `Asset` type) so the Shorts tab can decide whether to run `transcribeSource` before loading cues.

### Not yet run (needs a DB-connected environment)
- `prisma db push` (or a migration) to add the `Asset.transcriptPath` column. `prisma generate` **was** run (offline) so the client types are current and everything compiles. Run `npm run prisma:migrate:dev` (or `prisma db push`) against the dev database before exercising the feature end-to-end.
- Runtime verification against a live stack (steps 1–6 in **Verification** above). All packages typecheck (`npm run build` green) and the caption unit tests pass, but no clip has been encoded in this environment.
