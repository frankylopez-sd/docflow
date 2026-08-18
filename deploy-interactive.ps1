# Run this manually in PowerShell (not as admin needed)
# It will open Kudu, let you auth, then deploy automatically

# Step 1: Open Kudu for auth
Write-Host "Opening Kudu console..." -ForegroundColor Cyan
Start-Process "https://doc-automation-func.scm.azurewebsites.net/DebugConsole"

# Step 2: Wait for auth
Write-Host "`nIMPORTANT:" -ForegroundColor Yellow
Write-Host "1. Sign in with your Azure credentials in the browser that opened" -ForegroundColor White
Write-Host "2. Wait for Kudu console to load (shows cmd prompt)" -ForegroundColor White
Write-Host "3. Come back here and press ENTER" -ForegroundColor White
Write-Host "`nWaiting..." -ForegroundColor Gray
Read-Host "Press ENTER when you see the Kudu cmd console"

# Step 3: Upload ZIP via Kudu API (now with auth cookies from browser)
Write-Host "`nDeploying..." -ForegroundColor Yellow

$zip = "C:\Users\Franky.Lopez\docflow\deploy-docflow.zip"
$kuduUrl = "https://doc-automation-func.scm.azurewebsites.net/api/zipdeploy?isAsync=false"

# Create session with credentials from browser
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

try {
    # Upload
    Write-Host "Uploading ZIP..." -ForegroundColor Cyan
    $response = Invoke-WebRequest -Uri $kuduUrl `
        -Method Post `
        -InFile $zip `
        -WebSession $session `
        -TimeoutSec 600

    Write-Host "Upload OK: $($response.StatusCode)" -ForegroundColor Green

    # Wait a bit
    Write-Host "Waiting for extraction..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    # Install dependencies
    Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
    $cmdUrl = "https://doc-automation-func.scm.azurewebsites.net/api/command"
    $cmd = @{
        command = "npm install --production"
        dir     = "site/wwwroot"
    } | ConvertTo-Json

    $response = Invoke-WebRequest -Uri $cmdUrl `
        -Method Post `
        -Body $cmd `
        -ContentType "application/json" `
        -WebSession $session `
        -TimeoutSec 300

    Write-Host "npm install queued" -ForegroundColor Green

    # Wait for app to restart
    Write-Host "`nWaiting for app restart (60s)..." -ForegroundColor Yellow
    for ($i = 1; $i -le 60; $i++) {
        try {
            $health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
                -TimeoutSec 5 `
                -ErrorAction SilentlyContinue

            if ($health.StatusCode -eq 200) {
                Write-Host "App is healthy!" -ForegroundColor Green
                break
            }
        } catch { }

        Write-Host "  [$i/60] Starting..." -ForegroundColor Gray
        Start-Sleep -Seconds 1
    }

    Write-Host "`nDEPLOYMENT COMPLETE!" -ForegroundColor Green
    Write-Host "Webhook: https://doc-automation-func.azurewebsites.net/api/mondayWebhook" -ForegroundColor Cyan

} catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host "`nManual steps:" -ForegroundColor Yellow
    Write-Host "1. In Kudu console, delete: cd D:\home\site\wwwroot && del /s /q *" -ForegroundColor White
    Write-Host "2. Upload ZIP via drag-drop" -ForegroundColor White
    Write-Host "3. Run: unzip -o deploy-docflow.zip && npm install --production" -ForegroundColor White
}
