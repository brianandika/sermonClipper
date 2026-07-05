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
- `docker-compose.yml`: local stack for PostgreSQL, Redis, API, worker, and web (Nginx)
- `.devcontainer`: VS Code dev container support
- `app.py`: legacy Flask app

## Processing Behavior

Each job currently produces:

- one MP3 audio artifact
- one MP4 video artifact
- one plain-text `.txt` transcript

The worker processes audio first and publishes the result early, so users can download the MP3 while the MP4 is still encoding.

Current processing rules:

- `startTime` and `endTime` define the main source span to keep.
- `clipStarts` and `clipEnds` define internal cut ranges inside that span.
- the remaining segments are stitched together in order
- the audio output is normalized after stitching
- the video output is normalized after stitching and video rendering
- a still intro image, when provided, is only inserted into the video pipeline
- after the MP4 finishes, the exported audio is transcribed to a `.txt` transcript

## Transcription

Every processed sermon also produces a plain-text transcript alongside the MP3
and MP4. Transcription runs fully locally in the worker via
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (invoked as a Python
subprocess, the same way the worker shells out to `ffmpeg`).

- It runs at the **end** of the pipeline, so the MP3/MP4 exports are never
  delayed; the transcript is added as a final artifact.
- It is **best-effort**: if transcription fails or is disabled, the MP3/MP4
  still complete normally.
- The model (`large-v3-turbo`, ~1.5 GB) downloads on first job into
  `WHISPER_MODEL_DIR` (defaults to `${WORK_ROOT}/_models`, which lives on the
  shared `work` volume so it persists and is downloaded only once).
- **GPU:** with `WHISPER_DEVICE=auto` the worker uses the NVIDIA GPU when the
  CUDA/cuDNN runtime is available (the `nvidia-*-cu12` packages in
  `apps/worker/requirements.txt` provide it) and otherwise falls back to CPU
  automatically.

The transcript is downloadable from the Results page and served by the API at
`GET /api/results/:resultId/transcript`.

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
- `BACKUP_INTERVAL_SECONDS`: how often the `postgres-backup` service creates a new SQL dump backup.
- `BACKUP_RETENTION_MINUTES`: how long to keep old SQL dump backups before deletion.

### Media And Working Files

- `WORK_ROOT`: root directory where uploaded assets, intermediate job files, and results are stored.
- `FFMPEG_PATH`: path or executable name for `ffmpeg`.
- `FFPROBE_PATH`: path or executable name for `ffprobe`.
- `UPLOAD_MAX_BYTES`: maximum allowed upload size in bytes (default `53687091200`, 50 GiB).

### Worker Settings

- `WORKER_MODE`: which queue set the worker should serve. The normal value is `all`.
- `CPU_WORKER_CONCURRENCY`: maximum concurrent CPU-oriented jobs.
- `GPU_WORKER_CONCURRENCY`: maximum concurrent GPU encode jobs.

### Transcription

- `ENABLE_TRANSCRIPTION`: set to `false` to skip transcript generation.
- `WHISPER_MODEL`: faster-whisper model id (default `large-v3-turbo`).
- `WHISPER_MODEL_DIR`: where the model is cached (default `${WORK_ROOT}/_models`).
- `WHISPER_DEVICE`: `auto` (GPU if available, else CPU), `cpu`, or `cuda`.
- `WHISPER_COMPUTE_TYPE`: `auto`, `int8`, `float16`, or `float32`.
- `WHISPER_LANGUAGE`: language code (default `en`), or `auto` to detect.
- `PYTHON_PATH`: Python executable used for the transcription script (default `python3`).

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
UPLOAD_MAX_BYTES=53687091200
WORKER_MODE=all
CPU_WORKER_CONCURRENCY=2
GPU_WORKER_CONCURRENCY=1
BACKUP_INTERVAL_SECONDS=600
BACKUP_RETENTION_MINUTES=60
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
- web (Nginx serving the built React app)

Start everything with:

```sh
docker compose up --build
```

Run detached:

```sh
docker compose up --build -d
```

Host endpoints:

- Web UI: `http://localhost:5173`
- API direct: `http://localhost:3000`
- API through web proxy: `http://localhost:5173/api/...`

The web container serves the production frontend build and proxies `/api/*` to the API container.
This keeps frontend and backend on one origin (`localhost:5173`) for browser usage.

Stop the stack:

```sh
docker compose down
```

Stop and remove volumes:

```sh
docker compose down -v
```

Notes:

- inside Docker, `WORK_ROOT` is overridden to `/app/work`
- API and worker share `./work` on the host as a bind mount (assets/jobs are directly visible on disk)
- PostgreSQL data is periodically backed up into `./backups/postgres` on the host by the `postgres-backup` service, but the live database uses a Docker named volume for reliability on Windows filesystems
- Redis data is bind-mounted to `./data/redis`
- API and worker both run `prisma db push` on startup in the compose stack
- on first startup, `/api` calls through Nginx may briefly return `502` until the API finishes booting
- Nginx upload proxy limit is set to `50g`, and API upload limit defaults to `50 GiB` via `UPLOAD_MAX_BYTES`
- API uploads are written to disk under `WORK_ROOT/_upload_tmp` before being moved into asset storage, so large uploads do not require buffering the full file in memory

### One-Command Start/Stop Scripts (No npm Required)

If you only want Docker/Compose on the host (no `npm`/`npx`), use the control scripts in `scripts/`.

Windows (Command Prompt or PowerShell):

```bat
scripts\stack-control.bat start
scripts\stack-control.bat stop
scripts\stack-control.bat status
scripts\stack-control.bat logs
```

macOS/Linux/WSL:

```sh
chmod +x ./scripts/stack-control.sh
./scripts/stack-control.sh start
./scripts/stack-control.sh stop
./scripts/stack-control.sh status
./scripts/stack-control.sh logs
```

Optional flags:

- `--no-build`: skip rebuilding images on `start`/`restart`
- `--volumes`: remove compose volumes on `stop`
- `--skip-backup`: skip automatic Postgres backup before `stop`/`restart`

The scripts print both localhost and LAN URLs after startup so other computers on your network can open the UI.
If other computers cannot connect, allow inbound TCP ports `5173` and `3000` in your host firewall.

Database backup commands:

```bat
scripts\stack-control.bat backup
```

```sh
./scripts/stack-control.sh backup
```

By default, `stop` and `restart` run an automatic timestamped Postgres backup into `./backups/postgres` before shutting down.

Periodic Docker backup service:

- `postgres-backup` runs continuously in Docker Compose and creates recurring SQL dumps in `./backups/postgres`.
- Configure schedule with `BACKUP_INTERVAL_SECONDS` (default `600`, every 10 minutes).
- Configure retention with `BACKUP_RETENTION_MINUTES` (default `60`, keep the previous hour).
- On graceful container stop (including normal OS shutdown where Docker stops services), it runs one final backup before exit.
- Unexpected hard power loss cannot be guaranteed to run a final backup, so periodic backups remain the primary protection.

### Auto-Start On Boot

Use the autostart wrappers for boot tasks. They intentionally run `start --no-build` for faster, more reliable startup.

Windows:

```bat
scripts\stack-autostart.bat
```

Recommended Task Scheduler setup:

- Trigger: `At startup` (or `At log on`)
- Program/script: `cmd.exe`
- Add arguments: `/c "C:\Users\brian\Documents\Projects\sermonClipper\scripts\stack-autostart.bat"`
- Start in: `C:\Users\brian\Documents\Projects\sermonClipper`
- Enable `Run with highest privileges`

Linux/macOS/WSL (cron `@reboot`, systemd user service, etc.):

```sh
chmod +x ./scripts/stack-autostart.sh
./scripts/stack-autostart.sh
```

`--no-build` vs build behavior:

- `start --no-build`: starts quickly from existing images; best for reboot/autostart
- `start` (default): rebuilds images first; use after code/dependency changes

Important data note:

- Current setup stores processing files in `./work` on the host.
- Redis stores data in `./data/redis` on the host.
- PostgreSQL uses the `postgres_data` Docker named volume for reliability on Windows filesystems.
- `docker compose down -v` removes named volumes (including PostgreSQL data), so do not use it unless you intend to reset the database.
- Docker Compose auto-creates missing bind-mount directories (for example `./work`, `./data/redis`, `./backups/postgres`) on startup.
- If you previously used the old `work_data` volume, copy it once into `./work`:

```sh
docker run --rm -v sermonclipper_work_data:/from -v "$(pwd)/work:/to" alpine sh -lc "cp -a /from/. /to/"
```

- If you previously used old named volume data for Redis, migrate once into the host folder:

```sh
docker run --rm -v sermonclipper_redis_data:/from -v "$(pwd)/data/redis:/to" alpine sh -lc "cp -a /from/. /to/"
```

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
