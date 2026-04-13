@echo off
setlocal

cd /d "%~dp0.."
call scripts\stack-control.bat start --no-build
exit /b %errorlevel%
