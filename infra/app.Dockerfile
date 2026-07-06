FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    postgresql-client \
    python3 \
    python3-pip \
    redis-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY prisma/schema.prisma prisma/schema.prisma

RUN npm ci

COPY . .

# Python deps for local transcription (faster-whisper). Debian 12 marks the
# system environment as externally managed, so --break-system-packages is
# required to install into the image's system Python.
RUN pip3 install --break-system-packages --no-cache-dir -r apps/worker/requirements.txt

RUN npm run prisma:generate \
    && npm run build:shared \
    && npm run build:api \
    && npm run build:worker