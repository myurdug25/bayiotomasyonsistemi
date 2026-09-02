param(
  [string]$TaskName = "Powersa Logo Sync Daemon",
  [string]$RunAs = "SYSTEM",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$SyncRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $SyncRoot "run-sync-daemon.cmd"

if (-not (Test-Path $scriptPath)) {
  throw "Calistirici bulunamadi: $scriptPath"
}

$taskCommand = 'cmd.exe /c "{0}"' -f $scriptPath

$arguments = @(
  "/Create"
  "/TN", $TaskName
  "/SC", "ONSTART"
  "/TR", $taskCommand
  "/RU", $RunAs
  "/RL", "HIGHEST"
  "/F"
)

& schtasks.exe @arguments

if ($LASTEXITCODE -ne 0) {
  throw "Daemon task kaydi olusturulamadi. schtasks exit code: $LASTEXITCODE"
}

Write-Host "[logo-sync-daemon] task kaydedildi: $TaskName (ONSTART / $RunAs)"

$taskSettings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Set-ScheduledTask -TaskName $TaskName -Settings $taskSettings | Out-Null
Write-Host "[logo-sync-daemon] otomatik yeniden baslatma etkin: 1 dakika aralikla"

if (-not $NoStart) {
  & schtasks.exe /Run /TN $TaskName

  if ($LASTEXITCODE -ne 0) {
    throw "Daemon task baslatilamadi. schtasks exit code: $LASTEXITCODE"
  }

  Write-Host "[logo-sync-daemon] task baslatildi: $TaskName"
}
