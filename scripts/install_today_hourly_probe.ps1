Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$fetchScript = Join-Path $PSScriptRoot "windows_fetch.ps1"
Set-Location $repoRoot

function Convert-JstDateTimeToLocal {
    param([datetime]$JstDateTime)

    $tokyo = [TimeZoneInfo]::FindSystemTimeZoneById("Tokyo Standard Time")
    $unspecified = [DateTime]::SpecifyKind($JstDateTime, [DateTimeKind]::Unspecified)
    $utc = [TimeZoneInfo]::ConvertTimeToUtc($unspecified, $tokyo)
    return [TimeZoneInfo]::ConvertTimeFromUtc($utc, [TimeZoneInfo]::Local)
}

$nowJst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(
    [DateTimeOffset]::UtcNow,
    "Tokyo Standard Time"
)
$todayJst = $nowJst.Date
$plannedJst = @(
    11..19 |
        ForEach-Object {
            [DateTime]::SpecifyKind(
                $todayJst.AddHours($_).AddMinutes(10),
                [DateTimeKind]::Unspecified
            )
        } |
        Where-Object { $_ -gt $nowJst.DateTime }
)

$taskName = "Rakuten Ranking Hourly Probe Today"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

if ($plannedJst.Count -gt 0) {
    $triggers = @(
        $plannedJst |
            ForEach-Object {
                New-ScheduledTaskTrigger -Once -At (Convert-JstDateTimeToLocal $_)
            }
    )
    $quotedScript = '"' + $fetchScript + '"'
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $quotedScript -Mode daily-probe"
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    $task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings `
        -Principal $principal `
        -Description "One-hour Rakuten daily rollover probes for $($todayJst.ToString('yyyy-MM-dd')) JST."

    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    $labels = ($plannedJst | ForEach-Object { $_.ToString("HH:mm") }) -join ", "
    Write-Host "Today's hourly JST probes installed: $labels"
}
else {
    Write-Host "No future hourly probe slots remain today."
}

Write-Host "Running one lightweight daily probe now..."
& $fetchScript -Mode "daily-probe"
