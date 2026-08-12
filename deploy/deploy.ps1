<#
.SYNOPSIS
  DocFlow deploy: test -> zip -> SCM zipdeploy -> health verify.
  Uses the Kudu/SCM zipdeploy route (ARM deploy is blocked under Cloudflare WARP).

.EXAMPLE
  .\deploy\deploy.ps1 -App mw-docflow -ResourceGroup mw-docflow-rg
#>
param(
    [Parameter(Mandatory = $true)][string]$App,
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 1. Gate on the offline test suite — never ship untested code.
if (-not $SkipTests) {
    Write-Host "Running test suite..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Tests failed — deploy aborted." }
}

# 2. Production install (prunes devDependencies out of the payload).
Write-Host "Installing production dependencies..." -ForegroundColor Cyan
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

# 3. Build the zip (respecting .funcignore-style exclusions).
$zip = Join-Path $env:TEMP "docflow-deploy-$(Get-Date -Format yyyyMMdd-HHmmss).zip"
Write-Host "Creating package $zip..." -ForegroundColor Cyan
$exclude = @('.git', '.env', 'local.settings.json', 'coverage', 'deploy', 'src\tests')
$items = Get-ChildItem -Path $root -Force | Where-Object { $exclude -notcontains $_.Name }
Compress-Archive -Path $items.FullName -DestinationPath $zip -Force

# 4. Zipdeploy via SCM with publishing credentials.
Write-Host "Fetching publishing credentials..." -ForegroundColor Cyan
$creds = az webapp deployment list-publishing-credentials -n $App -g $ResourceGroup `
    --query "{u:publishingUserName, p:publishingPassword}" -o json | ConvertFrom-Json
$pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.u):$($creds.p)"))

Write-Host "Deploying to $App via SCM zipdeploy..." -ForegroundColor Cyan
# WebClient upload — Invoke-RestMethod corrupts binary payloads (known gotcha).
$wc = New-Object System.Net.WebClient
$wc.Headers.Add('Authorization', "Basic $pair")
$wc.UploadFile("https://$App.scm.azurewebsites.net/api/zipdeploy", 'PUT', $zip) | Out-Null

# 5. Verify health.
Write-Host "Waiting for the app to warm up..." -ForegroundColor Cyan
$healthy = $false
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 10
    try {
        $res = Invoke-WebRequest -Uri "https://$App.azurewebsites.net/api/health" -UseBasicParsing -TimeoutSec 15
        if ($res.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
}
Remove-Item $zip -Force -ErrorAction SilentlyContinue

# Restore dev dependencies locally.
npm install | Out-Null

if ($healthy) {
    Write-Host "DEPLOY OK — /api/health returned 200." -ForegroundColor Green
} else {
    throw "Deploy completed but /api/health never returned 200 — investigate (kill w3wp via Kudu to recover if stuck)."
}
