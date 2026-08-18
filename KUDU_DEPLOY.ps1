# KUDU VFS DEPLOYMENT - Direct file upload (proven method from SlideGen)
# This bypasses func CLI issues and directly uploads files via Kudu VFS

param(
    [string]$AccessToken = ""
)

$appName = "doc-automation-func"
$kuduUrl = "https://$appName.scm.azurewebsites.net"
$apiUrl = "$kuduUrl/api/vfs/site/wwwroot"

Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║            KUDU VFS DEPLOYMENT - Direct Upload                 ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

# Get access token if not provided
if (-not $AccessToken) {
    Write-Host "`nGetting Azure access token..." -ForegroundColor Yellow
    $tokenResp = az account get-access-token --resource https://management.azure.com --query accessToken -o tsv 2>&1
    if ($tokenResp -match "^eyJ") {
        $AccessToken = $tokenResp
        Write-Host "✓ Token acquired" -ForegroundColor Green
    } else {
        Write-Host "✗ Could not get token. Try: az account get-access-token" -ForegroundColor Red
        exit 1
    }
}

$headers = @{
    "Authorization" = "Bearer $AccessToken"
    "Content-Type"  = "application/json"
}

Write-Host "`nPreparing deployment files..." -ForegroundColor Yellow

# Copy functions to temp deploy folder with proper structure
$deployDir = "$env:TEMP\docflow-kudu-$(Get-Random)"
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

# Copy each function
Get-ChildItem -Path "C:\Users\Franky.Lopez\docflow\src\functions" -Directory | ForEach-Object {
    $funcName = $_.Name
    Copy-Item -Path "C:\Users\Franky.Lopez\docflow\src\functions\$funcName" `
              -Destination "$deployDir\$funcName" -Recurse -Force
    Write-Host "  ✓ $funcName" -ForegroundColor Green
}

# Copy lib
Copy-Item -Path "C:\Users\Franky.Lopez\docflow\src\lib" `
          -Destination "$deployDir\lib" -Recurse -Force
Write-Host "  ✓ lib/" -ForegroundColor Green

# Copy config files
Copy-Item -Path "C:\Users\Franky.Lopez\docflow\package.json" -Destination "$deployDir\" -Force
Copy-Item -Path "C:\Users\Franky.Lopez\docflow\host.json" -Destination "$deployDir\" -Force
Write-Host "  ✓ package.json, host.json" -ForegroundColor Green

Write-Host "`nUploading to Kudu VFS..." -ForegroundColor Yellow

# Create a ZIP of the deployment
$zipPath = "$env:TEMP\docflow-kudu.zip"
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$deployDir\*" -DestinationPath $zipPath -Force

$zipBytes = [System.IO.File]::ReadAllBytes($zipPath)
$base64Zip = [System.Convert]::ToBase64String($zipBytes)

# Upload via Kudu VFS using /api/zipdeploy
$deployUrl = "$kuduUrl/api/zipdeploy"
Write-Host "  Uploading to: $deployUrl" -ForegroundColor Gray

try {
    $response = Invoke-WebRequest -Uri $deployUrl `
        -Method POST `
        -Headers $headers `
        -InFile $zipPath `
        -ContentType "application/zip" `
        -ErrorAction Stop

    Write-Host "  ✓ Upload successful (HTTP $($response.StatusCode))" -ForegroundColor Green

    Write-Host "`nWaiting 45 seconds for deployment..." -ForegroundColor Yellow
    Start-Sleep -Seconds 45

    Write-Host "`nTesting health endpoint..." -ForegroundColor Yellow
    $health = Invoke-WebRequest -Uri "https://$appName.azurewebsites.net/api/health" `
        -TimeoutSec 10 -ErrorAction SilentlyContinue

    if ($health.StatusCode -eq 200) {
        Write-Host "✓ HTTP 200 - DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
        Write-Host "`n✅ DocFlow is now LIVE and responding" -ForegroundColor Cyan
    } else {
        Write-Host "⚠ HTTP $($health.StatusCode)" -ForegroundColor Yellow
    }

} catch {
    Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "`nTrying alternative method..." -ForegroundColor Yellow
}

# Cleanup
Remove-Item -Path $deployDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
