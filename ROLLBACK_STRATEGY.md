# DocFlow Rollback Strategy

**Status:** Ready for Implementation  
**Updated:** 2026-08-13  
**Applies to:** `doc-automation-func` (West US 2)

---

## Executive Summary

DocFlow uses direct deployment to production via Azure Functions. To minimize risk of breaking changes in production, this strategy provides:

1. **Immediate Rollback** — Restore last-known-good code in 2-5 minutes
2. **Blue-Green Deployment** — Recommended for future deployments (zero-downtime swaps)
3. **Health Checks** — Automated verification before completing rollback
4. **Deployment Tags** — Track versions for quick identification

---

## CURRENT STATE: Direct Deployment

```
Master/Main Branch (GitHub)
    ↓ (push or workflow_dispatch)
GitHub Actions (Ubuntu)
    ↓ (test, build zip)
Azure Function App (doc-automation-func)
    ↓ (direct to production)
Monday Webhook (live)
```

**Risk Window:** Code is live immediately after deployment. If tests pass but production fails, rollback needed.

---

## Method 1: IMMEDIATE ROLLBACK (Direct Git Revert)

**Time to Recovery:** 2-5 minutes  
**Downtime:** 30-120 seconds  
**Use When:** Current deployment breaks production, need fast recovery

### Step 1: Identify Last-Good Commit

```powershell
# Check recent deployments (from GitHub Actions logs or git log)
cd C:\Users\Franky.Lopez\docflow
git log --oneline -20

# Example output:
# 04c1abd - Current (broken)
# 5680043 - Previous (working)
# 6575883 - Two commits ago
```

### Step 2: Revert and Push

```powershell
# Mark current commit as bad
git tag deployment-broken-$(Get-Date -Format yyyyMMdd-HHmmss) HEAD

# Revert to last-good commit (use commit hash from step 1)
git revert 5680043 --no-edit

# Push to master (triggers auto-deploy via GitHub Actions)
git push origin master
```

**GitHub Actions will:**
1. Run full test suite (30 seconds)
2. Build deployment package (15 seconds)
3. Deploy to Azure (30-60 seconds)
4. Run health check (up to 5 minutes wait)

### Step 3: Verify Recovery

```powershell
# Check health endpoint
$health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" `
    -UseBasicParsing -TimeoutSec 10
$health.StatusCode  # Should be 200

# Test webhook
$test = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/mondayWebhook" `
    -Method POST -ContentType "application/json" `
    -Body '{"test":true}' -UseBasicParsing
$test.StatusCode  # Should be 200 or 400 (invalid data is ok, crash is not)
```

### Step 4: Root Cause Analysis

After rollback succeeds:

```powershell
# Compare commits
git diff 5680043..04c1abd

# Check production logs (Kudu)
# https://doc-automation-func.scm.azurewebsites.net/api/logs/application

# Alert team
# "Rolled back to commit 5680043. Deployment 04c1abd broke [SPECIFIC FEATURE]"
```

---

## Method 2: BLUE-GREEN DEPLOYMENT (Recommended Future Approach)

**Time to Recovery:** 10-30 seconds (slot swap)  
**Downtime:** None (warm swap)  
**Use For:** All future deployments

### One-Time Setup: Create Staging Slot

```powershell
param(
    [Parameter(Mandatory = $true)][string]$AppName = "doc-automation-func",
    [Parameter(Mandatory = $true)][string]$ResourceGroup = "doc-automation-rg"
)

# Create staging slot (one-time)
az functionapp deployment slot create `
    --resource-group $ResourceGroup `
    --name $AppName `
    --slot staging

Write-Host "✓ Staging slot created" -ForegroundColor Green
Write-Host "  Production URL: https://$AppName.azurewebsites.net" -ForegroundColor DarkGray
Write-Host "  Staging URL:    https://$AppName-staging.azurewebsites.net" -ForegroundColor DarkGray
```

### Deployment Workflow: Deploy to Staging First

**Update `.github/workflows/deploy.yml`:**

```yaml
name: Deploy DocFlow to Azure (Blue-Green)

on:
  push:
    branches: [ master, main ]
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'
      
      - name: Install & Test
        run: npm ci && npm test
      
      - name: Build package
        run: zip -r deploy.zip . -x "node_modules/*" ".git/*" ".github/*"
        
      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      
      # DEPLOY TO STAGING FIRST
      - name: Deploy to Staging Slot
        run: |
          az functionapp deployment source config-zip \
            --resource-group doc-automation-rg \
            --name doc-automation-func \
            --slot staging \
            --src-path deploy.zip
      
      # VERIFY STAGING IS HEALTHY
      - name: Verify Staging Health
        run: |
          for i in {1..60}; do
            STATUS=$(curl -s -w "%{http_code}" -o /dev/null -k https://doc-automation-func-staging.azurewebsites.net/api/health)
            if [ "$STATUS" = "200" ]; then
              echo "✅ Staging slot healthy"
              exit 0
            fi
            sleep 5
          done
          echo "❌ Staging slot failed health check"
          exit 1
      
      # RUN SMOKE TESTS AGAINST STAGING
      - name: Smoke Test on Staging
        run: |
          # Test webhook endpoint
          RESPONSE=$(curl -s -X POST -k https://doc-automation-func-staging.azurewebsites.net/api/mondayWebhook \
            -H "Content-Type: application/json" \
            -d '{"test":true}')
          
          if echo "$RESPONSE" | grep -qi "error\|failed\|exception"; then
            echo "❌ Smoke test failed"
            exit 1
          fi
          echo "✅ Smoke tests passed"
      
      # IF ALL CHECKS PASS: SWAP TO PRODUCTION
      - name: Swap Staging to Production
        run: |
          az functionapp deployment slot swap \
            --resource-group doc-automation-rg \
            --name doc-automation-func \
            --slot staging
          echo "✅ Slot swap complete — new code now live"
      
      # FINAL VERIFICATION
      - name: Verify Production Health
        run: |
          for i in {1..30}; do
            STATUS=$(curl -s -w "%{http_code}" -o /dev/null -k https://doc-automation-func.azurewebsites.net/api/health)
            if [ "$STATUS" = "200" ]; then
              echo "✅ Production verified healthy"
              exit 0
            fi
            sleep 3
          done
          echo "⚠ Production health still loading"
      
      # TAGGING FOR ROLLBACK
      - name: Tag Deployment
        run: |
          git tag deployment-prod-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
          git push origin --tags
```

### Rollback in Blue-Green (Instant)

If production fails after slot swap:

```powershell
param(
    [Parameter(Mandatory = $true)][string]$AppName = "doc-automation-func",
    [Parameter(Mandatory = $true)][string]$ResourceGroup = "doc-automation-rg"
)

Write-Host "🔄 ROLLING BACK to Staging slot..." -ForegroundColor Yellow

# Swap back to previous version (staging now has old code, production has new)
az functionapp deployment slot swap `
    --resource-group $ResourceGroup `
    --name $AppName `
    --slot staging

Write-Host "✅ Rollback complete in 10-30 seconds" -ForegroundColor Green

# Verify
$health = Invoke-WebRequest -Uri "https://$AppName.azurewebsites.net/api/health" `
    -UseBasicParsing -TimeoutSec 10
if ($health.StatusCode -eq 200) {
    Write-Host "✓ Production verified" -ForegroundColor Green
} else {
    Write-Host "⚠ Health check failed — investigate" -ForegroundColor Yellow
}
```

---

## Method 3: KUDU CONSOLE EMERGENCY STOP

**Time to Recovery:** 30 seconds  
**When:** Code is in infinite loop / hanging  
**How:** Kill w3wp process to force app restart

```powershell
# 1. Access Kudu console
# https://doc-automation-func.scm.azurewebsites.net/DebugConsole

# 2. Open PowerShell in Kudu
# URL: https://doc-automation-func.scm.azurewebsites.net/api/command

# 3. Kill app process (forces graceful restart)
$response = Invoke-RestMethod -Uri "https://doc-automation-func.scm.azurewebsites.net/api/command" `
    -Method POST `
    -Headers @{"Authorization" = "Basic $(ConvertTo-Base64 "$kuduUser:$kuduPass")" } `
    -ContentType "application/json" `
    -Body '{"command":"taskkill /F /IM w3wp.exe","dir":"site/wwwroot"}'

# App will auto-restart with cached code. Useful if deployment is in bad state.
```

---

## Monitoring & Alerts (Prevent Failures)

### Health Check Endpoint (Production)

```
GET https://doc-automation-func.azurewebsites.net/api/health
Response: { "status": "UP", "timestamp": "2026-08-13T12:34:56Z" }
```

**Set up alerts:**

```powershell
# Azure Monitor alert (email on health check failure)
# Alert Rule: "DocFlow Health Check Failed"
# Trigger: 3 consecutive failures (15 seconds total)
# Action: Email ops@medwatchers.com + PagerDuty
```

### Deployment Verification Checklist

Before declaring a deployment successful:

- [ ] GitHub Actions workflow completed with exit code 0
- [ ] Health check returns 200 within 5 minutes
- [ ] Webhook endpoint responds to test POST
- [ ] No errors in Kudu logs (`https://doc-automation-func.scm.azurewebsites.net/api/logs/application`)
- [ ] Monday.com webhook data is being processed (check recent board activity)
- [ ] No spike in Function App errors (App Insights)

---

## Versioning: Tag Each Deployment

```powershell
# After successful deployment, tag the commit
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$commit = git rev-parse --short HEAD
git tag "deployment-prod-$timestamp-$commit"
git push origin --tags

# Later, to rollback to specific version:
git checkout deployment-prod-20260813-153422-5680043
git push -f origin master  # Deploy that commit
```

---

## Comparison: All Rollback Methods

| Method | Time to Live | Downtime | Complexity | Risk |
|--------|--------------|----------|-----------|------|
| **Direct Revert** | 2-5 min | 30-120s | Low | Medium (tests run, but prod is live during deploy) |
| **Blue-Green Swap** | 10-30s | ~0s | Medium | Low (always warm slot ready) |
| **Kudu Kill w3wp** | <30s | ~5s | Low | High (dangerous, last resort) |
| **Manual redeploy** | 5+ min | 60+ | High | High (manual steps) |

---

## Deployment Failure Scenarios & Responses

### Scenario 1: Syntax Error / Failed Tests
**Symptom:** GitHub Actions workflow fails before deployment  
**Recovery:** Already prevented — push a fix commit  
**Time:** 5-10 minutes (next deploy attempt)

### Scenario 2: Deploy Succeeds, Health Check Fails
**Symptom:** Zip uploaded, but app won't start  
**Recovery:**  
1. Check Kudu logs: `https://doc-automation-func.scm.azurewebsites.net/api/logs/application`
2. If blocked/bad code: Revert + Push (Method 1)
3. If hanging: Kudu kill w3wp (Method 3)

**Time:** 2-5 minutes

### Scenario 3: Deploy Succeeds, Production Error (Intermittent)
**Symptom:** Health passes, but webhook fails randomly  
**Recovery:**  
1. Check app logs (Application Insights)
2. If data corruption / logic error: Revert + Push (Method 1)
3. Implement feature flag to disable problematic function (no redeploy needed)

**Time:** 5-15 minutes

### Scenario 4: Post-Deployment Data Corruption
**Symptom:** New code processes Monday data incorrectly (discovered after an hour)  
**Recovery:**  
1. Revert deployment (Method 1 or 2)
2. Restore corrupted data from backup
3. Fix code logic
4. Redeploy with test for the bug

**Time:** 15-30 minutes + manual data fix

---

## Pre-Deployment Checklist

Before pushing to `master`:

```powershell
# 1. Run full test suite locally
npm test

# 2. Build deployment package
$zip = Join-Path $env:TEMP "docflow-test-$(Get-Date -Format yyyyMMdd-HHmmss).zip"
Compress-Archive -Path . -DestinationPath $zip -Exclude "node_modules", ".git", ".env"

# 3. Check git status
git status

# 4. Review recent changes
git log --oneline -5

# 5. Final manual tests (call functions directly)
# ... test key endpoints locally

# 6. Commit + Push
git commit -m "Release: [FEATURE] - describe change"
git push origin master
```

---

## Post-Deployment Checklist

After deployment completes:

```powershell
# 1. Monitor logs for 5 minutes
# Kudu: https://doc-automation-func.scm.azurewebsites.net/api/logs/application
# App Insights: https://portal.azure.com → Application Insights

# 2. Run production smoke tests
Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health"
Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/mondayWebhook" -Method POST -Body '{"test":true}'

# 3. Check Monday.com board for webhook activity
# Board 18422046530 → Activity feed (should show new items/updates)

# 4. No alerts in PagerDuty / Slack for 30 minutes
# If clear: Deployment successful

# If issues: Trigger rollback immediately
```

---

## Quick Reference: Rollback Command (One-Liner)

```powershell
# Revert last commit and redeploy (if current master is broken)
cd C:\Users\Franky.Lopez\docflow; git revert HEAD --no-edit && git push origin master

# Status: Check GitHub Actions → DocFlow Deploy workflow
# Time to live: ~3-5 minutes
```

---

## Related Documents

- `DEPLOY-VALIDATEADP.md` — ADP validation workflow
- `docflow_deployment_method.md` — Current deployment method (Kudu VFS + AAD token)
- `.github/workflows/deploy.yml` — Main GitHub Actions workflow
- `deploy/deploy.ps1` — Local PowerShell deployment script

---

**Owner:** Francisco Lopez  
**Last Verified:** 2026-08-13 (Direct method, Blue-Green template provided)  
**Next Step:** Implement blue-green slots for safer deployments
