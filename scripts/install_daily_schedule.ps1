Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$fetchScript = Join-Path $PSScriptRoot "windows_fetch.ps1"
Set-Location $repoRoot

function Convert-JstTimeToLocal {
    param([int]$Hour)
    $tokyo = [TimeZoneInfo]::FindSystemTimeZoneById("Tokyo Standard Time")
    $dayJst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "Tokyo Standard Time").Date
    $jst = [DateTime]::SpecifyKind($dayJst.AddHours($Hour), [DateTimeKind]::Unspecified)
    $utc = [TimeZoneInfo]::ConvertTimeToUtc($jst, $tokyo)
    return [TimeZoneInfo]::ConvertTimeFromUtc($utc, [TimeZoneInfo]::Local)
}

$probeTriggers = @(15..23 | ForEach-Object {
    New-ScheduledTaskTrigger -Daily -At (Convert-JstTimeToLocal $_)
})
$quotedScript = '"' + $fetchScript + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $quotedScript -Mode daily-probe"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $probeTriggers -Settings $settings `
    -Principal $principal -Description "Probe hourly from 15:00 through 23:00 JST until today's complete daily ranking is published."

Register-ScheduledTask -TaskName "Rakuten Ranking Daily Probe" -InputObject $task -Force | Out-Null
Unregister-ScheduledTask -TaskName "Rakuten Ranking Daily" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Rakuten Ranking Hourly Probe Today" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Rakuten Ranking Hourly Probe 3 Days" -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Daily schedule updated successfully."
Write-Host "JST: first probe at 15:00; if not updated, retry hourly at 16:00 through 23:00."
Write-Host "After today's complete daily ranking is published, remaining probes skip the Rakuten API."
Write-Host "The realtime ranking task remains unchanged (every 20 minutes)."
Write-Host "Running one daily check now..."

& $fetchScript -Mode "daily-probe"
if ($LASTEXITCODE -ne 0) { throw "The immediate daily check failed." }
