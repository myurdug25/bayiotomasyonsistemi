@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rotate-sync-daemon-log.ps1"

if not exist node_modules (
  call npm ci --omit=dev >> "%~dp0sync-daemon.log" 2>&1
  if errorlevel 1 (
    exit /b %ERRORLEVEL%
  )
)

node logo-sync-daemon.mjs >> "%~dp0sync-daemon.log" 2>&1
exit /b %ERRORLEVEL%
