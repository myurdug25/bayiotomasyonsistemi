@echo off
setlocal

cd /d "%~dp0"

if "%SYNC_PRODUCTS_TARGET_REFS%%SYNC_PRODUCTS_TARGET_CODES%"=="" (
  echo [logo-sync] SYNC_PRODUCTS_TARGET_REFS veya SYNC_PRODUCTS_TARGET_CODES set edilmelidir.
  echo Ornek: set "SYNC_PRODUCTS_TARGET_REFS=13941,9123"
  exit /b 1
)

if not exist ".env" (
  echo [logo-sync] .env bulunamadi. Bu dosyayi C:\PowersaB2B\tools\logo-sync\.env altinda olusturun.
  exit /b 1
)

if not exist node_modules (
  call npm ci --omit=dev
  if errorlevel 1 exit /b %ERRORLEVEL%
)

set "SYNC_DISABLE_LOCK=true"
set "SYNC_PRODUCTS_CATALOG_INCREMENTAL=false"
set "SYNC_PRODUCTS_STOCK_FAST=false"
set "SYNC_PRODUCTS_STOCK_INCREMENTAL=false"
if "%SYNC_PRODUCTS_STOCK_ONLY%"=="" set "SYNC_PRODUCTS_STOCK_ONLY=true"
set "SYNC_PRODUCTS_STOCK_SKIP_MOVEMENT_FALLBACK=true"
set "SYNC_PRODUCTS_STOCK_REQUIRE_SUMMARY_ROW=true"
set "SYNC_PRODUCTS_STOCK_INCLUDE_PRICE=false"
set "SYNC_PRODUCTS_IMAGES_ONLY=false"
set "SYNC_RESUME=false"
set "SYNC_BATCH_SIZE=10"
set "SYNC_RETRY_MAX=3"
set "SYNC_RETRY_BASE_DELAY_MS=3000"
set "SYNC_CONTINUE_ON_ERROR=false"

call npm run sync:products
exit /b %ERRORLEVEL%
