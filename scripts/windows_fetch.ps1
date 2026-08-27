param(
    [switch]$SkipPull,
    [ValidateSet("daily", "daily-probe", "realtime")]
    [string]$Mode = "daily"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$mutex = New-Object System.Threading.Mutex($false, "Local\\RakutenRankingMonitorFetch")
$mutexAcquired = $false
try {
    try {
        $mutexAcquired = $mutex.WaitOne((New-TimeSpan -Hours 2))
    }
    catch [System.Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
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
    Invoke-CheckedCommand git.exe pull --rebase origin main
}

Invoke-CheckedCommand py.exe -3 scripts\fetch_rankings.py --mode $Mode

$changes = (& git.exe status --porcelain -- data) -join ""
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect ranking data changes."
}
if ([string]::IsNullOrWhiteSpace($changes)) {
    Write-Host "No ranking data changed. Nothing to publish."
    return
}

Invoke-CheckedCommand git.exe config user.name "rakuten-ranking-bot"
Invoke-CheckedCommand git.exe config user.email "rakuten-ranking-bot@users.noreply.github.com"
Invoke-CheckedCommand git.exe add -- data
$timestamp = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "Tokyo Standard Time").ToString("yyyy-MM-dd HH:mm 'JST'")
Invoke-CheckedCommand git.exe commit -m "data: refresh Rakuten $Mode rankings ($timestamp)"
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

Write-Host "Rakuten $Mode data was fetched and pushed successfully."
}
finally {
    if ($mutexAcquired) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
