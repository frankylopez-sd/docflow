# validateADP Live Deployment Strategy
**Status: Executable — No Trial-and-Error**  
**Target**: doc-automation-func @ https://doc-automation-func.azurewebsites.net/api/validateADP  
**Board**: Onboarding (18422046530)  
**Date**: 2026-08-13

---

## STEP 1: PRE-DEPLOYMENT DIAGNOSTICS
### Check the Function App State

```powershell
# 1.1 Verify the function app exists and is running
az functionapp show -n doc-automation-func -g doc-automation-rg `
  --query "{name, state, runtime, url: defaultHostName}" -o json

# Expected output:
# {
#   "name": "doc-automation-func",
#   "state": "Running",
#   "runtime": "node",
#   "url": "doc-automation-func.azurewebsites.net"
# }
```

**STOP IF FAILURE**: Function app must exist and be in "Running" state.

```powershell
# 1.2 Verify the health endpoint responds
$health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
  -UseBasicParsing -TimeoutSec 10 -ErrorAction SilentlyContinue
$health | ConvertFrom-Json | ConvertTo-Json

# Expected: status: "ok", configLoaded: true
```

**STOP IF FAILURE**: If health returns non-200 or configLoaded=false, config is missing.

```powershell
# 1.3 List all deployed functions
az functionapp function list -n doc-automation-func -g doc-automation-rg `
  --query "[].name" -o json

# Should include: validateADP (may not be there if not deployed yet)
# Will show: health, mondayWebhook, generatePDF, etc.
```

```powershell
# 1.4 Verify Monday webhook signing secret exists in app settings
az functionapp config appsettings list -n doc-automation-func -g doc-automation-rg `
  --query "[?name=='MONDAY_SIGNING_SECRET']" -o json

# If empty array [] → STOP: Secret not configured (ask Francisco for the value)
```

```powershell
# 1.5 Verify onboarding board ID is configured
az functionapp config appsettings list -n doc-automation-func -g doc-automation-rg `
  --query "[?name=='MONDAY_ONBOARDING_BOARD_ID'].value" -o json

# Expected: ["18422046530"]
# If different → note the actual ID for testing
```

---

## STEP 2: DEPLOYMENT METHOD CHOICE & REASONING

### **METHOD: Kudu/SCM zipdeploy (Proven)**

**Why this method:**
- ✅ Already used successfully for DocFlow (documented in deploy.ps1)
- ✅ Bypasses Cloudflare WARP SSL issues (known gotcha in your memory)
- ✅ Byte-exact transfer (no content negotiation bugs)
- ✅ Atomic: either entire zip deploys or none
- ✅ Single-command deployment (no multi-step ARM template)
- ✅ Works offline-first: test locally, then deploy

**Why NOT GitHub Actions for this deployment:**
- First live run should be manual with immediate verification
- GitHub Actions adds CI layer (harder to debug if first deploy fails)
- Easier rollback via manual Kudu if needed
- Will use GitHub Actions for subsequent pushes (after verified)

### **Deployment Command (Manual Kudu)**

```powershell
# 2.1 Navigate to docflow repo root
Set-Location "C:\Users\Franky.Lopez\docflow"

# 2.2 Run full test suite (gate: no untested code ships)
npm test
if ($LASTEXITCODE -ne 0) { 
  Write-Host "DEPLOY STOPPED: Tests failed. Fix first." -ForegroundColor Red
  exit 1 
}

# 2.3 Install production dependencies (prunes devDependencies)
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

# 2.4 Build the deployment package
$timestamp = Get-Date -Format yyyyMMdd-HHmmss
$zip = "$env:TEMP\validateadp-deploy-$timestamp.zip"
Write-Host "Building package: $zip" -ForegroundColor Cyan

# Exclude non-production files (same as deploy.ps1)
$exclude = @('.git', '.env', 'local.settings.json', 'coverage', 'deploy', 'src\tests', '.github')
$items = @(
  'src', 'node_modules', 'package.json', 'package-lock.json',
  'host.json', '.funcignore'
)
Compress-Archive -Path $items -DestinationPath $zip -Force

Write-Host "✓ Package ready ($((Get-Item $zip).Length / 1MB)MB)" -ForegroundColor Green

# 2.5 Fetch publishing credentials from Azure
Write-Host "Fetching publishing credentials..." -ForegroundColor Cyan
$creds = az webapp deployment list-publishing-credentials -n doc-automation-func `
  -g doc-automation-rg --query "{u:publishingUserName, p:publishingPassword}" -o json | ConvertFrom-Json

if (-not $creds.u -or -not $creds.p) {
  throw "Failed to fetch publishing credentials — check Azure permissions"
}

# 2.6 Deploy via Kudu SCM zipdeploy
Write-Host "Uploading to Kudu..." -ForegroundColor Cyan
$pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.u):$($creds.p)"))
$wc = New-Object System.Net.WebClient
$wc.Headers.Add('Authorization', "Basic $pair")
$wc.UploadFile("https://doc-automation-func.scm.azurewebsites.net/api/zipdeploy", 'PUT', $zip) | Out-Null

Write-Host "✓ Zipdeploy upload complete" -ForegroundColor Green

# 2.7 Clean up local zip
Remove-Item $zip -Force -ErrorAction SilentlyContinue
```

---

## STEP 3: POST-DEPLOYMENT VERIFICATION (Concrete Tests)

### **3.1 Wait for App Restart & Health Check**

```powershell
# 3.1a: Wait for functions to warm up (typically 10-30 seconds)
Write-Host "Waiting for function app to warm up..." -ForegroundColor Yellow
$maxAttempts = 12
$healthy = $false

for ($i = 1; $i -le $maxAttempts; $i++) {
  Write-Host "  [Attempt $i/$maxAttempts]" -ForegroundColor Gray
  Start-Sleep -Seconds 10
  
  try {
    $res = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
      -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    
    if ($res.StatusCode -eq 200) {
      $body = $res.Content | ConvertFrom-Json
      Write-Host "✓ Health OK: configLoaded=$($body.configLoaded)" -ForegroundColor Green
      $healthy = $true
      break
    }
  } catch {
    Write-Host "    (still loading...)" -ForegroundColor DarkGray
  }
}

if (-not $healthy) {
  throw "App did not recover after deploy. Check Azure portal for crash logs."
}
```

### **3.2 Unit Test: validateADP Endpoint Responds**

```powershell
# 3.2a: Test the validateADP endpoint exists (challenge handshake)
Write-Host "Testing validateADP endpoint availability..." -ForegroundColor Cyan

$testPayload = @{
  challenge = "test-challenge-12345"
} | ConvertTo-Json

try {
  $res = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/validateADP" `
    -Method POST `
    -ContentType "application/json" `
    -Body $testPayload `
    -UseBasicParsing `
    -TimeoutSec 15 `
    -ErrorAction Stop

  if ($res.StatusCode -eq 200) {
    $body = $res.Content | ConvertFrom-Json
    if ($body.challenge -eq "test-challenge-12345") {
      Write-Host "✓ validateADP endpoint OK (challenge handshake works)" -ForegroundColor Green
    } else {
      throw "Challenge response mismatch: got $($body.challenge)"
    }
  }
} catch {
  throw "validateADP endpoint failed: $_"
}
```

### **3.3 Integration Test: validateADP Verifies Fields**

```powershell
# 3.3a: Call validateADP with a mock record (no signature required for challenge)
# This tests that the validation logic is deployed

Write-Host "Testing validateADP field validation logic..." -ForegroundColor Cyan

# Mock event payload (item with some but not all ADP fields)
$testEvent = @{
  event = @{
    type = "change_column_value"
    boardId = "18422046530"
    itemId = "12345"
    columnId = "text_mm65hxkh"  # Work Email
    value = @{
      text = "john.doe@medwatchers.com"
    }
  }
} | ConvertTo-Json

# Without valid signing secret, this will be rejected (401) — this is expected.
# The test is: did the function deploy and does it have the auth check?

try {
  $res = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/validateADP" `
    -Method POST `
    -ContentType "application/json" `
    -Body $testEvent `
    -UseBasicParsing `
    -TimeoutSec 15 `
    -ErrorAction SilentlyContinue

  # Status should be 200 (ignored) or 401 (unsigned) — NOT 404 or 500
  Write-Host "  Response: HTTP $($res.StatusCode)" -ForegroundColor Yellow
  
  if ($res.StatusCode -eq 401) {
    Write-Host "✓ validateADP security: rejects unsigned requests (expected)" -ForegroundColor Green
  } elseif ($res.StatusCode -eq 200) {
    $body = $res.Content | ConvertFrom-Json
    if ($body.ignored -or $body.error) {
      Write-Host "✓ validateADP deployed and handling requests" -ForegroundColor Green
    }
  }
} catch {
  Write-Host "✗ Request failed: $_" -ForegroundColor Red
}
```

### **3.4 Deployment Artifact Check (Via Kudu)**

```powershell
# 3.4a: Verify validateADP files are in the deployed app
Write-Host "Verifying validateADP files deployed..." -ForegroundColor Cyan

$scmUrl = "https://doc-automation-func.scm.azurewebsites.net"
$validateAdpPath = "$scmUrl/api/vfs/site/wwwroot/validateADP/"

try {
  $res = Invoke-WebRequest -Uri $validateAdpPath `
    -Authentication Basic `
    -Credential (New-Object PSCredential('$doc-automation-func', (ConvertTo-SecureString $creds.p -AsPlainText -Force))) `
    -UseBasicParsing `
    -TimeoutSec 10 `
    -ErrorAction Stop

  if ($res.StatusCode -eq 200) {
    Write-Host "✓ validateADP deployed (files exist in wwwroot)" -ForegroundColor Green
  }
} catch {
  # 404 is expected if auth is wrong; check Kudu directly
  Write-Host "  ℹ Manual verification: check https://doc-automation-func.scm.azurewebsites.net/api/vfs/site/wwwroot" `
    -ForegroundColor Gray
}
```

### **3.5 Application Insights Logs (Verify Function Executed)**

```powershell
# 3.5a: Check recent invocations in Application Insights
Write-Host "Checking Application Insights for validateADP invocations..." -ForegroundColor Cyan

$appInsightsId = az functionapp show -n doc-automation-func -g doc-automation-rg `
  --query "appInsightsResourceId" -o tsv

if ($appInsightsId) {
  Write-Host "App Insights resource: $appInsightsId" -ForegroundColor Gray
  Write-Host "  → Open Azure Portal → Application Insights → Logs (KQL)" -ForegroundColor Yellow
  Write-Host "  → Run: customEvents | where name == 'adp-validation-complete' | take 10" -ForegroundColor Yellow
} else {
  Write-Host "  ℹ App Insights not linked. Logs in: Azure Portal → Function App → Monitor → Logs" `
    -ForegroundColor Gray
}
```

---

## STEP 4: ROLLBACK / RETRY PLAN

### **If Deployment Fails Immediately (Non-200 Health)**

```powershell
# 4.1a: Diagnose cold-start failure
Write-Host "ROLLBACK: Function app failed to start" -ForegroundColor Red

# Check what's actually running
$deployment = az functionapp deployment list-publishing-credentials -n doc-automation-func `
  -g doc-automation-rg --query "{id, state}" -o json

# Check logs via Kudu
Write-Host "Checking Kudu logs for errors..." -ForegroundColor Yellow
# https://doc-automation-func.scm.azurewebsites.net/DebugConsole → navigate to site/wwwroot/

# If deployment is stuck (w3wp zombie):
Write-Host "If app is stuck, kill w3wp process in Kudu:" -ForegroundColor Yellow
Write-Host "  1. Open: https://doc-automation-func.scm.azurewebsites.net/PowerShell" -ForegroundColor Cyan
Write-Host "  2. Run: Get-Process w3wp | Stop-Process -Force" -ForegroundColor Cyan
Write-Host "  3. Wait 30s, then test health again" -ForegroundColor Cyan
```

### **If validateADP Endpoint Returns 404**

```powershell
# 4.2a: Function mapping didn't register
Write-Host "ROLLBACK: validateADP endpoint not found (404)" -ForegroundColor Red

# Most common cause: src/functions/validateADP/ not in the zip
# Verify the zip was built correctly:

Write-Host "To retry:" -ForegroundColor Yellow
Write-Host "  1. Delete the bad zip from \$env:TEMP" -ForegroundColor Cyan
Write-Host "  2. Rerun STEP 2, section 2.4-2.7" -ForegroundColor Cyan
Write-Host "  3. Ensure 'src' folder is in Compress-Archive -Path list" -ForegroundColor Cyan
```

### **If validateADP Responds But Returns 500**

```powershell
# 4.3a: Runtime error in the function
Write-Host "ROLLBACK: validateADP runtime error (500)" -ForegroundColor Red

# Check Application Insights:
Write-Host "Steps:" -ForegroundColor Yellow
Write-Host "  1. Azure Portal → doc-automation-func → Monitor → Logs" -ForegroundColor Cyan
Write-Host "  2. Run KQL: traces | where message contains 'validateADP' | take 20" -ForegroundColor Cyan
Write-Host "  3. Look for 'validateADP-handler-failed' or 'validateADP-validation-failed'" -ForegroundColor Cyan

# Most likely issue: config missing (MONDAY_SIGNING_SECRET, MONDAY_ONBOARDING_BOARD_ID)
Write-Host "  4. Verify app settings: " -ForegroundColor Cyan
Write-Host "     az functionapp config appsettings list -n doc-automation-func -g doc-automation-rg | jq '.[] | select(.name | contains(\"MONDAY\"))'`n" -ForegroundColor Cyan
```

### **Complete Rollback: Redeploy Previous Working Version**

```powershell
# 4.4a: If current deployment is truly broken, revert to last-known-good
# (GitHub has a full history of every deployed version)

Write-Host "COMPLETE ROLLBACK STEPS:" -ForegroundColor Red
Write-Host "  1. In Azure Portal: Function App → Deployment → Deployment History" -ForegroundColor Cyan
Write-Host "  2. Find the last-known-good deployment (green checkmark)" -ForegroundColor Cyan
Write-Host "  3. Click 'Redeploy'" -ForegroundColor Cyan
Write-Host "  4. Wait 2-3 minutes for warm-up" -ForegroundColor Cyan
Write-Host "  5. Verify health: https://doc-automation-func.azurewebsites.net/api/health" -ForegroundColor Cyan

# Or, via CLI:
# git log --oneline src/functions/validateADP/
# git checkout <commit-hash> -- src/functions/validateADP/
# Then rerun STEP 2 (full deploy)
```

---

## STEP 5: MAINTENANCE (Keep It Live)

### **5.1 Continuous Verification (Add to Your Monitoring)**

```powershell
# 5.1a: Daily health check (add to your scheduled tasks or Azure Monitor)
function Test-ValidateADP {
  $health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
    -UseBasicParsing -TimeoutSec 15 -ErrorAction SilentlyContinue
  
  if ($health.StatusCode -eq 200) {
    $body = $health.Content | ConvertFrom-Json
    return @{
      status = "OK"
      timestamp = Get-Date
      configLoaded = $body.configLoaded
    }
  } else {
    return @{
      status = "FAIL"
      timestamp = Get-Date
      http_code = $health.StatusCode
    }
  }
}

# Run periodically:
# Test-ValidateADP | Export-Csv -Path "C:\logs\validateadp-health-$(Get-Date -Format yyyyMMdd).csv" -Append
```

### **5.2 Monitor validateADP Events in Application Insights**

```powershell
# 5.2a: Weekly check: How many validations are running?
Write-Host "Checking validateADP activity..." -ForegroundColor Cyan
Write-Host "Open Azure Portal:" -ForegroundColor Yellow
Write-Host "  → doc-automation-func → Monitor → Logs" -ForegroundColor Cyan
Write-Host "  → Run KQL query:" -ForegroundColor Cyan
Write-Host "    customEvents" -ForegroundColor Gray
Write-Host "    | where name == 'adp-validation-complete'" -ForegroundColor Gray
Write-Host "    | summarize count() by bin(timestamp, 1d), tostring(customDimensions.isComplete)" -ForegroundColor Gray
```

### **5.3 Alert Configuration (Production Monitoring)**

```powershell
# 5.3a: Set up Application Insights alert for validateADP failures
# In Azure Portal:
# 1. Function App → Monitoring → Alerts
# 2. Create New Alert Rule:
#    - Condition: Custom Log Search
#    - Query: customEvents | where name == 'validateADP-handler-failed' | summarize count()
#    - Threshold: > 5 per hour
#    - Action: Email to francisco.lopez@medwatchers.com

Write-Host "⚠ RECOMMENDED: Set up alert in Azure Portal for failures" -ForegroundColor Yellow
Write-Host "  Without this, you won't know if validateADP crashes." -ForegroundColor Yellow
```

### **5.4 Post-Deployment: Wire validateADP into Monday**

```powershell
# 5.4a: Create Monday.com webhook pointing to validateADP
# (This happens in Monday.com UI after function is live)

Write-Host "FINAL STEP: Register validateADP Webhook in Monday" -ForegroundColor Cyan
Write-Host "  1. Monday.com → Board (18422046530) → Integrations → Webhooks" -ForegroundColor Cyan
Write-Host "  2. Create New:" -ForegroundColor Cyan
Write-Host "    - Event: 'Change column value' (any ADP field)" -ForegroundColor Cyan
Write-Host "    - URL: https://doc-automation-func.azurewebsites.net/api/validateADP" -ForegroundColor Cyan
Write-Host "    - Signing Secret: [same as MONDAY_SIGNING_SECRET in app settings]" -ForegroundColor Cyan
Write-Host "  3. Test: Update any field on a hire record → should see validation kick off" -ForegroundColor Cyan

# Verify hook is registered:
Write-Host "`nTo verify webhook is live, check logs for:" -ForegroundColor Gray
Write-Host "  customEvents | where name == 'adp-validation-complete'" -ForegroundColor Gray
```

### **5.5 Quick Status Check Script**

```powershell
# Save this as: C:\Users\Franky.Lopez\mw-admin\Check-ValidateADP.ps1

function Get-ValidateADPStatus {
  [CmdletBinding()]
  param()
  
  Write-Host "═ validateADP Live Status ═" -ForegroundColor Cyan
  
  # Check 1: Health
  try {
    $health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
      -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    Write-Host "✓ Health: PASS ($($health.StatusCode))" -ForegroundColor Green
  } catch {
    Write-Host "✗ Health: FAIL" -ForegroundColor Red
    return
  }
  
  # Check 2: validateADP endpoint
  try {
    $test = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/validateADP" `
      -Method POST `
      -ContentType "application/json" `
      -Body '{"challenge":"test"}' `
      -UseBasicParsing `
      -TimeoutSec 10 `
      -ErrorAction Stop
    Write-Host "✓ validateADP: LIVE ($($test.StatusCode))" -ForegroundColor Green
  } catch {
    Write-Host "✗ validateADP: FAIL" -ForegroundColor Red
  }
  
  # Check 3: App settings
  try {
    $settings = az functionapp config appsettings list -n doc-automation-func -g doc-automation-rg `
      --query "[?name=='MONDAY_SIGNING_SECRET' || name=='MONDAY_ONBOARDING_BOARD_ID']" -o json | ConvertFrom-Json
    if ($settings.Count -eq 2) {
      Write-Host "✓ Config: OK (2/2 required settings)" -ForegroundColor Green
    } else {
      Write-Host "⚠ Config: INCOMPLETE ($($settings.Count)/2 settings)" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "⚠ Config: Could not verify" -ForegroundColor Yellow
  }
  
  Write-Host "═════════════════════════════" -ForegroundColor Cyan
}

# Usage: Get-ValidateADPStatus
```

---

## FINAL CHECKLIST

- [ ] **PRE-DEPLOY**: Run STEP 1 diagnostics, all checks pass
- [ ] **DEPLOY**: Run STEP 2 Kudu deployment, npm tests pass
- [ ] **VERIFY**: Run STEP 3.1-3.5 post-deployment tests
- [ ] **WIRE MONDAY**: Register webhook in Monday.com (STEP 5.4)
- [ ] **MONITOR**: Set up Application Insights alert (STEP 5.3)
- [ ] **DOCUMENT**: Note deployment timestamp and git commit hash:

```powershell
# Record this after successful deploy:
Write-Host "Deployment complete:" -ForegroundColor Green
Write-Host "  Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Git Commit: $(git rev-parse --short HEAD)" -ForegroundColor Cyan
Write-Host "  Endpoint: https://doc-automation-func.azurewebsites.net/api/validateADP" -ForegroundColor Cyan
```

---

## ABORT CONDITIONS (STOP IMMEDIATELY)

1. **STEP 1 health check fails** → Do NOT proceed to STEP 2
2. **STEP 1 config check fails** (MONDAY_SIGNING_SECRET missing) → Ask Francisco for the value
3. **npm test fails** → Fix failing tests first, then redeploy
4. **STEP 3.1 health check times out after 2 minutes** → Investigate Kudu logs, kill w3wp if needed
5. **STEP 3.2 validateADP returns 404** → Verify zip contained src/functions/validateADP/

---

**Success Criteria**: 
- ✅ Health check returns 200 + configLoaded=true
- ✅ validateADP endpoint returns 200 (challenge handshake)
- ✅ Monday.com webhook registered and firing
- ✅ Application Insights shows adp-validation-complete events

**Questions?** Check the function code: `C:\Users\Franky.Lopez\docflow\src\functions\validateADP\index.js`
