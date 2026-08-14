# DocFlow Rollback Troubleshooting Guide

**Use this when rollback procedures aren't working as expected.**

---

## Problem: Health Check Returns 500 After Deployment

**Symptom:**
```
GET https://doc-automation-func.azurewebsites.net/api/health
→ HTTP 500 (Internal Server Error)
```

**Likely Cause:** App won't start, syntax error, missing dependency

**Solution:**

```powershell
# 1. Check Kudu logs immediately
https://doc-automation-func.scm.azurewebsites.net/api/logs/application

# Look for:
# - Module not found errors
# - Syntax errors (JavaScript)
# - Failed environment variables
# - Connection failures (database, Monday API)

# 2. Stream logs in real-time
az webapp log tail -g doc-automation-rg -n doc-automation-func

# 3. If app won't start, initiate rollback
.\rollback.ps1 -Mode Revert -Verify

# 4. After rollback, wait 3-5 minutes and verify
$health = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" -UseBasicParsing
$health.StatusCode  # Should be 200
```

**If rollback doesn't help:**
```powershell
# Check if previous code is also broken
git log --oneline -5

# If multiple deployments are bad, investigate:
git diff HEAD~3..HEAD

# Look for recent changes that might affect both versions
```

---

## Problem: GitHub Actions Deployment Fails (Exit Code Non-Zero)

**Symptom:**
```
GitHub Actions workflow shows red X
Latest step failed: "Deploy to Azure" or "Install & Test"
```

**Solution:**

**Case A: Tests Failed**
```
Step: "Install & Test" failed
Expected: npm test returns 0

Action:
1. Pull latest master
2. Run tests locally: npm test
3. Fix failing tests
4. Commit fix: git commit -m "Fix: test suite"
5. Push: git push origin master
6. GitHub Actions will retry automatically
```

**Case B: Build Failed**
```
Step: "Build package" or "Deploy to Azure" failed
Expected: zip file created and uploaded

Action:
1. Check for large files
   du -sh node_modules/
   → Should be < 500MB

2. Check .funcignore for exclusions
   cat .funcignore

3. If still failing:
   npm ci --omit=dev
   zip -r test.zip . -x "node_modules/*" ".git/*"
   → Verify zip is < 100MB

4. Try manual deploy instead
   .\deploy\deploy.ps1 -App doc-automation-func -ResourceGroup doc-automation-rg
```

**Case C: Azure Credentials Issue**
```
Error: "Not authorized" or "Invalid credentials"

Action:
1. Verify GitHub Secrets are set
   GitHub → Repo Settings → Secrets & Variables → Actions
   
2. Check AZURE_CREDENTIALS secret exists and is not expired
   
3. Manually verify credentials work
   az account show
   
4. If expired, update the secret:
   az account get-access-token --query accessToken -o tsv
   
5. Re-run workflow: GitHub Actions → Deploy DocFlow → Run workflow
```

---

## Problem: Health Check Passes but Webhook Fails

**Symptom:**
```
GET /api/health → 200 OK
POST /api/mondayWebhook → 500 Error
Monday.com board not updating
```

**Likely Cause:** Logic error in webhook handler, Monday API integration broken

**Solution:**

```powershell
# 1. Test webhook directly
curl -X POST -k https://doc-automation-func.azurewebsites.net/api/mondayWebhook \
  -H "Content-Type: application/json" \
  -d '{"test":true}'
# Check response (should be 200 or 400, not 500)

# 2. Check logs for webhook errors
https://doc-automation-func.scm.azurewebsites.net/api/logs/application
# Look for: "webhook" or "POST /api/mondayWebhook"

# 3. Verify environment variables (Monday API key, etc)
https://doc-automation-func.scm.azurewebsites.net/DebugConsole
# PowerShell: Get-ChildItem env: | grep MONDAY
# or check Azure portal → Function App → Configuration

# 4. If Monday API key is invalid:
$secretValue = az keyvault secret show --name "monday-api-key" \
  --vault-name "doc-automation-kv" --query "value" -o tsv
# (Replace with actual secret name/vault)

# 5. If code logic is broken
git diff origin/master..HEAD src/functions/mondayWebhook/
# Review recent webhook changes

# 6. Decide: rollback or deploy fix
# If critical: .\rollback.ps1 -Mode Revert -Verify
# If minor: Fix code, commit, push (new deploy)
```

---

## Problem: App Timeout During Rollback

**Symptom:**
```
.\rollback.ps1 -Mode Revert -Verify
...
[Timeout] Health check didn't return 200 in 3+ minutes
```

**Likely Cause:** GitHub Actions deployment taking longer than expected, or stuck

**Solution:**

```powershell
# 1. Check GitHub Actions status
Start-Process "https://github.com/medwatchers/docflow/actions"
# Look for "Deploy DocFlow" workflow
# Is it still running? Queued? Failed?

# 2. If workflow is running, wait longer (up to 10 min is normal)
for ($i = 0; $i -lt 60; $i++) {
    $status = curl -s -k https://doc-automation-func.azurewebsites.net/api/health | ConvertFrom-Json
    if ($status) {
        Write-Host "✓ App is up!"
        break
    }
    Write-Host "[$i min] Still waiting..."
    Start-Sleep -Seconds 60
}

# 3. If workflow stuck (no progress for 5 min)
# Cancel it and try manual deploy
.\deploy\deploy.ps1 -App doc-automation-func -ResourceGroup doc-automation-rg -SkipTests

# 4. If manual deploy also times out
# The app may be in a bad state. Try emergency restart:
.\rollback.ps1 -Mode KillApp -Verify

# 5. After app restarts, verify
curl -k https://doc-automation-func.azurewebsites.net/api/health
```

---

## Problem: Slot Swap Fails (Blue-Green)

**Symptom:**
```
.\rollback.ps1 -Mode SlotSwap -Verify
Error: "Slot swap failed"
```

**Likely Cause:** Staging slot doesn't exist, or has connectivity issues

**Solution:**

```powershell
# 1. Verify staging slot exists
az functionapp deployment slot list -g doc-automation-rg -n doc-automation-func

# If no staging slot:
Write-Host "✗ Staging slot not found"
Write-Host "Create it first: .\setup-slots.ps1"
exit 1

# 2. If slot exists, check its status
az functionapp deployment slot show -g doc-automation-rg \
  -n doc-automation-func -s staging

# 3. Verify both slots are healthy
curl -k https://doc-automation-func.azurewebsites.net/api/health
curl -k https://doc-automation-func-staging.azurewebsites.net/api/health

# If staging unhealthy, redeploy to it first:
az functionapp deployment source config-zip \
  --resource-group doc-automation-rg \
  --name doc-automation-func \
  --slot staging \
  --src-path latest-deploy.zip

# 4. Try swap again
az functionapp deployment slot swap \
  --resource-group doc-automation-rg \
  --name doc-automation-func \
  --slot staging

# 5. If still fails, fallback to Git revert
Write-Host "Slot swap unavailable, using Git revert instead..."
.\rollback.ps1 -Mode Revert -Verify
```

---

## Problem: Git Revert Conflicts

**Symptom:**
```
git revert HEAD --no-edit
error: commit abc1234 is a merge commit
or
CONFLICT in src/functions/index.js
```

**Solution:**

**Case A: Merge Commit Can't Be Reverted**
```powershell
# You can't revert a merge with one-liner. Specify parent:
git revert -m 1 HEAD --no-edit
# -m 1 means "keep the main branch side of the merge"

# Then push
git push origin master
```

**Case B: Conflicts During Revert**
```powershell
# Git will pause and ask you to resolve conflicts

# 1. Check conflicted files
git status

# 2. Edit conflicted files and resolve
# Look for markers: <<<<<<<, =======, >>>>>>>

# 3. After resolving
git add .
git commit --no-edit

# 4. Push
git push origin master
```

**Case C: Really stuck - Start over**
```powershell
# Abort current revert attempt
git revert --abort

# Use hard reset instead (dangerous but works)
git reset --hard origin/master~1
git push -f origin master

# This will redeploy the previous commit
# Caution: -f flag forces, may overwrite recent pushes
```

---

## Problem: Data Corrupted After Deployment

**Symptom:**
```
New deployment processed Monday data incorrectly
Example: Employee IDs changed, fields deleted, etc.
Discovered 1-2 hours after deployment
```

**Likely Cause:** Business logic error in new code

**Solution:**

```powershell
# URGENT: Prevent further corruption

# 1. Stop the webhook (if possible)
# Option A: Disable Monday webhook in dashboard
#   Monday.com → Board Settings → Integrations → DocFlow → Disable

# Option B: If can't access Monday, rollback code immediately
.\rollback.ps1 -Mode Revert -Verify

# 2. Assess damage
# Check what data was processed incorrectly:
az webapp log tail -g doc-automation-rg -n doc-automation-func | grep -i "error\|processed\|updated"

# 3. Export data backup
# Before doing anything else, backup the Monday board
# Monday.com → Board → Export CSV

# 4. Contact data team
# "DocFlow deployment [commit hash] corrupted employee data"
# "Rolled back to [previous commit]"
# "Backup exported to [location]"

# 5. Plan restoration
# Options:
# A. Restore from Monday.com backup/trash
# B. Re-import data from original source
# C. Manual correction of affected records

# 6. Fix the code
git log --oneline -1
git show HEAD

# Review the changes, identify the bug
# Make fix locally, test thoroughly

# 7. Redeploy with fix
npm test
git commit -m "Fix: data corruption in validateADP"
git push origin master

# Wait for GitHub Actions, verify data is correct this time
```

---

## Problem: "Production Health OK But Monday Not Processing"

**Symptom:**
```
/api/health → 200 OK
/api/mondayWebhook → 200 OK (responds to test)
But: Monday.com board not showing new/updated items
```

**Likely Cause:** Webhook not registered with Monday.com, or data is processing but silently failing

**Solution:**

```powershell
# 1. Check if Monday is actually calling us
# Logs should show POST requests
az webapp log tail -g doc-automation-rg -n doc-automation-func | grep "POST.*mondayWebhook"

# If no requests logged:
#   → Monday.com webhook not configured
#   Action: Configure webhook in Monday settings
#     Monday.com → Board → Settings → Integrations → Add DocFlow
#     URL: https://doc-automation-func.azurewebsites.net/api/mondayWebhook

# 2. Check if processing silently failing
# Look for error patterns in logs (but not crashing)
az webapp log tail -g doc-automation-rg -n doc-automation-func | grep -i "error\|failed\|skip"

# 3. Enable debug logging (if available)
# Temporarily set LOG_LEVEL=debug in app config
az functionapp config appsettings set -g doc-automation-rg \
  -n doc-automation-func \
  --settings LOG_LEVEL=debug

# Wait 1 minute, then check logs again
az webapp log tail -g doc-automation-rg -n doc-automation-func

# 4. Manually trigger webhook from Monday
# Monday.com → Board → Automations → Send Test Event
# Watch logs for processing

# 5. If still not working
# Check Monday API connectivity
# Logs should show API calls to Monday GraphQL
# Look for: "monday.com", "graphql", "error"

# 6. If Monday API key expired
az keyvault secret show --name "monday-api-key" --vault-name "doc-automation-kv" \
  --query "expires"

# If expired, regenerate in Monday.com dev portal
```

---

## Problem: Kudu Kill App Command Fails

**Symptom:**
```
.\rollback.ps1 -Mode KillApp
Error: "Failed to kill process"
```

**Likely Cause:** Authentication issue with Kudu, app already restarted

**Solution:**

```powershell
# 1. Try again (sometimes transient)
.\rollback.ps1 -Mode KillApp

# Wait 30 seconds

# 2. If still fails, use Kudu console directly
# Open: https://doc-automation-func.scm.azurewebsites.net/DebugConsole
# Click: PowerShell console (bottom)
# Command: taskkill /F /IM w3wp.exe

# 3. If Kudu console won't load
# Try browser restart or different browser

# 4. If all else fails, restart via Azure Portal
# Azure Portal → Function Apps → doc-automation-func → Restart
# (Requires access to portal)

# 5. After restart, verify app comes back online
for ($i = 0; $i -lt 12; $i++) {
    try {
        $h = Invoke-WebRequest -Uri "https://doc-automation-func.azurewebsites.net/api/health" \
          -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
        if ($h.StatusCode -eq 200) { 
            Write-Host "✓ App is back"
            break 
        }
    } catch { }
    Write-Host "Waiting... [$i/12]"
    Start-Sleep -Seconds 5
}
```

---

## Problem: Can't Access Kudu Console

**Symptom:**
```
https://doc-automation-func.scm.azurewebsites.net/DebugConsole
→ 403 Forbidden or blank page
```

**Solution:**

```powershell
# 1. Verify you have access
# Check Azure RBAC: Function App → Access Control (IAM)
# Your account should have "Contributor" or "Owner" role

# 2. Try alternate Kudu URL
# Instead of /DebugConsole, try:
https://doc-automation-func.scm.azurewebsites.net/api/logs/application

# 3. Use Azure CLI instead of Kudu
az webapp log tail -g doc-automation-rg -n doc-automation-func

# 4. Check if publishing credentials are cached in browser
# Logout: Remove stored password for doc-automation-func.scm.azurewebsites.net
# Browser Dev Tools → Application → Cookies → Delete domain cookies

# 5. Use basic auth directly
$creds = az webapp deployment list-publishing-credentials \
  -g doc-automation-rg -n doc-automation-func \
  --query "{u:publishingUserName, p:publishingPassword}" -o json | ConvertFrom-Json

# Then access with creds
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.u):$($creds.p)"))

Invoke-WebRequest -Uri "https://doc-automation-func.scm.azurewebsites.net/api/logs/application" `
  -Headers @{"Authorization" = "Basic $auth"}
```

---

## Problem: Rollback Worked But Issue Still There

**Symptom:**
```
Reverted to previous commit
Deployment succeeded
But problem still exists in production
```

**Likely Cause:** Issue is not in code (database, config, external service)

**Solution:**

```powershell
# 1. Verify actual code is old
az functionapp deployment list -g doc-automation-rg -n doc-automation-func \
  --query "[-1].url" -o tsv
# This URL should point to old commit

# Check git tags to confirm
git describe --tags --always

# 2. If code confirmed old, issue is elsewhere
# Check these components:

# A. Environment variables / Config
az functionapp config appsettings list -g doc-automation-rg -n doc-automation-func

# B. Monday.com API
# Is Monday in maintenance? Check status.monday.com

# C. SharePoint/external services
# Are they accessible?

# D. Database/Storage corruption
# If data is wrong, rolling back code won't fix it

# 3. Next steps:
# Contact team leads for each component
# Monday.com team, data team, infrastructure team
# Restore data if needed (backup)
# Once components fixed, redeploy new code
```

---

## Problem: Multiple Failed Rollbacks

**Symptom:**
```
Tried rollback 3 times, app still broken
Last 3 commits are all problematic
```

**Solution:**

```powershell
# 1. STOP - Don't keep reverting, investigate
git log --oneline -10

# 2. Find the REAL problem commit
# Likely: Regression from weeks ago, now surfaced

git log --oneline -30 | Select-Object -First 15

# 3. Identify the culprit
# Check each commit for major changes
git diff abc1234..def5678 --stat

# 4. Revert to a known-good commit (further back)
git log --oneline | grep -i "stable\|working\|prod"

# Or
git reflog | head -20  # Shows recent checkouts

# 5. Revert to specific commit
git revert abc1234 --no-edit  # (known-good)
git push origin master

# 6. Let GitHub Actions deploy
# Wait 3-5 minutes

# 7. Verify
curl -k https://doc-automation-func.azurewebsites.net/api/health

# 8. If working, investigate the real issue
git diff abc1234..HEAD -- src/functions/
# Review what changed between good and bad

# 9. Plan fix
# Create a feature branch
git checkout -b fix/investigate-regression
# Fix the issue
# Test locally: npm test
# Commit and push to PR
# Review before merging to master
```

---

## Escalation: When All Else Fails

**If you've tried everything and production is still broken:**

1. **Stop All Deployments**
   ```powershell
   # Don't attempt more rollbacks, you'll make it worse
   # Notify team immediately
   ```

2. **Gather Information**
   ```powershell
   # Collect all logs
   az webapp log download -g doc-automation-rg -n doc-automation-func
   
   # Export logs from Kudu
   https://doc-automation-func.scm.azurewebsites.net/api/logs/application
   
   # Get app configuration
   az functionapp config show -g doc-automation-rg -n doc-automation-func
   
   # Get recent deployments
   az functionapp deployment list -g doc-automation-rg -n doc-automation-func -o table
   ```

3. **Contact**
   - **Francisco Lopez** (DocFlow owner): franky.lopez@medwatchers.com
   - **On-Call Engineer** (check PagerDuty)
   - **Slack:** #doc-automation

4. **Provide This Info**
   - What was deployed (commit hash, changes)
   - What broke (health check, webhook, data corruption)
   - Steps taken so far (rollbacks attempted)
   - Current app logs (last 100 lines)
   - Timeline (when deployed, when issue discovered)

5. **Next Steps (Led by Team)**
   - Manual database restore if needed
   - Direct Azure Portal intervention
   - Data reconciliation with Monday.com
   - Post-mortem to prevent recurrence

---

**Last Updated:** 2026-08-13  
**Related:** ROLLBACK_STRATEGY.md · ROLLBACK_QUICKREF.txt · rollback.ps1

For emergencies outside business hours, contact PagerDuty on-call engineer.
