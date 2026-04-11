FROM mcr.microsoft.com/devcontainers/base:trixie

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        ffmpeg \
        jq \
        libpq-dev \
        postgresql-client \
        redis-tools \
        sqlite3 \
    && rm -rf /var/lib/apt/lists/*