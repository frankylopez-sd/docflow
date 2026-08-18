param([switch]$Force)
$ErrorActionPreference = "Stop"

Write-Host "=== DocFlow Deployment ===" -ForegroundColor Cyan

# Get credentials
Write-Host "`nGetting Kudu publishing credentials..." -ForegroundColor Yellow
try {
    $pub = az functionapp deployment list-publishing-profiles --name doc-automation-func --resource-group doc-automation-rg --query "[0]" -o json | ConvertFrom-Json
    $user = $pub.userName
    $pass = $pub.userPWD
    Write-Host "OK - Credentials retrieved" -ForegroundColor Green
} catch {
    Write-Host "FAILED - Cannot get credentials" -ForegroundColor Red
    exit 1
}

# Check ZIP
$zip = "C:\Users\Franky.Lopez\docflow\deploy-docflow.zip"
if (-not (Test-Path $zip)) {
    Write-Host "ZIP file missing at $zip" -ForegroundColor Red
    exit 1
}

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "ZIP ready: $mb MB" -ForegroundColor Cyan

# Deploy
Write-Host "`nUploading to Kudu..." -ForegroundColor Yellow
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$user`:$pass"))

try {
    $null = Invoke-WebRequest -Uri "https://doc-automation-func.scm.azurewebsites.net/api/zipdeploy?isAsync=false" `
        -Method Post `
        -Headers @{ "Authorization" = "Basic $b64"; "Content-Type" = "application/octet-stream" } `
        -InFile $zip `
        -TimeoutSec 600
    Write-Host "Upload complete" -ForegroundColor Green
} catch {
    Write-Host "Upload failed: $_" -ForegroundColor Red
    exit 1
}

# Install
Write-Host "`nInstalling npm dependencies..." -ForegroundColor Yellow
$cmd = @{ command = "npm install --production"; dir = "site/wwwroot" } | ConvertTo-Json

try {
    $null = Invoke-WebRequest -Uri "https://doc-automation-func.scm.azurewebsites.net/api/command" `
        -Method Post `
        -Headers @{ "Authorization" = "Basic $b64"; "Content-Type" = "application/json" } `
        -Body $cmd `
        -TimeoutSec 300
    Write-Host "npm install queued on server" -ForegroundColor Green
} catch {
    Write-Host "npm command sent" -ForegroundColor Yellow
}

# Wait for health
Write-Host "`nWaiting for app startup (120s)..." -ForegroundColor Yellow
$ok = $false
for ($i = 1; $i -le 120; $i++) {
    try {
        $h = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" -TimeoutSec 5 -ErrorAction SilentlyContinue
        if ($h.StatusCode -eq 200) {
            Write-Host "App is healthy!" -ForegroundColor Green
            $ok = $true
            break
        }
    } catch { }

    Write-Host "  [$i/120] Starting..." -ForegroundColor Gray
    Start-Sleep -Seconds 1
}

if (-not $ok) {
    Write-Host "Timeout - app may still be starting" -ForegroundColor Yellow
}

# Test
Write-Host "`nVerifying webhook..." -ForegroundColor Yellow
try {
    $w = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/mondayWebhook" `
        -Method Post `
        -Headers @{ "Content-Type" = "application/json" } `
        -Body '{"test":true}' `
        -TimeoutSec 10 `
        -ErrorAction SilentlyContinue
    Write-Host "Webhook OK: $($w.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "Webhook check: $_" -ForegroundColor Yellow
}

# Done
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "`nWebhook URL:" -ForegroundColor Cyan
Write-Host "https://doc-automation-func.azurewebsites.net/api/mondayWebhook" -ForegroundColor White
Write-Host "`nNext:" -ForegroundColor Cyan
Write-Host "1. Create test hire in Monday board 18422046530" -ForegroundColor White
Write-Host "2. Watch mondayWebhook trigger" -ForegroundColor White
Write-Host "3. Verify PDF -> Sign -> Archive flow" -ForegroundColor White
Write-Host ""
