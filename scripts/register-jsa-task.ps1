# =============================================================================
# register-jsa-task.ps1 - (re)register the local JSA scheduled task
#
# The Windows scheduled task "Performance Forge - JSA Job Creation (monthly)"
# existed ONLY on this laptop, with no registration script in the repo - a
# machine rebuild (or moving the repo) would silently lose the monthly JSA run
# and the only symptom would be the watchdog's "JSA local run missed" flag a
# month later. Run this script ONCE from PowerShell to restore/repair it:
#
#   powershell -ExecutionPolicy Bypass -File scripts\register-jsa-task.ps1
#
# The task runs scripts\run-jsa-jobcreation.cmd (which cd's to the repo root,
# runs ingest-jsa-jobcreation.mjs --write, and appends to
# logs\jsa-jobcreation.log) on day 10 of every month at 12:00 - jobsandskills
# .gov.au blocks the GitHub CI runner IPs, so this ingest MUST run locally.
# Idempotent: an existing task with the same name is replaced.
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less scripts as
# ANSI, so UTF-8 em-dashes decode into stray quote characters and break parsing.
# =============================================================================
$ErrorActionPreference = 'Stop'

$taskName = 'Performance Forge - JSA Job Creation (monthly)'
# resolve the repo root from this script's own location (scripts\ -> repo root)
$repoRoot = Split-Path -Parent $PSScriptRoot
$cmdPath  = Join-Path $repoRoot 'scripts\run-jsa-jobcreation.cmd'
if (-not (Test-Path $cmdPath)) { Write-Error "Not found: $cmdPath - run this from the repo copy that has scripts\run-jsa-jobcreation.cmd." }

# replace any existing registration so the script is safe to re-run
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$taskName'..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# day 10 monthly at 12:00 - same day as the GATHER cron, so Forge gets the
# fresh JSA data in the same monthly window. Run through cmd.exe /c (matches
# the original registration; more reliable than executing a .cmd directly).
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmdPath`"" -WorkingDirectory $repoRoot

# New-ScheduledTaskTrigger has no -Monthly in PowerShell 5.1 - build the CIM
# monthly trigger directly. DaysOfMonth/MonthOfYear are BITMASKS:
# day 10 = 1 -shl 9 = 512; all 12 months = 0xFFF.
$trigger = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskMonthlyTrigger -Namespace Root/Microsoft/Windows/TaskScheduler) -ClientOnly
$trigger.DaysOfMonth   = [uint16](1 -shl 9)          # day 10
$trigger.MonthOfYear   = [uint16]0xFFF               # all 12 months
$trigger.StartBoundary = (Get-Date -Day 10 -Hour 12 -Minute 0 -Second 0 -Millisecond 0).ToString('yyyy-MM-ddTHH:mm:ss')
$trigger.Enabled       = $true

# StartWhenAvailable: a laptop asleep at noon still runs the ingest on wake
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Write-Host "Registered '$taskName' - runs $cmdPath on day 10 monthly at 12:00."
Write-Host "Check it: Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
