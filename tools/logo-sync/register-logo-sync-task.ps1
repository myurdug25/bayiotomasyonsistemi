param(
  [string]$TaskName = "Powersa Logo Sync",
  [int]$IntervalMinutes = 5,
  [ValidateSet("customers", "customers-export", "products", "product-stocks", "product-images", "ledger", "collections", "pos-sales", "pos-expenses", "pos-day-ends", "documents-export", "all")]
  [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"

$SyncRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$scriptMap = @{
  customers = "run-sync-customers.cmd"
  "customers-export" = "run-sync-customers-export.cmd"
  products = "run-sync-products.cmd"
  "product-stocks" = "run-sync-product-stocks.cmd"
  "product-images" = "run-sync-product-images.cmd"
  ledger = "run-sync-ledger.cmd"
  collections = "run-sync-collections.cmd"
  "pos-sales" = "run-sync-pos-sales.cmd"
  "pos-expenses" = "run-sync-pos-expenses.cmd"
  "pos-day-ends" = "run-sync-pos-day-ends.cmd"
  "documents-export" = "run-sync-documents-export.cmd"
  all = "run-sync-all.cmd"
}

$scriptName = $scriptMap[$Mode]
$scriptPath = Join-Path $SyncRoot $scriptName

if (-not (Test-Path $scriptPath)) {
  throw "Calistirici bulunamadi: $scriptPath"
}

if ($IntervalMinutes -lt 1) {
  throw "IntervalMinutes en az 1 olmali."
}

$startTime = (Get-Date).AddMinutes(1).ToString("HH:mm")
$taskCommand = 'cmd.exe /c "{0}"' -f $scriptPath

$arguments = @(
  "/Create"
  "/TN", $TaskName
  "/SC", "MINUTE"
  "/MO", "$IntervalMinutes"
  "/ST", $startTime
  "/TR", $taskCommand
  "/RU", "SYSTEM"
  "/F"
)

& schtasks.exe @arguments

if ($LASTEXITCODE -ne 0) {
  throw "Task kaydi olusturulamadi. schtasks exit code: $LASTEXITCODE"
}

Write-Host "[logo-sync-task] task kaydedildi: $TaskName ($Mode / $IntervalMinutes dk / baslangic $startTime)"
