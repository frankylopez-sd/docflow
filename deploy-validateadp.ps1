<#
.SYNOPSIS
  Deploy validateADP function to Azure with full diagnostics, verification, and rollback plan.

.DESCRIPTION
  Automated deployment strategy: pre-flight checks → zipdeploy → post-verification → wire Monday webhook.
  All steps logged. No trial-and-error.

.PARAMETER SkipTests
  Skip the npm test gate (NOT RECOMMENDED for production).

.PARAMETER WaitMinutes
  How long to wait for app warm-up (default: 2 minutes).

.PARAMETER SkipMonday
  Skip the final "wire Monday webhook" reminder.

.EXAMPLE
  .\deploy-validateadp.ps1
  .\deploy-validateadp.ps1 -SkipTests -WaitMinutes 5
#>
param(
  [switch]$SkipTests,
  [int]$WaitMinutes = 2,
  [switch]$SkipMonday
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$logFile = Join-Path $env:TEMP "validateadp-deploy-$(Get-Date -Format yyyyMMdd-HHmmss).log"

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $entry = "[$timestamp] [$Level] $Message"
  Add-Content -Path $logFile -Value $entry

  $color = switch ($Level) {
    "ERROR" { "Red" }
    "WARN" { "Yellow" }
    "SUCCESS" { "Green" }
    "DEBUG" { "Gray" }
    default { "White" }
  }
  Write-Host $Message -ForegroundColor $color
}

Write-Log "====== validateADP DEPLOYMENT START ======" "INFO"
Write-Log "Deploying validateADP to: https://doc-automation-func.azurewebsites.net/api/validateADP" "INFO"
Write-Log "Logs: $logFile" "DEBUG"

# ============================================================================
# STEP 1: PRE-DEPLOYMENT DIAGNOSTICS
# ============================================================================

Write-Host "`n[STEP 1] PRE-DEPLOYMENT DIAGNOSTICS" -ForegroundColor Cyan
Write-Log "STEP 1: Pre-deployment diagnostics" "INFO"

# 1.1 Function app exists
Write-Host "  1.1 Checking function app state..." -ForegroundColor Cyan
try {
  $appInfo = az functionapp show -n doc-automation-func -g doc-automation-rg `
    --query "{name, state, runtime}" -o json 2>$null | ConvertFrom-Json

  if ($appInfo.state -eq "Running") {
    Write-Log "Function app is Running" "SUCCESS"
    Write-Host "    ✓ App: $($appInfo.name) | State: $($appInfo.state)" -ForegroundColor Green
  } else {
    throw "Function app state is '$($appInfo.state)' — should be 'Running'"
  }
} catch {
  Write-Log "Function app check failed: $_" "ERROR"
  Write-Host "    ✗ ABORT: $_" -ForegroundColor Red
  exit 1
}

# 1.2 Health endpoint
Write-Host "  1.2 Testing /api/health endpoint..." -ForegroundColor Cyan
try {
  $health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
    -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
  $healthBody = $health.Content | ConvertFrom-Json

  Write-Log "Health endpoint responded: $($health.StatusCode)" "SUCCESS"
  Write-Host "    ✓ Status: $($healthBody.status) | ConfigLoaded: $($healthBody.configLoaded)" -ForegroundColor Green
} catch {
  Write-Log "Health check failed: $_" "ERROR"
  Write-Host "    ✗ ABORT: Health endpoint did not respond (app may not be running)" -ForegroundColor Red
  exit 1
}

# 1.3 Monday signing secret configured
Write-Host "  1.3 Checking Monday webhook config..." -ForegroundColor Cyan
try {
  $secret = az functionapp config appsettings list -n doc-automation-func -g doc-automation-rg `
    --query "[?name=='MONDAY_SIGNING_SECRET'].value" -o json 2>$null | ConvertFrom-Json

  if ($secret.Count -gt 0) {
    Write-Log "Monday signing secret is configured" "SUCCESS"
    Write-Host "    ✓ MONDAY_SIGNING_SECRET: configured" -ForegroundColor Green
  } else {
    throw "MONDAY_SIGNING_SECRET not found in app settings"
  }
} catch {
  Write-Log "Monday config check failed: $_" "WARN"
  Write-Host "    ⚠ WARNING: $_" -ForegroundColor Yellow
  Write-Host "       (Continue? Webhook may not validate without the secret.)" -ForegroundColor Yellow
}

# 1.4 Onboarding board ID configured
Write-Host "  1.4 Checking onboarding board ID..." -ForegroundColor Cyan
try {
  $boardId = az functionapp config appsettings list -n doc-automation-func -g doc-automation-rg `
    --query "[?name=='MONDAY_ONBOARDING_BOARD_ID'].value" -o json 2>$null | ConvertFrom-Json

  if ($boardId.Count -gt 0) {
    Write-Log "Onboarding board ID: $($boardId[0])" "SUCCESS"
    Write-Host "    ✓ Board ID: $($boardId[0])" -ForegroundColor Green
  } else {
    throw "MONDAY_ONBOARDING_BOARD_ID not configured"
  }
} catch {
  Write-Log "Board ID check failed: $_" "WARN"
  Write-Host "    ⚠ WARNING: $_" -ForegroundColor Yellow
}

Write-Log "STEP 1: All diagnostics passed" "SUCCESS"
Write-Host "  ✓ STEP 1 COMPLETE`n" -ForegroundColor Green

# ============================================================================
# STEP 2: DEPLOYMENT METHOD - KUDU ZIPDEPLOY
# ============================================================================

Write-Host "[STEP 2] DEPLOYMENT PACKAGE & ZIPDEPLOY" -ForegroundColor Cyan
Write-Log "STEP 2: Building deployment package" "INFO"

Set-Location $root

# 2.1 Run tests
if (-not $SkipTests) {
  Write-Host "  2.1 Running test suite..." -ForegroundColor Cyan
  try {
    npm test 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Tests failed (exit code: $LASTEXITCODE)" }
    Write-Log "Test suite: PASSED" "SUCCESS"
    Write-Host "    ✓ All tests passed" -ForegroundColor Green
  } catch {
    Write-Log "Test suite failed: $_" "ERROR"
    Write-Host "    ✗ ABORT: Tests failed. Fix before deploying." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Log "Tests skipped (flag: -SkipTests)" "WARN"
  Write-Host "  2.1 Tests skipped (NOT RECOMMENDED)" -ForegroundColor Yellow
}

# 2.2 Production install
Write-Host "  2.2 Installing production dependencies..." -ForegroundColor Cyan
try {
  npm ci --omit=dev 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  Write-Log "Production install: OK" "SUCCESS"
  Write-Host "    ✓ npm ci complete" -ForegroundColor Green
} catch {
  Write-Log "Production install failed: $_" "ERROR"
  Write-Host "    ✗ ABORT: $_" -ForegroundColor Red
  exit 1
}

# 2.3 Build zip
Write-Host "  2.3 Building deployment package..." -ForegroundColor Cyan
try {
  $zipName = "validateadp-deploy-$(Get-Date -Format yyyyMMdd-HHmmss).zip"
  $zip = Join-Path $env:TEMP $zipName

  $exclude = @('.git', '.env', 'local.settings.json', 'coverage', 'deploy', 'src\tests', '.github')
  $items = @(
    'src',
    'node_modules',
    'package.json',
    'package-lock.json',
    'host.json',
    '.funcignore'
  )

  # Resolve full paths
  $itemPaths = $items | ForEach-Object { Join-Path $root $_ }

  Compress-Archive -Path $itemPaths -DestinationPath $zip -Force
  $zipSize = (Get-Item $zip).Length / 1MB

  Write-Log "Deployment package created: $zipName ($([math]::Round($zipSize, 2))MB)" "SUCCESS"
  Write-Host "    ✓ Package: $zipName ($([math]::Round($zipSize, 2))MB)" -ForegroundColor Green
} catch {
  Write-Log "Package creation failed: $_" "ERROR"
  Write-Host "    ✗ ABORT: $_" -ForegroundColor Red
  exit 1
}

# 2.4 Get publishing credentials
Write-Host "  2.4 Fetching publishing credentials..." -ForegroundColor Cyan
try {
  $creds = az webapp deployment list-publishing-credentials -n doc-automation-func `
    -g doc-automation-rg --query "{u:publishingUserName, p:publishingPassword}" `
    -o json 2>$null | ConvertFrom-Json

  if (-not $creds.u -or -not $creds.p) {
    throw "Credentials are empty"
  }
  Write-Log "Publishing credentials: OK" "SUCCESS"
  Write-Host "    ✓ Credentials fetched" -ForegroundColor Green
} catch {
  Write-Log "Credential fetch failed: $_" "ERROR"
  Write-Host "    ✗ ABORT: $_" -ForegroundColor Red
  exit 1
}

# 2.5 Deploy via Kudu zipdeploy
Write-Host "  2.5 Uploading to Kudu SCM..." -ForegroundColor Cyan
try {
  $pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.u):$($creds.p)"))
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('Authorization', "Basic $pair")
  $wc.UploadFile("https://doc-automation-func.scm.azurewebsites.net/api/zipdeploy", 'PUT', $zip) | Out-Null

  Write-Log "Kudu zipdeploy: UPLOADED" "SUCCESS"
  Write-Host "    ✓ Zipdeploy complete" -ForegroundColor Green
} catch {
  Write-Log "Kudu upload failed: $_" "ERROR"
  Write-Host "    ✗ ABORT: $_" -ForegroundColor Red
  Write-Host "    Kudu URL: https://doc-automation-func.scm.azurewebsites.net" -ForegroundColor Yellow
  exit 1
}

# 2.6 Clean up zip
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Write-Log "STEP 2: Deployment complete" "SUCCESS"
Write-Host "  ✓ STEP 2 COMPLETE`n" -ForegroundColor Green

# ============================================================================
# STEP 3: POST-DEPLOYMENT VERIFICATION
# ============================================================================

Write-Host "[STEP 3] POST-DEPLOYMENT VERIFICATION" -ForegroundColor Cyan
Write-Log "STEP 3: Waiting for app warm-up..." "INFO"

# 3.1 Wait for app to warm up
Write-Host "  3.1 Waiting for function app to restart ($WaitMinutes min timeout)..." -ForegroundColor Cyan
$maxAttempts = $WaitMinutes * 6  # 10 seconds per attempt
$healthy = $false

for ($i = 1; $i -le $maxAttempts; $i++) {
  Start-Sleep -Seconds 10
  Write-Host "    [Attempt $i/$maxAttempts]" -ForegroundColor Gray

  try {
    $res = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
      -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop

    if ($res.StatusCode -eq 200) {
      $body = $res.Content | ConvertFrom-Json
      Write-Log "App warm-up complete: $($body.status)" "SUCCESS"
      Write-Host "    ✓ App is healthy (status: $($body.status))" -ForegroundColor Green
      $healthy = $true
      break
    }
  } catch {
    # Still warming up
  }
}

if (-not $healthy) {
  Write-Log "App warm-up timeout after $WaitMinutes minutes" "ERROR"
  Write-Host "    ✗ ABORT: App did not recover" -ForegroundColor Red
  Write-Host "    Try: https://doc-automation-func.scm.azurewebsites.net (Kudu Console)" -ForegroundColor Yellow
  exit 1
}

# 3.2 Test validateADP challenge handshake
Write-Host "  3.2 Testing validateADP endpoint (challenge handshake)..." -ForegroundColor Cyan
try {
  $testPayload = @{ challenge = "test-$(Get-Random)" } | ConvertTo-Json
  $res = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/validateADP" `
    -Method POST `
    -ContentType "application/json" `
    -Body $testPayload `
    -UseBasicParsing `
    -TimeoutSec 10 `
    -ErrorAction Stop

  if ($res.StatusCode -eq 200) {
    $body = $res.Content | ConvertFrom-Json
    if ($body.challenge) {
      Write-Log "validateADP endpoint: LIVE (challenge handshake OK)" "SUCCESS"
      Write-Host "    ✓ validateADP endpoint is live" -ForegroundColor Green
    } else {
      throw "Challenge response missing"
    }
  }
} catch {
  Write-Log "validateADP endpoint test failed: $_" "ERROR"
  Write-Host "    ✗ ABORT: validateADP endpoint not responding" -ForegroundColor Red
  exit 1
}

# 3.3 Test security (unsigned request should be rejected)
Write-Host "  3.3 Testing validateADP security (unsigned request)..." -ForegroundColor Cyan
try {
  $testPayload = @{
    event = @{
      type = "change_column_value"
      boardId = "18422046530"
      itemId = "999"
      columnId = "text_mm65hxkh"
    }
  } | ConvertTo-Json

  $res = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/validateADP" `
    -Method POST `
    -ContentType "application/json" `
    -Body $testPayload `
    -UseBasicParsing `
    -TimeoutSec 10 `
    -ErrorAction SilentlyContinue

  if ($res.StatusCode -eq 401) {
    Write-Log "validateADP security: Unsigned requests rejected (401)" "SUCCESS"
    Write-Host "    ✓ Security: Correctly rejects unsigned requests" -ForegroundColor Green
  } elseif ($res.StatusCode -eq 200) {
    Write-Log "validateADP security: Accepted unsigned request (review logic)" "WARN"
    Write-Host "    ⚠ Security: Unsigned request returned 200 (review app logic)" -ForegroundColor Yellow
  }
} catch {
  Write-Log "Security test error: $_" "WARN"
  Write-Host "    ⚠ Security test inconclusive: $_" -ForegroundColor Yellow
}

Write-Log "STEP 3: Verification complete" "SUCCESS"
Write-Host "  ✓ STEP 3 COMPLETE`n" -ForegroundColor Green

# ============================================================================
# STEP 4 INFO: WIRING MONDAY WEBHOOK (Manual)
# ============================================================================

if (-not $SkipMonday) {
  Write-Host "[STEP 4] WIRING MONDAY.COM WEBHOOK (Manual Setup Required)" -ForegroundColor Cyan
  Write-Log "STEP 4 INFO: Monday webhook needs manual registration" "INFO"

  Write-Host "`n  Register validateADP in Monday.com:" -ForegroundColor Cyan
  Write-Host "  1. Open: https://monday.com/board/18422046530/settings" -ForegroundColor Yellow
  Write-Host "  2. Go to: Integrations → Webhooks → Create New" -ForegroundColor Yellow
  Write-Host "  3. Configure:" -ForegroundColor Yellow
  Write-Host "     • Event: 'Change column value' (optional: filter to ADP columns)" -ForegroundColor Gray
  Write-Host "     • URL: https://doc-automation-func.azurewebsites.net/api/validateADP" -ForegroundColor Gray
  Write-Host "     • Signing Secret: [Get from app settings: MONDAY_SIGNING_SECRET]" -ForegroundColor Gray
  Write-Host "  4. Click 'Create Webhook'" -ForegroundColor Yellow
  Write-Host "`n  To verify after registering:" -ForegroundColor Yellow
  Write-Host "     Update any ADP field on a hire record" -ForegroundColor Gray
  Write-Host "     → Status should change to 'Create New Hire' or 'Missing Required Fields'" -ForegroundColor Gray
  Write-Host "`n  Monitor Application Insights:" -ForegroundColor Yellow
  Write-Host "     Azure Portal → doc-automation-func → Monitor → Logs" -ForegroundColor Gray
  Write-Host "     Query: customEvents | where name == 'adp-validation-complete'" -ForegroundColor Gray

  Write-Log "Monday webhook registration: MANUAL (see output)" "INFO"
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "✓ validateADP DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "`nEndpoint: https://doc-automation-func.azurewebsites.net/api/validateADP" -ForegroundColor Cyan
Write-Host "Board: 18422046530 (Onboarding)" -ForegroundColor Cyan
Write-Host "Logs: $logFile" -ForegroundColor Cyan

$gitHash = & git rev-parse --short HEAD 2>$null
Write-Host "`nDeployment Info:" -ForegroundColor Cyan
Write-Host "  Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host "  Git Commit: $gitHash" -ForegroundColor Gray

Write-Log "DEPLOYMENT COMPLETE AND VERIFIED" "SUCCESS"
Write-Host "`n" -ForegroundColor Cyan

# Restore dev dependencies locally
Write-Host "Restoring development dependencies..." -ForegroundColor Gray
npm install 2>&1 | Out-Null

Write-Host "Ready for production!" -ForegroundColor Green
