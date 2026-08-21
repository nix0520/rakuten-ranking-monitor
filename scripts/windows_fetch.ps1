param(
    [switch]$SkipPull
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
    Invoke-CheckedCommand git.exe pull --ff-only origin main
}

Invoke-CheckedCommand py.exe -3 scripts\fetch_rankings.py

$changes = (& git.exe status --porcelain -- data/latest.json data/history.json data/history) -join ""
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect ranking data changes."
}
if ([string]::IsNullOrWhiteSpace($changes)) {
    Write-Host "No ranking data changed. Nothing to publish."
    exit 0
}

Invoke-CheckedCommand git.exe config user.name "rakuten-ranking-bot"
Invoke-CheckedCommand git.exe config user.email "rakuten-ranking-bot@users.noreply.github.com"
Invoke-CheckedCommand git.exe add -- data/latest.json data/history.json data/history
$timestamp = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, "Tokyo Standard Time").ToString("yyyy-MM-dd HH:mm 'JST'")
Invoke-CheckedCommand git.exe commit -m "data: refresh Rakuten rankings ($timestamp)"
Invoke-CheckedCommand git.exe push origin HEAD:main

Write-Host "Ranking data was fetched and pushed successfully."
