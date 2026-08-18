# Install npm dependencies on Azure via Kudu command API

Write-Host "Getting Kudu credentials..." -ForegroundColor Yellow

# Extract username and password using JSON parsing without jq
$credJson = az functionapp deployment list-publishing-profiles `
  --name doc-automation-func `
  --resource-group doc-automation-rg `
  --query "[0]" -o json

# Convert to PSObject for easier access
$creds = $credJson | ConvertFrom-Json
$user = $creds.userName
$pass = $creds.userPWD

if (-not $user -or -not $pass) {
    Write-Host "✗ Could not extract credentials" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Got credentials" -ForegroundColor Green

# Create auth header
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$user`:$pass"))
$headers = @{ "Authorization" = "Basic $auth" }

# Try to install dependencies via Kudu command API
Write-Host "`nInstalling npm dependencies on Azure..." -ForegroundColor Yellow

$cmdUrl = "https://doc-automation-func.scm.azurewebsites.net/api/command"
$body = @{
    command = "npm install"
    dir     = "site/wwwroot"
} | ConvertTo-Json

$response = Invoke-WebRequest -Uri $cmdUrl `
    -Method POST `
    -Headers $headers `
    -Body $body `
    -ContentType "application/json" `
    -ErrorAction SilentlyContinue

Write-Host "Response: $($response.StatusCode)" -ForegroundColor Green

Write-Host "`nWaiting 30 seconds..." -ForegroundColor Yellow
Start-Sleep -Seconds 30

Write-Host "Testing health..." -ForegroundColor Yellow
$health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
    -TimeoutSec 10 -ErrorAction SilentlyContinue

if ($health.StatusCode -eq 200) {
    Write-Host "✅ HTTP 200 - WORKING!" -ForegroundColor Green
} else {
    Write-Host "HTTP $($health.StatusCode)" -ForegroundColor Yellow
}
