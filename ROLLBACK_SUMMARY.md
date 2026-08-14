# DocFlow Rollback Strategy — Complete Guide

**Date:** 2026-08-13  
**Status:** Ready for Implementation  
**Target:** Azure Function App `doc-automation-func` (West US 2)

---

## What's the Problem?

DocFlow deployment is direct to production with no slot/blue-green fallback. If a deployment breaks:

- Current production code goes live immediately
- Tests may pass but production logic fails
- Recovery requires Git revert + redeploy (2-5 minutes downtime)
- No instant rollback option exists

**This package solves that problem.**

---

## What We've Built For You

Four documents + three automation scripts provide complete rollback coverage:

### 1. **ROLLBACK_STRATEGY.md** (Full Documentation)
- Detailed explanation of all three rollback methods
- Step-by-step procedures with verification
- Blue-green deployment setup guide
- Monitoring & alerting recommendations
- Comparison table of all methods

### 2. **ROLLBACK_QUICKREF.txt** (Cheat Sheet)
- One-page quick reference for emergencies
- Copy-paste commands for each rollback scenario
- Verification checklist
- Escalation path if rollback fails

### 3. **DEPLOYMENT_CHECKLIST.md** (Pre-Deploy Safety)
- Run before every push to master
- Catches issues before they reach production
- Health checks and verification steps
- Rollback decision tree

### 4. **rollback.ps1** (Automation Script)
- One-command rollback for all three methods
- Three modes: Revert (Git), SlotSwap (Blue-Green), KillApp (Emergency)
- Automatic health verification
- Full logging and status output

### 5. **setup-slots.ps1** (Blue-Green Init)
- One-time setup to enable zero-downtime deployments
- Creates staging slot alongside production
- Verifies both slots are accessible
- Guide to updating deployment workflows

---

## Three Rollback Methods Explained

### Method 1: Direct Git Revert (Current, 2-5 min recovery)

```
Current State:
  master → broken code → deployed live → users see error

Recovery:
  $ git revert HEAD --no-edit
  $ git push origin master
  ↓
  GitHub Actions runs tests + deploys
  ↓
  ~3-5 minutes later: Previous code is live, issue resolved
```

**Pros:**
- Simple, no infrastructure changes needed
- Auditable (git history shows revert)
- Works with current setup immediately

**Cons:**
- 30-120 seconds of downtime during deploy
- Risk: If revert itself breaks, second rollback needed
- Webhook fails during deployment window

**Use when:** Code broke, tests should have caught it, need fast recovery

**Command:**
```powershell
.\rollback.ps1 -Mode Revert -Verify
```

---

### Method 2: Blue-Green Slot Swap (Recommended, 10-30 sec recovery)

```
Setup:
  Production Slot (current code)
  Staging Slot (previous code)

Deploy Flow:
  Push to master
  → Deploy to Staging first
  → Run smoke tests on Staging
  → If pass: Swap Staging ↔ Production (instant)
  → If fail: Keep old code, investigate

If emergency rollback needed:
  $ az functionapp deployment slot swap
  ↓
  10-30 seconds later: Previous code is live, zero downtime
```

**Pros:**
- Instant rollback (10-30 seconds)
- Zero downtime (warm slot swap)
- Broken code still available in staging for inspection
- Safest deployment method

**Cons:**
- Requires one-time slot setup (~5 minutes)
- Staging cost (~$10/month for consumption plan)
- Needs workflow update (30 lines of YAML)

**Use when:** You want safe, reversible deployments going forward

**Commands:**
```powershell
# One-time setup
.\setup-slots.ps1 -AppName doc-automation-func -ResourceGroup doc-automation-rg

# After setup, rollback is instant
.\rollback.ps1 -Mode SlotSwap -Verify
```

---

### Method 3: App Restart via Kudu (Last Resort, 30 sec recovery)

```
Emergency:
  App is hanging/frozen
  Direct revert not possible

Recovery:
  $ .\rollback.ps1 -Mode KillApp -Verify
  ↓
  Kudu sends signal to kill app process
  ↓
  Azure auto-restarts with cached code
  ↓
  30 seconds later: App is responsive again
```

**Pros:**
- Works in any situation
- No code changes needed
- Forces graceful restart

**Cons:**
- Last resort only (data loss risk)
- App briefly unavailable
- May not fix underlying issue

**Use when:** App is hung and direct revert failed

**Command:**
```powershell
.\rollback.ps1 -Mode KillApp
```

---

## Which Method Should You Use?

### RIGHT NOW (Today)
Use **Method 1: Direct Git Revert** if deployment breaks.

✅ Works with current setup  
✅ Takes 2-5 minutes  
✅ Recovery is guaranteed  

```powershell
cd C:\Users\Franky.Lopez\docflow
git revert HEAD --no-edit && git push origin master
```

### RECOMMENDED (This Week)
Set up **Method 2: Blue-Green Slots** for all future deployments.

✅ Instant rollback (10-30 sec)  
✅ Zero downtime  
✅ Safest approach long-term  

```powershell
.\setup-slots.ps1 -AppName doc-automation-func -ResourceGroup doc-automation-rg
```

Then update `.github/workflows/deploy.yml` to deploy to staging first. (Template in ROLLBACK_STRATEGY.md)

### EMERGENCY ONLY (If Needed)
Use **Method 3: Kudu Restart** if the above fail.

⚠️ Last resort  
⚠️ May cause data inconsistency  
⚠️ Use only if app is unresponsive  

```powershell
.\rollback.ps1 -Mode KillApp
```

---

## Quick Start: Rollback Right Now

**If production is broken RIGHT NOW:**

1. **Open PowerShell** in `C:\Users\Franky.Lopez\docflow`

2. **Run immediate rollback:**
   ```powershell
   .\rollback.ps1 -Mode Revert -Verify
   ```

3. **Wait** 3-5 minutes for GitHub Actions to complete

4. **Verify** production is healthy:
   ```
   https://doc-automation-func.azurewebsites.net/api/health
   ```

5. **Investigate** what went wrong:
   ```powershell
   git diff HEAD~2..HEAD
   ```

**Estimated time to recovery:** 3-5 minutes  
**Expected downtime:** 30-120 seconds

---

## Prevent Failures: Pre-Deployment Checklist

Run **before every push to master:**

```powershell
cd C:\Users\Franky.Lopez\docflow

# 1. All tests pass
npm test

# 2. No uncommitted changes
git status

# 3. Review what you're pushing
git log --oneline -1

# 4. Ready to push
git push origin master
```

**Full checklist:** See `DEPLOYMENT_CHECKLIST.md` for 20-point verification.

---

## Files You Now Have

```
docflow/
├── ROLLBACK_STRATEGY.md       ← Full documentation (read this for details)
├── ROLLBACK_QUICKREF.txt      ← One-page cheat sheet (emergency reference)
├── DEPLOYMENT_CHECKLIST.md    ← Pre-deploy safety checks
├── ROLLBACK_SUMMARY.md        ← This file (overview)
├── rollback.ps1               ← Main rollback automation script
├── setup-slots.ps1            ← Blue-green slot initialization
└── .github/workflows/
    └── deploy.yml             ← Current deployment (can be upgraded to blue-green)
```

**Start here:**
1. Read `ROLLBACK_QUICKREF.txt` (5 min) for emergency reference
2. Read `ROLLBACK_STRATEGY.md` (20 min) for full understanding
3. Save `rollback.ps1` to your PATH or run from docflow/ directory
4. When ready: Run `setup-slots.ps1` to enable blue-green deployments

---

## Monitoring: Know When Things Go Wrong

Set up these alerts to prevent surprise failures:

**Azure Portal → Application Insights → Alert Rules**

```
Rule 1: Health Check Failed
  Trigger: GET /api/health returns HTTP 5xx for 3+ requests
  Action: Email ops@medwatchers.com + Slack

Rule 2: Error Rate Spike
  Trigger: Exception rate > 10% of normal
  Action: PagerDuty incident

Rule 3: Response Time > 10s
  Trigger: 90th percentile latency > 10 seconds
  Action: Slack warning
```

**Monday.com Webhook:**
- Monitor board activity feed
- If no new items for 30+ minutes after deployment: Potential failure
- Check logs: `https://doc-automation-func.scm.azurewebsites.net/api/logs/application`

---

## Deployment Health Checks (After Deploy)

Always verify after deployment completes:

```powershell
# 1. Health endpoint
curl -k https://doc-automation-func.azurewebsites.net/api/health

# 2. Webhook endpoint
curl -X POST -k https://doc-automation-func.azurewebsites.net/api/mondayWebhook \
  -H "Content-Type: application/json" \
  -d '{"test":true}'

# 3. Check logs (should be clean)
https://doc-automation-func.scm.azurewebsites.net/api/logs/application

# 4. Monday.com activity (should show recent updates)
Board: 18422046530

# 5. Wait 30 minutes, check for alerts
No errors in Slack/PagerDuty
```

---

## Version Control Strategy

Tag every deployment for easy rollback:

```powershell
# After successful deployment
git tag deployment-prod-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
git push origin --tags

# To rollback to specific version later
git checkout deployment-prod-20260813-153422
git push -f origin master
```

---

## Testing Rollback (Monthly Drill)

**Recommended:** Practice rollback once per month to ensure procedures work.

```powershell
# 1. Tag current state
git tag drill-$(date +%Y%m%d) -m "Test rollback"

# 2. Practice rollback
.\rollback.ps1 -Mode Revert -Verify

# 3. Verify it works (health check, logs)
https://doc-automation-func.azurewebsites.net/api/health

# 4. Roll forward again
git revert HEAD --no-edit && git push origin master

# 5. Document findings
# Any issues? Update procedures.
```

---

## Troubleshooting

### "Rollback.ps1 not found"
```powershell
cd C:\Users\Franky.Lopez\docflow
.\rollback.ps1 -Mode Revert -Verify
```

### "GitHub Actions deployment stuck"
```powershell
# Check workflow status
Start-Process "https://github.com/medwatchers/docflow/actions"

# If truly stuck (rare), manually deploy
.\deploy\deploy.ps1 -App doc-automation-func -ResourceGroup doc-automation-rg
```

### "Health check fails but need to see what's running"
```powershell
# Access Kudu console
https://doc-automation-func.scm.azurewebsites.net/DebugConsole

# View logs in real-time
az webapp log tail -g doc-automation-rg -n doc-automation-func

# Check for errors
Get-Content "C:\LogFiles\Application\Functions\*.log"
```

### "Need to rollback but git revert conflicts"
```powershell
# Abort the revert
git revert --abort

# Use hard reset instead (use with caution)
git reset --hard origin/master~1
git push origin master
```

---

## Contacts & Escalation

**DocFlow Owner:** Francisco Lopez  
**Email:** franky.lopez@medwatchers.com  
**On-Call:** Check PagerDuty  
**Slack:** #doc-automation  

**Azure Resources:**
- Resource Group: `doc-automation-rg`
- Function App: `doc-automation-func` (West US 2)
- Storage Account: `docautostore*` (check portal)
- App Insights: Linked to function app

**Monday.com:**
- Target Board: 18422046530 (Onboarding)
- Webhook Endpoint: `/api/mondayWebhook`

---

## Next Steps

1. **Today:** Save this folder locally, read ROLLBACK_QUICKREF.txt
2. **This Week:** Set up blue-green slots (.\setup-slots.ps1)
3. **Next Deployment:** Use pre-deploy checklist (DEPLOYMENT_CHECKLIST.md)
4. **Monthly:** Practice rollback drill
5. **Ongoing:** Monitor health checks and logs

---

## Summary Table

| Scenario | Action | Time | Risk |
|----------|--------|------|------|
| **Broken deployment, app responds** | `.\rollback.ps1 -Mode Revert -Verify` | 3-5 min | Low |
| **Broken deployment, blue-green slots exist** | `.\rollback.ps1 -Mode SlotSwap -Verify` | 30 sec | Very Low |
| **App hanging/frozen** | `.\rollback.ps1 -Mode KillApp` | 30 sec | Medium |
| **Want safe future deploys** | `.\setup-slots.ps1` | 5 min setup | Very Low |
| **Before every push** | `DEPLOYMENT_CHECKLIST.md` | 5-10 min | Prevents issues |

---

**Last Updated:** 2026-08-13  
**Next Review:** After first blue-green deployment  
**Owner:** Francisco Lopez  

For questions or improvements, contact: franky.lopez@medwatchers.com
