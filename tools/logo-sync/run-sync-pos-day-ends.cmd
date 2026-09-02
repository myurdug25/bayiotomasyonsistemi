@echo off
setlocal

cd /d "%~dp0"

set "LOCKDIR=%~dp0.sync-pos-day-ends.lock"
mkdir "%LOCKDIR%" 2>nul
if errorlevel 1 (
  echo [%date% %time%] previous POS day-end export is still running; skipped. >> "%~dp0sync-pos-day-ends.log"
  exit /b 0
)

if not exist node_modules (
  call npm ci --omit=dev >> "%~dp0sync-pos-day-ends.log" 2>&1
  if errorlevel 1 (
    set "EXITCODE=%ERRORLEVEL%"
    rmdir "%LOCKDIR%" 2>nul
    exit /b %EXITCODE%
  )
)

call npm run sync:pos-day-ends >> "%~dp0sync-pos-day-ends.log" 2>&1
set "EXITCODE=%ERRORLEVEL%"

rmdir "%LOCKDIR%" 2>nul
if not "%EXITCODE%"=="0" exit /b %EXITCODE%

endlocal
