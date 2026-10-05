param(
    [switch]$SkipPull,
    [ValidateSet("daily", "daily-probe", "realtime")]
    [string]$Mode = "daily"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$transcriptStarted = $false
$logRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "RakutenRankingMonitor\logs"
try {
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Get-ChildItem -Path $logRoot -Filter "*.log" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    $logTimestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logPath = Join-Path $logRoot "$logTimestamp-$Mode.log"
    Start-Transcript -Path $logPath -Append | Out-Null
    $transcriptStarted = $true
    Write-Host "Task log: $logPath"
}
catch {
    Write-Warning "Unable to start the persistent task log: $($_.Exception.Message)"
}

$mutex = New-Object System.Threading.Mutex($false, "RakutenRankingMonitorFetch")
$mutexAcquired = $false
try {
    try {
        # A realtime snapshot is disposable while a daily collection is active.
        # Do not queue it ahead of the hourly daily recovery task.
        $mutexWait = if ($Mode -eq "realtime") {
            New-TimeSpan -Seconds 1
        }
        else {
            New-TimeSpan -Minutes 55
        }
        $mutexAcquired = $mutex.WaitOne($mutexWait)
    }
    catch [System.Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
        if ($Mode -eq "realtime") {
            Write-Host "Another ranking fetch is running; realtime fetch skipped."
            return
        }
        throw "Timed out waiting for another ranking fetch to finish."
    }

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $Name @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Name $($Arguments -join ' ')"
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
    throw "Python launcher (py.exe) was not found. Install Python 3 and enable the Python launcher."
}
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git was not found. Install Git for Windows first."
}

$originUrl = (& git.exe remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $originUrl -notmatch "github\.com[/:]nix0520/rakuten-ranking-monitor(?:\.git)?$") {
    throw "This script must run from the nix0520/rakuten-ranking-monitor clone."
}
$currentBranch = (& git.exe branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $currentBranch -ne "main") {
    throw "Switch this repository to the main branch before running the scheduled fetch."
}

$applicationId = [Environment]::GetEnvironmentVariable("RAKUTEN_APPLICATION_ID", "User")
$accessKey = [Environment]::GetEnvironmentVariable("RAKUTEN_ACCESS_KEY", "User")
if ([string]::IsNullOrWhiteSpace($applicationId) -or [string]::IsNullOrWhiteSpace($accessKey)) {
    throw "Rakuten credentials are not configured. Run scripts\install_windows_task.ps1 first."
}

$env:RAKUTEN_APPLICATION_ID = $applicationId.Trim()
$env:RAKUTEN_ACCESS_KEY = $accessKey.Trim()

if (-not $SkipPull) {
    $pendingDataChanges = @(& git.exe status --porcelain -- data)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect unpublished ranking data before pulling."
    }
    if ($pendingDataChanges.Count -gt 0) {
        # A terminated fetch can leave a valid daily checkpoint in data/. Pulling
        # first would fail and permanently block every later recovery task.
        Write-Warning "Unpublished ranking checkpoint detected; preserving it and skipping the initial pull."
        Invoke-CheckedCommand git.exe fetch origin main
    }
    else {
        Invoke-CheckedCommand git.exe pull --rebase origin main
    }
}

$runRecoveryProbe = $false
if ($Mode -eq "realtime") {
    $realtimePath = Join-Path $repoRoot "data\realtime\latest.json"
    try {
        $realtime = Get-Content $realtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $lastRealtime = [DateTimeOffset]::Parse([string]$realtime.generatedAt)
        $runRecoveryProbe = ([DateTimeOffset]::UtcNow - $lastRealtime.ToUniversalTime()).TotalMinutes -gt 45
    }
    catch {
        $runRecoveryProbe = $true
    }
}

if ($runRecoveryProbe) {
    Write-Host "Realtime data is stale; checking for a recoverable daily ranking before resuming realtime."
    & py.exe -3 scripts\fetch_rankings.py --mode daily-probe
    if ($LASTEXITCODE -ne 0) {
        throw "Recovery daily probe failed."
    }
}

& py.exe -3 scripts\fetch_rankings.py --mode $Mode
$fetchExitCode = $LASTEXITCODE

$changes = (& git.exe status --porcelain -- data) -join ""
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect ranking data changes."
}
if ([string]::IsNullOrWhiteSpace($changes)) {
    Write-Host "No ranking data changed. Nothing to publish."
}

if (-not [string]::IsNullOrWhiteSpace($changes)) {
    Invoke-CheckedCommand git.exe config user.name "rakuten-ranking-bot"
    Invoke-CheckedCommand git.exe config user.email "rakuten-ranking-bot@users.noreply.github.com"
    Invoke-CheckedCommand git.exe add -- data
    $timestamp = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "Tokyo Standard Time").ToString("yyyy-MM-dd HH:mm 'JST'")
    Invoke-CheckedCommand git.exe commit -m "data: refresh Rakuten $Mode rankings ($timestamp)"
}

# Recover a run that was terminated after commit but before push. Without this
# check, the next run would see a clean worktree and incorrectly do nothing.
$aheadText = (& git.exe rev-list --count origin/main..HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect unpublished local commits."
}
$aheadCount = [int]$aheadText
if ($aheadCount -gt 0) {
    Write-Host "Publishing $aheadCount local commit(s)..."
    $published = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        & git.exe push origin HEAD:main
        if ($LASTEXITCODE -eq 0) {
            $published = $true
            break
        }
        if ($attempt -lt 3) {
            Write-Host "Push raced with another update; rebasing and retrying ($attempt/3)..."
            Start-Sleep -Seconds 2
            Invoke-CheckedCommand git.exe pull --rebase origin main
        }
    }
    if (-not $published) {
        throw "Unable to push ranking data after 3 attempts."
    }
}

Write-Host "Rakuten $Mode data was fetched and pushed successfully."
if ($fetchExitCode -ne 0) {
    throw "Ranking fetch failed; diagnostic data was published for the next retry."
}
}
finally {
    if ($mutexAcquired) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
    if ($transcriptStarted) {
        try {
            Stop-Transcript | Out-Null
        }
        catch {
            # Logging must never turn a successful collection into a failed task.
        }
    }
}
