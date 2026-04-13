#!/usr/bin/env sh
set -eu

mkdir -p /backups

run_backup() {
  ts="$(date +%Y%m%d_%H%M%S)"
  file="/backups/sermon_clipper_${ts}.sql"

  if pg_dump > "$file"; then
    echo "Created backup $file"
  else
    echo "Backup failed" >&2
    rm -f "$file"
    return 1
  fi

  find /backups -type f -name "sermon_clipper_*.sql" -mmin "+${BACKUP_RETENTION_MINUTES}" -delete
}

on_shutdown() {
  echo "Shutdown signal received; running final backup"
  run_backup || true
  exit 0
}

trap on_shutdown TERM INT

while true; do
  run_backup || true
  sleep "$BACKUP_INTERVAL_SECONDS" &
  wait $!
done
