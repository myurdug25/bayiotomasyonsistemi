param(
  [long]$MaxBytes = 52428800
)

$ErrorActionPreference = "Stop"
$logPath = Join-Path $PSScriptRoot "sync-daemon.log"

if (-not (Test-Path -LiteralPath $logPath)) {
  exit 0
}

$log = Get-Item -LiteralPath $logPath
if ($log.Length -lt $MaxBytes) {
  exit 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archivePath = Join-Path $PSScriptRoot "sync-daemon-$stamp.log"
Move-Item -LiteralPath $logPath -Destination $archivePath
Write-Host "[logo-sync-daemon] buyuk log arsivlendi: $archivePath"
