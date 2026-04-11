# VM sermon video processing

This repository currently contains the original Flask application and the in-progress replacement platform.

- Legacy app: Flask upload and clipping flow in [app.py](app.py)
- New platform foundation: NestJS API, worker runtime, Prisma schema, and local Docker infrastructure

The current implementation phase is focused on scaffolding the new backend without breaking the existing Flask workflow.

## Installation

### Prerequisites

- Python 3.6 or higher
- `ffmpeg` installed and available in your system's PATH

### Steps

1. Clone the repository:

   ```sh
   git clone https://github.com/yourusername/videoclipper.git
   cd videoclipper
   ```

2. Create and activate a virtual environment:

   ```sh
   python -m venv venv
   source venv/bin/activate  # On Windows, use `venv\Scripts\activate`
   ```

3. Install the required Python libraries:

   ```sh
   pip install -r requirements.txt
   ```

4. Run the application:

   ```sh
   python app.py
   ```

5. Open your web browser and go to [http://127.0.0.1:5000](http://127.0.0.1:5000) to use the application.

## New Platform Foundation

The new implementation lives alongside the Flask app and uses a monorepo layout:

- `apps/api`: NestJS HTTP API
- `apps/worker`: background worker runtime for queues and FFmpeg jobs
- `apps/web`: placeholder for the React + Vite frontend
- `packages/shared`: shared backend/frontend types and constants
- `prisma`: PostgreSQL schema
- `docker-compose.yml`: main container stack for PostgreSQL, Redis, API, and worker
- `.devcontainer`: VS Code development container configuration

### Initial setup for the new platform

1. Install Node dependencies:

   ```sh
   npm install
   ```

2. Create a root `.env` file from the example below:

   ```env
   DATABASE_URL=postgresql://sermon_clipper:sermon_clipper@localhost:5432/sermon_clipper?schema=public
   REDIS_URL=redis://localhost:6379
   API_PORT=3000
   SESSION_TTL_DAYS=7
   RESULT_TTL_DAYS=7
   WORKER_MODE=all
   CPU_WORKER_CONCURRENCY=2
   GPU_WORKER_CONCURRENCY=1
   ```

3. Start PostgreSQL and Redis:

   ```sh
   docker compose up -d postgres redis
   ```

4. Generate the Prisma client:

   ```sh
   npm run prisma:generate
   ```

5. Start the API foundation:

   ```sh
   npm run dev:api
   ```

6. In a separate terminal, start the worker foundation:

   ```sh
   npm run dev:worker
   ```

At this stage, the new API exposes `/health`, `/sessions/bootstrap`, asset upload, job creation/status, and result lookup. The worker now uses two execution lanes:

- `clip-process`: CPU-oriented jobs that can run concurrently
- `gpu-encode`: serialized NVENC-backed jobs; `auto` is routed here only when local FFmpeg hardware detection resolves to `cuda`

If NVENC is not available, `auto` falls back to the CPU lane. This keeps CPU throughput moving without allowing multiple NVENC-backed jobs to overlap.

The worker now follows the legacy Flask artifact flow more closely by rendering the audio artifact and the video artifact as separate pipelines, each with its own final normalization pass.

Current processing contract:

- Input video asset plus `startTime` and `endTime` defines the full source span to keep.
- Optional `clipStarts` and `clipEnds` define cut-out ranges inside that span. The worker stitches the remaining ranges together in order.
- The worker outputs two normalized artifacts for every job: a stitched video-with-audio MP4 file and a stitched audio-only MP3 file.
- The audio artifact follows the Flask audio path: stitched kept segments, 1 second audio crossfades between kept segments, fade in/out on the stitched program, then loudness normalization.
- The video artifact follows the Flask video path: stitched kept segments, 0.5 second crossfades between video segments, fade in/out on the full video timeline, then loudness normalization of the video audio track.
- The worker uses the resolved hardware encoder for video segment rendering and final video rendering instead of hardcoding CPU-only x264 settings.
- When `introImageAssetId` is provided, a still-image clip is inserted only into the video pipeline. The video fades in on the still image, crossfades from the still image into the first kept video segment, and still fades out at the end. The audio-only MP3 artifact does not include intro silence.

## Quick Start With Docker Compose

The repository now includes a root [docker-compose.yml](docker-compose.yml) for the new platform stack.

This stack starts:

- PostgreSQL
- Redis
- Nest API on port `3000`
- Worker runtime for clip jobs

Quick start:

1. Copy `.env.example` to `.env`.
2. Run:

   ```sh
   docker compose up --build
   ```

3. Wait for the API to boot, then open `http://localhost:3000/health`.

Notes:

- The API and worker containers share a persistent `work` volume for generated artifacts.
- The compose stack currently runs the new backend platform. It does not yet launch a production frontend because the React app is still scaffold-only.
- Both API and worker run `prisma db push` on startup so the database schema is created automatically for local use.

## Recommended Workflows

Use the dev container for feature development:

- Start the VS Code dev container.
- The dev container starts `workspace`, `postgres`, and `redis`.
- Run the app manually inside `workspace` for fast iteration:

  ```sh
  npm run dev:api
  npm run dev:worker
  ```

Use the full compose stack for integration checks:

- Start `postgres`, `redis`, `api`, and `worker` with:

  ```sh
  docker compose up -d --build
  ```

- Use this when you want to validate the actual containerized runtime instead of the interactive development workflow.

## Project Structure

- `app.py`: Main application file
- `apps/api`: New NestJS API foundation
- `apps/worker`: New worker foundation
- `packages/shared`: Shared TypeScript contracts
- `prisma/schema.prisma`: New backend data model
- `docker-compose.yml`: Main stack for PostgreSQL, Redis, API, and worker
- `.devcontainer`: Workspace container configuration for VS Code development
- `templates`: HTML templates for the web pages
  - `index.html`: Upload page
  - `process.html`: Video processing page
  - `result.html`: Result page
- `uploads`: Directory for uploaded files
- `processed`: Directory for processed files

## Dependencies

- Flask
- ffmpeg-python
- google-auth-oauthlib
- google-auth-httplib2
- google-api-python-client
- python-dotenv
- NestJS
- Prisma
- BullMQ
- Redis
- PostgreSQL

## Using the Dev Container

This repository can be developed inside a VS Code Dev Container to ensure a consistent environment (Node, Python, FFmpeg, Docker CLI, PostgreSQL client, Redis CLI, and project dependencies).

Prerequisites:

- VS Code
- the "Dev Containers" extension (ms-vscode-remote.remote-containers)

Open the project in a dev container:

1. In VS Code open the Command Palette and run **Remote-Containers: Reopen in Container** (or **Dev Containers: Open Folder in Container**).
2. Wait for the container to build and start. The first build may take a few minutes.

The dev container starts these services:

- `workspace`: your interactive development environment
- `postgres`: local database for development
- `redis`: local queue/cache backend for development

The `api` and `worker` containers are intentionally not started by the dev container. During normal development, run them manually inside `workspace` so you get live reload, better stack traces, and easier debugging.

Working inside the container:

- The project contains a Python virtual environment at `venv` (created for local runs).

Because virtual environments include system-specific paths and binaries, you should recreate the `venv` inside the dev container instead of reusing a host-created `venv`.

To recreate and activate the virtual environment inside the container:

```bash
rm -rf venv  # optional: remove the host-created venv first
python -m venv venv
source venv/bin/activate
```

If the integrated terminal in VS Code auto-activates a virtual environment, verify it points to a container-local `venv` (not a host path).

- The post-create step now does the following automatically:

- copies `.env.example` to `.env` when missing
- runs `npm ci`
- runs `npm run prisma:generate`
- recreates `venv`
- installs `requirements.txt`

- Install Python dependencies manually only if you need to refresh them after changing `requirements.txt`:

```bash
pip install -r requirements.txt
```

- `ffmpeg`, `psql`, `redis-cli`, and Docker tooling are installed in the dev container image.

Run the application inside `workspace`:

```bash
npm run dev:api
npm run dev:worker
```

Run the legacy Flask app if needed:

```bash
python app.py
```

Open your browser to http://127.0.0.1:5000. When running in the dev container, accept any prompt to forward the port from the container to the host.

Rebuilding or updating the container:

- If you change devcontainer configuration, rebuild with **Dev Containers: Rebuild Container** from the Command Palette.

Notes:

- The integrated terminal in VS Code may automatically activate the virtual environment for you. If it doesn't, run `source venv/bin/activate`.
- If you want to validate the full containerized stack, use `docker compose up -d --build` from the repository root.
- If you prefer not to use the dev container, the normal local setup in this README still applies.
