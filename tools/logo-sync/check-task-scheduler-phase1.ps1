param(
  [string]$SyncRoot = "C:\PowersaB2B\tools\logo-sync",
  [int]$LogTail = 20,
  [int]$FailedTail = 10
)

$ErrorActionPreference = "Continue"

$Tasks = @(
  @{
    Name = "Powersa Logo Product Stocks Fast"
    LogFile = "sync-product-stocks-fast.log"
    LockPath = ".sync-product-stocks-fast.lock"
    StateFile = ".sync-state\products-stock-fast-state.json"
  },
  @{
    Name = "Powersa Logo Product Catalog Fast"
    LogFile = "sync-product-catalog-fast.log"
    LockPath = ".sync-product-catalog-fast.lock"
    StateFile = ".sync-state\products-sync-state.json"
  },
  @{
    Name = "Powersa Logo Customers Sync"
    LogFile = "sync-customers.log"
    LockPath = ".sync-customers.lock"
  },
  @{
    Name = "Powersa Logo Customers Export"
    LogFile = "sync-customers-export.log"
    LockPath = ".sync-customers-export.lock"
  },
  @{
    Name = "Powersa Logo Ledger Sync"
    LogFile = "sync-ledger.log"
    LockPath = ".sync-ledger.lock"
  },
  @{
    Name = "Powersa Logo Collections Export"
    LogFile = "sync-collections.log"
    LockPath = ".sync-collections.lock"
  },
  @{
    Name = "Powersa Logo POS Sales Export"
    LogFile = "sync-pos-sales.log"
    LockPath = ".sync-pos-sales.lock"
  },
  @{
    Name = "Powersa Logo POS Expenses Export"
    LogFile = "sync-pos-expenses.log"
    LockPath = ".sync-pos-expenses.lock"
  },
  @{
    Name = "Powersa Logo POS Day Ends Export"
    LogFile = "sync-pos-day-ends.log"
    LockPath = ".sync-pos-day-ends.lock"
  },
  @{
    Name = "Powersa Logo Documents Export"
    LogFile = "sync-documents-export.log"
    LockPath = ".sync-documents-export.lock"
  }
)

$FailedFiles = @(
  ".sync-state\products-sync-failed.jsonl"
)

Write-Host ""
Write-Host "Powersa Logo Sync Task Scheduler Phase 1 check"
Write-Host "Sync root: $SyncRoot"
Write-Host ""

foreach ($taskInfo in $Tasks) {
  Write-Host "============================================================"
  Write-Host $taskInfo.Name
  Write-Host "============================================================"

  $task = Get-ScheduledTask -TaskName $taskInfo.Name -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Host "Task: MISSING"
  } else {
    $taskRun = Get-ScheduledTaskInfo -TaskName $taskInfo.Name -ErrorAction SilentlyContinue
    Write-Host ("Task: {0}" -f $task.State)
    if ($null -ne $taskRun) {
      Write-Host ("LastRunTime: {0}" -f $taskRun.LastRunTime)
      Write-Host ("LastTaskResult: {0}" -f $taskRun.LastTaskResult)
      Write-Host ("NextRunTime: {0}" -f $taskRun.NextRunTime)
    }
  }

  $lockPath = Join-Path $SyncRoot $taskInfo.LockPath
  if (Test-Path $lockPath) {
    Write-Host ("WARNING: lock exists: {0}" -f $lockPath)
  }

  if ($taskInfo.StateFile) {
    $statePath = Join-Path $SyncRoot $taskInfo.StateFile
    Write-Host ("State: {0}" -f $statePath)
    if (Test-Path $statePath) {
      Get-Content $statePath -Tail $LogTail
    } else {
      Write-Host "State file not found."
    }
  }

  $logPath = Join-Path $SyncRoot $taskInfo.LogFile
  Write-Host ("Log: {0}" -f $logPath)

  if (Test-Path $logPath) {
    Get-Content $logPath -Tail $LogTail
  } else {
    Write-Host "Log file not found."
  }

  Write-Host ""
}

Write-Host "============================================================"
Write-Host "Failed files"
Write-Host "============================================================"

foreach ($failedFile in $FailedFiles) {
  $failedPath = Join-Path $SyncRoot $failedFile
  Write-Host ("Failed file: {0}" -f $failedPath)

  if (Test-Path $failedPath) {
    Get-Content $failedPath -Tail $FailedTail
  } else {
    Write-Host "No failed file found."
  }

  Write-Host ""
}

Write-Host "Phase 1 check completed."
