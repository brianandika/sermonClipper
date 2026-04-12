# Sermon Clipper

Sermon Clipper is a monorepo for clipping sermon videos into downloadable MP3 and MP4 outputs.

The current platform includes:

- a React + Vite web editor for upload, trimming, queue monitoring, and results
- a NestJS API for sessions, assets, jobs, and results
- a BullMQ worker that runs the FFmpeg processing pipeline
- Prisma + PostgreSQL for persistence
- Redis for queueing

The legacy Flask app is still present in this repository, but the active product work is centered on the TypeScript platform under `apps/`.

## What The App Does

The current flow is:

1. Upload a source video.
2. Open the editor and choose the portion of the source to keep.
3. Optionally cut out internal sections, add a still-image intro, and choose an output filename.
4. Submit the job to the processing queue.
5. Watch queue progress in the Jobs page.
6. Open the Results page as soon as the MP3 is ready.
7. Stay on the Results page while it auto-refreshes until the MP4 is ready.

## Architecture

- `apps/web`: React frontend for upload, editing, jobs, and results
- `apps/api`: NestJS HTTP API
- `apps/worker`: BullMQ worker and FFmpeg processing runtime
- `packages/shared`: shared request/response types and constants
- `prisma`: Prisma schema and generated client inputs
- `docker-compose.yml`: local stack for PostgreSQL, Redis, API, and worker
- `.devcontainer`: VS Code dev container support
- `app.py`: legacy Flask app

## Processing Behavior

Each job currently produces:

- one MP3 audio artifact
- one MP4 video artifact

The worker processes audio first and publishes the result early, so users can download the MP3 while the MP4 is still encoding.

Current processing rules:

- `startTime` and `endTime` define the main source span to keep.
- `clipStarts` and `clipEnds` define internal cut ranges inside that span.
- the remaining segments are stitched together in order
- the audio output is normalized after stitching
- the video output is normalized after stitching and video rendering
- a still intro image, when provided, is only inserted into the video pipeline

## Prerequisites

For local development outside Docker:

- Node.js and npm
- PostgreSQL
- Redis
- `ffmpeg` and `ffprobe` available on `PATH`

For containerized development:

- Docker
- Docker Compose

## Environment Variables

Copy [/.env.example](/workspaces/sermonClipper/.env.example) to `/.env` before running the app.

### Core Connectivity

- `DATABASE_URL`: PostgreSQL connection string used by API and worker.
- `REDIS_URL`: Redis connection string used for BullMQ queues.
- `API_PORT`: port used by the Nest API in local host runs.

### Retention And Cleanup

- `SESSION_TTL_DAYS`: number of days before inactive sessions expire.
- `RESULT_TTL_DAYS`: number of days result records remain valid.
- `ASSET_TTL_DAYS`: number of days unused assets can remain before cleanup removes them.
  If omitted, it falls back to `SESSION_TTL_DAYS`.
- `JOB_TTL_DAYS`: number of days completed, failed, canceled, or expired jobs are kept before cleanup removes them.
  If omitted, it falls back to `RESULT_TTL_DAYS`.
- `CLEANUP_INTERVAL_MINUTES`: how often the API cleanup service scans for expired sessions, old jobs, and stale assets.

### Media And Working Files

- `WORK_ROOT`: root directory where uploaded assets, intermediate job files, and results are stored.
- `FFMPEG_PATH`: path or executable name for `ffmpeg`.
- `FFPROBE_PATH`: path or executable name for `ffprobe`.

### Worker Settings

- `WORKER_MODE`: which queue set the worker should serve. The normal value is `all`.
- `CPU_WORKER_CONCURRENCY`: maximum concurrent CPU-oriented jobs.
- `GPU_WORKER_CONCURRENCY`: maximum concurrent GPU encode jobs.

## Example `.env`

```env
DATABASE_URL=postgresql://sermon_clipper:sermon_clipper@localhost:5432/sermon_clipper?schema=public
REDIS_URL=redis://localhost:6379
API_PORT=3000
SESSION_TTL_DAYS=90
RESULT_TTL_DAYS=90
ASSET_TTL_DAYS=90
JOB_TTL_DAYS=90
CLEANUP_INTERVAL_MINUTES=60
WORK_ROOT=/workspaces/sermonClipper/work
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
WORKER_MODE=all
CPU_WORKER_CONCURRENCY=2
GPU_WORKER_CONCURRENCY=1
```

## Local Development

1. Install dependencies:

```sh
npm install
```

2. Copy the example environment file:

```sh
cp .env.example .env
```

3. Start PostgreSQL and Redis:

```sh
docker compose up -d postgres redis
```

4. Generate the Prisma client:

```sh
npm run prisma:generate
```

5. Start the API:

```sh
npm run dev:api
```

6. Start the worker in a separate terminal:

```sh
npm run dev:worker
```

7. Start the web app in a third terminal:

```sh
npm run dev:web
```

## Docker Compose

The root [docker-compose.yml](/workspaces/sermonClipper/docker-compose.yml) runs:

- PostgreSQL
- Redis
- API
- worker

Start everything with:

```sh
docker compose up --build
```

Notes:

- inside Docker, `WORK_ROOT` is overridden to `/app/work`
- API and worker share the same persistent work volume
- API and worker both run `prisma db push` on startup in the compose stack

## Build Commands

Build the full monorepo:

```sh
npm run build
```

Build individual packages:

```sh
npm run build --workspace @sermon-clipper/api
npm run build --workspace @sermon-clipper/worker
npm run build --workspace @sermon-clipper/web
```

## Queue And Results Behavior

The Jobs page shows all jobs in the queue.

- processing and queued jobs show progress
- users can cancel only their own jobs
- users can open the result page as soon as audio is available
- the results page polls automatically until the MP4 is ready

## Automatic Cleanup

Generated data is stored under `WORK_ROOT`.

The API runs a periodic cleanup service that removes:

- expired sessions and their directories
- old terminal jobs and their job directories
- stale assets with no remaining job references

This keeps the `work` directory from growing without bound.

## Legacy Flask App

The repository still contains the older Flask implementation in [app.py](/workspaces/sermonClipper/app.py).

That code remains useful for reference, but the current product work is centered on the monorepo under `apps/`.

## Dev Container

The repository includes a VS Code dev container for a consistent development environment.

Typical flow inside the dev container:

```sh
npm install
npm run prisma:generate
npm run dev:api
npm run dev:worker
npm run dev:web
```

The dev container is the easiest way to get matching versions of Node, Python, FFmpeg, PostgreSQL tooling, and Redis tooling.
