Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Warning "The temporary three-day probe installer has been replaced by the permanent daily schedule."
& (Join-Path $PSScriptRoot "install_daily_schedule.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "The permanent daily schedule installer failed."
}
