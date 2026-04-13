@echo off
setlocal EnableExtensions

cd /d "%~dp0.."

if not exist backups\postgres mkdir backups\postgres
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TIMESTAMP=%%I"
set "BACKUP_FILE=backups\postgres\sermon_clipper_%TIMESTAMP%.sql"

docker compose up -d postgres >nul
if errorlevel 1 (
  echo Failed to start postgres service for backup.
  exit /b 1
)

docker compose exec -T postgres pg_dump -U sermon_clipper -d sermon_clipper > "%BACKUP_FILE%"
if errorlevel 1 (
  if exist "%BACKUP_FILE%" del "%BACKUP_FILE%"
  echo Postgres backup failed.
  exit /b 1
)

echo Postgres backup created: %BACKUP_FILE%
exit /b 0
