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
$firstDayJst = $nowJst.Date.AddDays(1)
$plannedJst = @(
    0..2 |
        ForEach-Object {
            $dayJst = $firstDayJst.AddDays($_)
            0..23 |
                Where-Object { $_ -notin @(10, 20) } |
                ForEach-Object {
                    [DateTime]::SpecifyKind(
                        $dayJst.AddHours($_),
                        [DateTimeKind]::Unspecified
                    )
                }
        }
)

$oldTaskName = "Rakuten Ranking Hourly Probe Today"
$taskName = "Rakuten Ranking Hourly Probe 3 Days"
Unregister-ScheduledTask -TaskName $oldTaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

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
$lastDayJst = $firstDayJst.AddDays(2)
$task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings `
    -Principal $principal `
    -Description "Hourly Rakuten daily rollover probes from $($firstDayJst.ToString('yyyy-MM-dd')) through $($lastDayJst.ToString('yyyy-MM-dd')) JST."

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Write-Host "Three full JST probe days installed:"
Write-Host "  Dates: $($firstDayJst.ToString('yyyy-MM-dd')) through $($lastDayJst.ToString('yyyy-MM-dd'))"
Write-Host "  Hourly: every full hour from 00:00 through 23:00 JST"
Write-Host "  10:00 and 20:00 use the existing daily-probe task to avoid duplicate runs."
Write-Host "Existing extra probes at 09:50, 10:10, 19:50 and 20:10 remain unchanged."
