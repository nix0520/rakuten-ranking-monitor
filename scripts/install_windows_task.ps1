Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
    throw "Python launcher (py.exe) was not found. Install Python 3 first."
}
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git was not found. Install Git for Windows first."
}

$applicationId = Read-Host "Rakuten Application ID"
$secureAccessKey = Read-Host "Rakuten Access Key" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAccessKey)
try {
    $accessKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

if ([string]::IsNullOrWhiteSpace($applicationId) -or [string]::IsNullOrWhiteSpace($accessKey)) {
    throw "Application ID and Access Key are required."
}

[Environment]::SetEnvironmentVariable("RAKUTEN_APPLICATION_ID", $applicationId.Trim(), "User")
[Environment]::SetEnvironmentVariable("RAKUTEN_ACCESS_KEY", $accessKey.Trim(), "User")
$env:RAKUTEN_APPLICATION_ID = $applicationId.Trim()
$env:RAKUTEN_ACCESS_KEY = $accessKey.Trim()

function Convert-JstTimeToLocal {
    param([int]$Hour, [int]$Minute)
    $tokyo = [TimeZoneInfo]::FindSystemTimeZoneById("Tokyo Standard Time")
    $day = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "Tokyo Standard Time").Date
    $jst = [DateTime]::SpecifyKind($day.AddHours($Hour).AddMinutes($Minute), [DateTimeKind]::Unspecified)
    $utc = [TimeZoneInfo]::ConvertTimeToUtc($jst, $tokyo)
    return [TimeZoneInfo]::ConvertTimeFromUtc($utc, [TimeZoneInfo]::Local)
}

function New-RankingAction {
    param([string]$Mode)
    $fetchScript = Join-Path $PSScriptRoot "windows_fetch.ps1"
    $quotedScript = '"' + $fetchScript + '"'
    return New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $quotedScript -Mode $Mode"
}

$probeTriggers = @(
    16..23 | ForEach-Object { New-ScheduledTaskTrigger -Daily -At (Convert-JstTimeToLocal $_ 0) }
)
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At (Convert-JstTimeToLocal 15 0)
$realtimeStart = Convert-JstTimeToLocal 0 5
$realtimeTrigger = New-ScheduledTaskTrigger -Once -At $realtimeStart `
    -RepetitionInterval (New-TimeSpan -Minutes 20) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

$dailyTask = New-ScheduledTask -Action (New-RankingAction "daily") -Trigger $dailyTrigger -Settings $settings -Principal $principal -Description "Fetch complete daily rankings directly at 15:00 JST."
$probeTask = New-ScheduledTask -Action (New-RankingAction "daily-probe") -Trigger $probeTriggers -Settings $settings -Principal $principal -Description "Probe hourly from 16:00 through 23:00 JST until today's complete daily ranking is published."
$realtimeTask = New-ScheduledTask -Action (New-RankingAction "realtime") -Trigger $realtimeTrigger -Settings $settings -Principal $principal -Description "Fetch all 17 realtime rankings every 20 minutes."

Unregister-ScheduledTask -TaskName "Rakuten Ranking Monitor" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "Rakuten Ranking Daily Probe" -InputObject $probeTask -Force | Out-Null
Register-ScheduledTask -TaskName "Rakuten Ranking Daily" -InputObject $dailyTask -Force | Out-Null
Unregister-ScheduledTask -TaskName "Rakuten Ranking Hourly Probe Today" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Rakuten Ranking Hourly Probe 3 Days" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "Rakuten Ranking Realtime" -InputObject $realtimeTask -Force | Out-Null

Write-Host "Scheduled task installed successfully."
Write-Host "JST full daily fetch: 15:00 directly (no preliminary probe)"
Write-Host "JST fallback probes: 16:00 through 23:00 hourly; skip after today is complete"
Write-Host "JST realtime 17-genre rankings: every 20 minutes at :05, :25, :45"
Write-Host "Running a lightweight daily probe now..."

& (Join-Path $PSScriptRoot "windows_fetch.ps1") -Mode "daily-probe"
if ($LASTEXITCODE -ne 0) {
    throw "The first ranking fetch failed."
}
