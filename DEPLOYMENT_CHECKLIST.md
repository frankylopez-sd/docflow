# DocFlow Deployment Checklist

**Run this before every push to `master` branch**

Use: Check boxes as you complete each step. If any fail, DO NOT push.

---

## PRE-DEPLOYMENT (Local)

```
[ ] 1. Current branch is master
      git branch
      
[ ] 2. Working directory is clean
      git status
      Expected: "On branch master... nothing to commit"
      
[ ] 3. All changes committed
      git log --oneline -3
      Expected: See your recent commits
      
[ ] 4. Up-to-date with remote
      git fetch origin master
      git log --oneline origin/master..HEAD
      Expected: Should be empty (no unpushed commits from others)
      
[ ] 5. Run full test suite
      npm test
      Expected: All tests pass (94/94 for DocFlow validateADP)
      
[ ] 6. Check linting (if applicable)
      npm run lint
      Expected: No errors
      
[ ] 7. Build locally (simulate production)
      npm ci --omit=dev
      Expected: Successfully installs dependencies
      
[ ] 8. Review what you're about to push
      git diff origin/master..HEAD
      Expected: Changes should be intentional, minimal, tested
      
[ ] 9. Write meaningful commit message
      git log -1 --pretty=%B
      Expected: Clear description of what changed and why
      
[ ] 10. Tag the commit (optional but recommended)
       git tag -a deployment-pre-$(date +%Y%m%d-%H%M%S) -m "Before: [FEATURE]"
       git push origin --tags
```

---

## PUSH & GITHUB ACTIONS

```
[ ] 11. Push to master
        git push origin master
        
        GitHub Actions will now:
        - Run npm test
        - Build deployment package
        - Deploy to Azure
        - Run health checks
        
[ ] 12. Monitor GitHub Actions workflow
        Open: https://github.com/medwatchers/docflow/actions
        Expected: "Deploy DocFlow to Azure" shows green checkmark
        
[ ] 13. Wait for complete deployment
        Expected: All 5-6 workflow steps complete
        Typical time: 5-10 minutes
        
        If FAILED:
        → Revert: git revert HEAD --no-edit && git push origin master
        → Investigate: Check workflow logs + Kudu logs
        → Fix locally and retry
```

---

## POST-DEPLOYMENT (Production Verification)

```
[ ] 14. Health check passes
        curl -k https://doc-automation-func.azurewebsites.net/api/health
        Expected: HTTP 200, {"status":"UP"} or similar
        
[ ] 15. Webhook endpoint responds
        curl -X POST -k https://doc-automation-func.azurewebsites.net/api/mondayWebhook \
          -H "Content-Type: application/json" \
          -d '{"test":true}'
        Expected: HTTP 200 (not 500/502)
        
[ ] 16. Check Kudu logs (no error spikes)
        Open: https://doc-automation-func.scm.azurewebsites.net/api/logs/application
        Expected: No 500 errors or stack traces
        
[ ] 17. Check Monday.com for webhook activity
        Board: 18422046530 (Onboarding)
        Expected: Activity feed shows recent item updates/creates
        
[ ] 18. No alerts in Slack/PagerDuty
        Expected: No errors, no high-CPU alerts, no timeouts
        Wait: At least 30 minutes before declaring success
        
[ ] 19. Sample production data looks correct
        Example: Create/update a test item in Monday
        Expected: DocFlow processes it without errors
        
[ ] 20. Tag successful deployment
        git tag deployment-prod-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
        git push origin --tags
        
        This makes rollback easier: git checkout deployment-prod-XXXXXXX
```

---

## IF ANYTHING FAILS

```
STOP DEPLOYMENT IMMEDIATELY
└─ Do NOT continue to step 14+

Option A: Health check fails or app won't start
└─ Run: .\rollback.ps1 -Mode Revert -Verify
└─ Check: Kudu logs + GitHub Actions logs
└─ Fix locally + test, then redeploy

Option B: App starts but production logic is broken
└─ If critical: .\rollback.ps1 -Mode Revert -Verify
└─ If minor: Deploy a fix commit instead of reverting

Option C: App hangs/frozen
└─ Run: .\rollback.ps1 -Mode KillApp
└─ This restarts the app process
```

---

## USEFUL MONITORING COMMANDS

While deployment is running:

```powershell
# Watch GitHub Actions (auto-refresh)
Start-Process "https://github.com/medwatchers/docflow/actions"

# Stream app logs (real-time)
az webapp log tail -g doc-automation-rg -n doc-automation-func

# Check deployment history
az functionapp deployment list -g doc-automation-rg -n doc-automation-func -o table

# View current app configuration
az functionapp config show -g doc-automation-rg -n doc-automation-func
```

---

## QUICK DEPLOY SCRIPT (One-Command)

Use this to automate the pre-deployment checks:

```powershell
# Save as: deploy-safe.ps1
$ErrorActionPreference = 'Stop'
cd C:\Users\Franky.Lopez\docflow

Write-Host "🔍 PRE-DEPLOYMENT CHECKS..." -ForegroundColor Cyan

# 1. Clean working tree
if (git status --porcelain) {
    Write-Host "✗ Working directory not clean" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Working directory clean" -ForegroundColor Green

# 2. Tests pass
npm test
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Tests failed" -ForegroundColor Red
    exit 1
}
Write-Host "✓ All tests pass" -ForegroundColor Green

# 3. Production build
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ npm ci failed" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Production dependencies installed" -ForegroundColor Green

# 4. Restore dev deps
npm install
Write-Host "✓ Dev dependencies restored" -ForegroundColor Green

# 5. Push
Write-Host ""
Write-Host "✅ ALL CHECKS PASSED" -ForegroundColor Green
Write-Host "Ready to deploy. Push to master? (y/n)" -ForegroundColor Cyan
$confirm = Read-Host

if ($confirm -eq "y") {
    git push origin master
    Write-Host ""
    Write-Host "📋 Monitoring GitHub Actions..." -ForegroundColor Cyan
    Start-Process "https://github.com/medwatchers/docflow/actions"
    Write-Host "⏳ Deployment in progress (5-10 min typical)" -ForegroundColor DarkGray
} else {
    Write-Host "⏸ Deployment cancelled" -ForegroundColor Yellow
}
```

---

## DEPLOYMENT ROLLBACK DECISION TREE

```
Deployment complete?
│
├─ NO → GitHub Actions failed
│   ├─ Check: Code syntax errors? Tests failed?
│   └─ Action: Fix locally, commit, push again
│
└─ YES, but production is broken?
    ├─ Health endpoint down? (HTTP 500)
    │   └─ Action: .\rollback.ps1 -Mode Revert -Verify
    │
    ├─ Webhook processing failing? (data errors)
    │   └─ Action: Check logic, either rollback or deploy fix
    │
    ├─ App unresponsive/hanging?
    │   └─ Action: .\rollback.ps1 -Mode KillApp -Verify
    │
    └─ Data corrupted in Monday?
        └─ Action: Contact data team, restore from backup, then rollback code
```

---

## Template: Commit Message for Deployment

Good commit messages help with rollback diagnosis:

```
[FEATURE] validateADP: Add missing field "EmployeeID" to ADP criteria mapping

Fixes: Monday issue #1234
Tested: 94/94 tests pass, validated with test data
Impact: Affects all new onboarding items (non-breaking change)
```

Structure:
- **First line:** [TYPE] Brief description
- **Blank line**
- **Body:** Why this change, what was tested, any gotchas
- **Type options:** [FEATURE], [FIX], [REFACTOR], [PERF], [DOCS], [TEST]

---

## After Successful Deployment (30 min later)

```
[ ] No Slack/PagerDuty alerts
[ ] No spike in error rates
[ ] Webhook processing completing normally
[ ] Team confirms feature working as expected
[ ] Commit is tagged for easy rollback if needed later

Congratulations! Deployment successful.
```

---

## Monthly: Rollback Drill

**Recommended:** Once per month, practice rollback to ensure procedures work:

```powershell
# 1. Tag current production commit
git tag -a rollback-drill-$(date +%Y%m%d) -m "Drill: test rollback procedure"

# 2. Simulate rollback
.\rollback.ps1 -Mode Revert -Verify

# 3. Verify it worked
# (All health checks pass, app responds, Monday data processes)

# 4. Roll forward again
git revert HEAD --no-edit && git push origin master

# 5. Document findings
# (Any issues found during drill? Fix the rollback procedures)
```

This ensures the rollback script is ready when actually needed.

---

**Owner:** Francisco Lopez  
**Last Updated:** 2026-08-13  
**Related:** [ROLLBACK_STRATEGY.md](ROLLBACK_STRATEGY.md) · [ROLLBACK_QUICKREF.txt](ROLLBACK_QUICKREF.txt)
