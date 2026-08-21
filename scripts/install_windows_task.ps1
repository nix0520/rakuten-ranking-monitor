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

$tokyo = [TimeZoneInfo]::FindSystemTimeZoneById("Tokyo Standard Time")
$todayInTokyo = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "Tokyo Standard Time").Date
$tokyoTime = [DateTime]::SpecifyKind($todayInTokyo.AddHours(18).AddMinutes(15), [DateTimeKind]::Unspecified)
$utcTime = [TimeZoneInfo]::ConvertTimeToUtc($tokyoTime, $tokyo)
$localTime = [TimeZoneInfo]::ConvertTimeFromUtc($utcTime, [TimeZoneInfo]::Local)
$trigger = New-ScheduledTaskTrigger -Daily -At $localTime

$fetchScript = Join-Path $PSScriptRoot "windows_fetch.ps1"
$quotedScript = '"' + $fetchScript + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $quotedScript"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Fetch the daily Rakuten rankings at 18:15 JST."

Register-ScheduledTask -TaskName "Rakuten Ranking Monitor" -InputObject $task -Force | Out-Null

Write-Host "Scheduled task installed successfully."
Write-Host "JST schedule: daily at 18:15"
Write-Host "Running the first fetch now..."

& (Join-Path $PSScriptRoot "windows_fetch.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "The first ranking fetch failed."
}
