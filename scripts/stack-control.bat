@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"
set "FLAG=%~2"

if /I "%ACTION%"=="start" goto START
if /I "%ACTION%"=="stop" goto STOP
if /I "%ACTION%"=="restart" goto RESTART
if /I "%ACTION%"=="status" goto STATUS
if /I "%ACTION%"=="logs" goto LOGS
if /I "%ACTION%"=="backup" goto BACKUP
goto USAGE

:START
if /I "%FLAG%"=="--no-build" (
  docker compose up -d
) else (
  docker compose up --build -d
)
if errorlevel 1 exit /b 1
call :PRINT_URLS
exit /b 0

:STOP
if /I not "%FLAG%"=="--skip-backup" (
  call scripts\db-backup.bat
  if errorlevel 1 exit /b 1
)
if /I "%FLAG%"=="--volumes" (
  docker compose down -v
) else (
  docker compose down
)
exit /b %errorlevel%

:RESTART
if /I not "%FLAG%"=="--skip-backup" (
  call scripts\db-backup.bat
  if errorlevel 1 exit /b 1
)
if /I "%FLAG%"=="--volumes" (
  docker compose down -v
) else (
  docker compose down
)
if errorlevel 1 exit /b 1
if /I "%FLAG%"=="--no-build" (
  docker compose up -d
) else (
  docker compose up --build -d
)
if errorlevel 1 exit /b 1
call :PRINT_URLS
exit /b 0

:STATUS
docker compose ps
exit /b %errorlevel%

:LOGS
docker compose logs -f --tail 200
exit /b %errorlevel%

:BACKUP
call scripts\db-backup.bat
exit /b %errorlevel%

:PRINT_URLS
set "LAN_IP="
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
  set "LAN_IP=%%I"
  set "LAN_IP=!LAN_IP: =!"
  set "LAN_IP=!LAN_IP:(Preferred)=!"
  goto PRINT_URLS_IP_FOUND
)

:PRINT_URLS_IP_FOUND
echo.
echo Service URLs
echo - Web UI (local): http://localhost:5173
echo - API (local): http://localhost:3000
if not defined LAN_IP goto PRINT_URLS_NO_LAN
echo - Web UI (LAN):   http://!LAN_IP!:5173
echo - API (LAN):      http://!LAN_IP!:3000
goto PRINT_URLS_DONE

:PRINT_URLS_NO_LAN
echo - LAN IP not detected automatically.

:PRINT_URLS_DONE
echo.
echo If LAN access fails, allow inbound TCP 5173 and 3000 in your firewall.
exit /b 0

:USAGE
echo Usage:
echo   scripts\stack-control.bat start [--no-build]
echo   scripts\stack-control.bat stop [--volumes ^| --skip-backup]
echo   scripts\stack-control.bat restart [--no-build ^| --volumes ^| --skip-backup]
echo   scripts\stack-control.bat status
echo   scripts\stack-control.bat logs
echo   scripts\stack-control.bat backup
exit /b 1
