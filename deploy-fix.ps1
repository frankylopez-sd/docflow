# DOCFLOW DEPLOYMENT FIX - Correct directory structure for Azure Functions
# Problem: Functions are looking for ../../lib/config but structure needs to be flat

$sourceRoot = "C:\Users\Franky.Lopez\docflow"
$deployDir = "$env:TEMP\docflow-deploy-$(Get-Random)"

Write-Host "Creating correctly-structured deployment package..." -ForegroundColor Yellow
Write-Host "Source: $sourceRoot" -ForegroundColor Gray
Write-Host "Deploy: $deployDir" -ForegroundColor Gray

# Create deployment directory
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

# Copy each function folder from src/functions to root of deploy dir
Write-Host "`nCopying functions..." -ForegroundColor Yellow
Get-ChildItem -Path "$sourceRoot\src\functions" -Directory | ForEach-Object {
  $funcName = $_.Name
  Copy-Item -Path "$sourceRoot\src\functions\$funcName" -Destination "$deployDir\$funcName" -Recurse -Force
  Write-Host "  ✓ $funcName" -ForegroundColor Green
}

# Copy lib folder to deploy dir root
Write-Host "`nCopying shared libraries..." -ForegroundColor Yellow
Copy-Item -Path "$sourceRoot\src\lib" -Destination "$deployDir\lib" -Recurse -Force
Write-Host "  ✓ lib files copied" -ForegroundColor Green

# Copy root config files
Write-Host "`nCopying configuration..." -ForegroundColor Yellow
Copy-Item -Path "$sourceRoot\package.json" -Destination "$deployDir\" -Force
Copy-Item -Path "$sourceRoot\host.json" -Destination "$deployDir\" -Force
Copy-Item -Path "$sourceRoot\.funcignore" -Destination "$deployDir\" -Force
Write-Host "  ✓ package.json, host.json, .funcignore" -ForegroundColor Green

# Verify structure
Write-Host "`nDeployment structure:" -ForegroundColor Yellow
$functions = @(Get-ChildItem -Path $deployDir -Directory -Exclude "lib" | Select-Object -ExpandProperty Name)
Write-Host "  Functions: $($functions.Count)" -ForegroundColor Green
Write-Host "  Lib folder: $(if (Test-Path "$deployDir\lib") { '✓' } else { '✗' })" -ForegroundColor Green

# Create ZIP
Write-Host "`nCreating deployment ZIP..." -ForegroundColor Yellow
$zipPath = "$env:TEMP\docflow-$(Get-Date -Format 'yyyyMMdd-HHmmss').zip"

# Remove old ZIP if exists
Remove-Item -Path "$deployDir\.git*" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$deployDir\node_modules" -Recurse -Force -ErrorAction SilentlyContinue

# Create the ZIP
if (Get-Command Compress-Archive -ErrorAction SilentlyContinue) {
  Compress-Archive -Path "$deployDir\*" -DestinationPath $zipPath -Force
  Write-Host "  ✓ ZIP created: $zipPath" -ForegroundColor Green
  Write-Host "  Size: $([math]::Round((Get-Item $zipPath).Length/1MB, 2))MB" -ForegroundColor Gray
} else {
  Write-Host "  ✗ Compress-Archive not available" -ForegroundColor Red
  exit 1
}

# Deploy via Azure CLI
Write-Host "`nDeploying to Azure..." -ForegroundColor Yellow

$app = "doc-automation-func"
$rg = "mw-platform-ai-prod"

Write-Host "  Uploading to $app..." -NoNewline -ForegroundColor Gray
try {
  & az functionapp deployment source config-zip `
    --resource-group $rg `
    --name $app `
    --src $zipPath 2>&1 | Out-Null

  Write-Host " ✓" -ForegroundColor Green
  Write-Host "  Waiting 60 seconds for deployment..." -ForegroundColor Gray
  Start-Sleep -Seconds 60

  # Test endpoint
  Write-Host "  Testing health endpoint..." -NoNewline -ForegroundColor Gray
  $response = Invoke-WebRequest -Uri "https://$app.azurewebsites.net/api/health" -TimeoutSec 10 -UseBasicParsing -ErrorAction SilentlyContinue
  if ($response.StatusCode -eq 200) {
    Write-Host " HTTP 200 ✓" -ForegroundColor Green
    Write-Host "`n✓ DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
  } else {
    Write-Host " HTTP $($response.StatusCode)" -ForegroundColor Yellow
  }
} catch {
  Write-Host " ✗" -ForegroundColor Red
  Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "`n  Trying alternate method..." -ForegroundColor Yellow
  Write-Host "  Manual upload ZIP: $zipPath" -ForegroundColor Yellow
}

# Cleanup
Write-Host "`nCleaning up..." -ForegroundColor Gray
Remove-Item -Path $deployDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "Deployment complete. If HTTP 500 still occurs, check App Insights:" -ForegroundColor Cyan
Write-Host "  Azure Portal → Resource Group → Application Insights → Logs" -ForegroundColor Gray
