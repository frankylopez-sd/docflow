# DOCFLOW DEPLOYMENT - FINAL WORKING METHOD
# Uses Kudu with proper authentication

Write-Host "🚀 DOCFLOW FINAL DEPLOYMENT" -ForegroundColor Cyan
Write-Host ""

# Get Kudu credentials
Write-Host "[1/5] Getting Kudu credentials..." -ForegroundColor Yellow
$profile = az functionapp deployment list-publishing-profiles `
  --name doc-automation-func `
  --resource-group doc-automation-rg `
  --query "[0]" -o json | ConvertFrom-Json

$user = $profile.userName
$pass = $profile.userPWD
$scmUrl = "doc-automation-func.scm.azurewebsites.net"

Write-Host "✓ Got Kudu credentials" -ForegroundColor Green
Write-Host "  User: $($user.Substring(0,10))..." -ForegroundColor Gray
Write-Host "  URL: $scmUrl" -ForegroundColor Gray

# Create deployment structure
Write-Host "`n[2/5] Preparing files..." -ForegroundColor Yellow
$deployDir = "$env:TEMP\docflow-deploy-$(Get-Random)"
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

# Copy functions
Get-ChildItem -Path "C:\Users\Franky.Lopez\docflow\src\functions" -Directory | ForEach-Object {
  Copy-Item -Path "$_" -Destination "$deployDir\$($_.Name)" -Recurse -Force
}
Write-Host "✓ Functions copied" -ForegroundColor Green

# Copy lib
Copy-Item -Path "C:\Users\Franky.Lopez\docflow\src\lib" -Destination "$deployDir\lib" -Recurse -Force
Write-Host "✓ Libraries copied" -ForegroundColor Green

# Copy config
Copy-Item -Path "C:\Users\Franky.Lopez\docflow\package.json", "C:\Users\Franky.Lopez\docflow\host.json" `
          -Destination "$deployDir\" -Force
Write-Host "✓ Configuration copied" -ForegroundColor Green

# Create ZIP
Write-Host "`n[3/5] Creating deployment package..." -ForegroundColor Yellow
$zipPath = "$env:TEMP\docflow-final.zip"
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

Compress-Archive -Path "$deployDir\*" -DestinationPath $zipPath -Force
$zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "✓ ZIP created ($zipSize MB)" -ForegroundColor Green

# Upload to Kudu
Write-Host "`n[4/5] Uploading to Kudu..." -ForegroundColor Yellow

$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$user`:$pass"))
$headers = @{
    "Authorization" = "Basic $auth"
    "Content-Type"  = "application/zip"
}

$kuduUrl = "https://$scmUrl/api/zipdeploy?isAsync=false"
Write-Host "  Target: $kuduUrl" -ForegroundColor Gray
Write-Host "  Uploading..." -NoNewline -ForegroundColor Gray

try {
    $response = Invoke-WebRequest -Uri $kuduUrl `
        -Method POST `
        -Headers $headers `
        -InFile $zipPath `
        -TimeoutSec 300 `
        -ErrorAction Stop

    Write-Host " ✓ HTTP $($response.StatusCode)" -ForegroundColor Green
    Write-Host "  Response: $($response.Content)" -ForegroundColor Gray

} catch {
    Write-Host " ✗" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Continuing anyway..." -ForegroundColor Yellow
}

# Wait for deployment
Write-Host "`n[5/5] Waiting for deployment..." -ForegroundColor Yellow
Start-Sleep -Seconds 60

# Test
Write-Host "`nTesting health endpoint..." -ForegroundColor Yellow
$attempts = 0
while ($attempts -lt 20) {
    try {
        $response = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
            -TimeoutSec 10 -ErrorAction SilentlyContinue

        if ($response.StatusCode -eq 200) {
            Write-Host "✅ HTTP 200 - DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
            $response.Content | ConvertFrom-Json | Format-List
            break
        } elseif ($response.StatusCode -eq 503) {
            Write-Host "  ⏳ Still deploying (HTTP 503)... wait 10s" -ForegroundColor Yellow
        } else {
            Write-Host "  ? HTTP $($response.StatusCode)" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  ⏳ Not ready yet... wait 10s" -ForegroundColor Yellow
    }

    $attempts++
    Start-Sleep -Seconds 10
}

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Cyan

if ($attempts -lt 20) {
    Write-Host "✅ DOCFLOW IS LIVE!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Test hire already created in Monday (Jane Doe)"
    Write-Host "  2. Webhook should auto-fire on Monday item updates"
    Write-Host "  3. Watch for status updates: Validated → PDF → Signed → Complete"
    Write-Host ""
    Write-Host "Webhook URL: https://doc-automation-func.azurewebsites.net/api/mondayWebhook" -ForegroundColor Cyan
} else {
    Write-Host "⚠ Deployment took too long or failed. Check:" -ForegroundColor Yellow
    Write-Host "  Azure Portal → Function App → Monitor → Errors" -ForegroundColor Gray
}

# Cleanup
Remove-Item -Path $deployDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
