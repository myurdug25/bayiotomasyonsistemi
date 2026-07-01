@echo off
REM Kampanya verilerini Logo ERP'den B2B sistemine sync eder
REM Kullanım: run-sync-campaigns.cmd [--dry-run]

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

node logo-campaigns-sync.mjs %*
