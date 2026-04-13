#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$REPO_ROOT/backups/postgres"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/sermon_clipper_${TIMESTAMP}.sql"

mkdir -p "$BACKUP_DIR"

# Ensure postgres service is up before dumping.
docker compose up -d postgres >/dev/null

if docker compose exec -T postgres pg_dump -U sermon_clipper -d sermon_clipper >"$BACKUP_FILE"; then
  printf 'Postgres backup created: %s\n' "$BACKUP_FILE"
else
  rm -f "$BACKUP_FILE"
  printf 'Postgres backup failed\n' >&2
  exit 1
fi
