param(
  [string]$TaskPrefix = "Powersa Logo",
  [string]$RunAs = "SYSTEM",
  [int]$StockIntervalMinutes = 5,
  [int]$CustomerIntervalMinutes = 1,
  [int]$LedgerIntervalMinutes = 5,
  [int]$CollectionIntervalMinutes = 1,
  [int]$PosSalesIntervalMinutes = 1,
  [int]$PosExpensesIntervalMinutes = 1,
  [int]$PosDayEndsIntervalMinutes = 1,
  [int]$DocumentsIntervalMinutes = 1,
  [string]$ProductsFullAt = "01:00",
  [string]$ProductImagesAt = "02:30",
  [switch]$SkipNightlyProducts,
  [switch]$SkipNightlyImages
)

$ErrorActionPreference = "Stop"

$SyncRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-Interval {
  param(
    [string]$Name,
    [int]$Value
  )

  if ($Value -lt 1) {
    throw "$Name en az 1 olmali."
  }
}

function New-RepeatingTrigger {
  param([int]$Minutes)

  return New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
}

function New-DailyTrigger {
  param([string]$At)

  return New-ScheduledTaskTrigger -Daily -At $At
}

function Register-LogoTask {
  param(
    [string]$Name,
    [string]$ScriptName,
    [Microsoft.Management.Infrastructure.CimInstance]$Trigger,
    [TimeSpan]$ExecutionTimeLimit
  )

  $scriptPath = Join-Path $SyncRoot $ScriptName
  if (-not (Test-Path $scriptPath)) {
    throw "Calistirici bulunamadi: $scriptPath"
  }

  $action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument ('/d /c "{0}"' -f $scriptPath) `
    -WorkingDirectory $SyncRoot

  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit $ExecutionTimeLimit

  Register-ScheduledTask `
    -TaskName $Name `
    -Action $action `
    -Trigger $Trigger `
    -Settings $settings `
    -User $RunAs `
    -RunLevel Highest `
    -Force | Out-Null

  Write-Host "[logo-sync-task] kaydedildi: $Name -> $ScriptName"
}

Assert-Interval -Name "StockIntervalMinutes" -Value $StockIntervalMinutes
Assert-Interval -Name "CustomerIntervalMinutes" -Value $CustomerIntervalMinutes
Assert-Interval -Name "LedgerIntervalMinutes" -Value $LedgerIntervalMinutes
Assert-Interval -Name "CollectionIntervalMinutes" -Value $CollectionIntervalMinutes
Assert-Interval -Name "PosSalesIntervalMinutes" -Value $PosSalesIntervalMinutes
Assert-Interval -Name "PosExpensesIntervalMinutes" -Value $PosExpensesIntervalMinutes
Assert-Interval -Name "PosDayEndsIntervalMinutes" -Value $PosDayEndsIntervalMinutes
Assert-Interval -Name "DocumentsIntervalMinutes" -Value $DocumentsIntervalMinutes

Register-LogoTask -Name "$TaskPrefix Product Stocks" -ScriptName "run-sync-product-stocks.cmd" -Trigger (New-RepeatingTrigger -Minutes $StockIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-LogoTask -Name "$TaskPrefix Customers Sync" -ScriptName "run-sync-customers.cmd" -Trigger (New-RepeatingTrigger -Minutes $CustomerIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-LogoTask -Name "$TaskPrefix Customers Export" -ScriptName "run-sync-customers-export.cmd" -Trigger (New-RepeatingTrigger -Minutes $CustomerIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-LogoTask -Name "$TaskPrefix Ledger Sync" -ScriptName "run-sync-ledger.cmd" -Trigger (New-RepeatingTrigger -Minutes $LedgerIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-LogoTask -Name "$TaskPrefix Collections Export" -ScriptName "run-sync-collections.cmd" -Trigger (New-RepeatingTrigger -Minutes $CollectionIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-LogoTask -Name "$TaskPrefix POS Sales Export" -ScriptName "run-sync-pos-sales.cmd" -Trigger (New-RepeatingTrigger -Minutes $PosSalesIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-LogoTask -Name "$TaskPrefix POS Expenses Export" -ScriptName "run-sync-pos-expenses.cmd" -Trigger (New-RepeatingTrigger -Minutes $PosExpensesIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-LogoTask -Name "$TaskPrefix POS Day Ends Export" -ScriptName "run-sync-pos-day-ends.cmd" -Trigger (New-RepeatingTrigger -Minutes $PosDayEndsIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-LogoTask -Name "$TaskPrefix Documents Export" -ScriptName "run-sync-documents-export.cmd" -Trigger (New-RepeatingTrigger -Minutes $DocumentsIntervalMinutes) -ExecutionTimeLimit (New-TimeSpan -Hours 1)

if (-not $SkipNightlyProducts) {
  Register-LogoTask -Name "$TaskPrefix Products Full Nightly" -ScriptName "run-sync-products.cmd" -Trigger (New-DailyTrigger -At $ProductsFullAt) -ExecutionTimeLimit (New-TimeSpan -Hours 4)
}

if (-not $SkipNightlyImages) {
  Register-LogoTask -Name "$TaskPrefix Product Images Nightly" -ScriptName "run-sync-product-images.cmd" -Trigger (New-DailyTrigger -At $ProductImagesAt) -ExecutionTimeLimit (New-TimeSpan -Hours 4)
}

Write-Host "[logo-sync-task] tamamlandi. Tum gorevlerde MultipleInstances=IgnoreNew ve WorkingDirectory=$SyncRoot kullanildi."
