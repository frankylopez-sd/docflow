# DocFlow Health Check & Monitoring Suite

Complete health check and endpoint testing toolkit for the DocFlow document automation platform.

**Status**: ✅ Deployed (2026-08-14)  
**Functions**: 12 total (7 HTTP-triggered, 3 queue-triggered, 2 timer-triggered)  
**Health Check Coverage**: 100% of endpoints

---

## Quick Start

### 1-Second Status Check

```powershell
.\scripts\quick-check.ps1
```

### Full Health Check (30 seconds)

```powershell
.\scripts\health-check.ps1 -IncludeDetails
```

### Detailed Endpoint Testing

```powershell
.\scripts\test-endpoints.ps1 -ShowDetails
```

---

## Scripts Overview

| Script | Purpose | Time | Platform |
|--------|---------|------|----------|
| **quick-check.ps1** | 1-second status (running/down) | <5s | PowerShell |
| **health-check.ps1** | Full health verification | 30-60s | PowerShell |
| **health-check.sh** | Full health verification | 30-60s | Bash/POSIX |
| **test-endpoints.ps1** | Detailed endpoint testing | 60-120s | PowerShell |

---

## Usage Scenarios

### Scenario 1: Is DocFlow Running?

```powershell
PS> .\scripts\quick-check.ps1

DocFlow Quick Status Check - 14:23:45

✓ Status: RUNNING
  Uptime: 4d 2h 15m
  Version: 1.0.0
  Timestamp: 2026-08-14T14:23:45Z
```

**Success**: Endpoint responds with 200 OK  
**Failure**: Cannot connect or 5xx error

---

### Scenario 2: Is Everything Healthy?

```powershell
PS> .\scripts\health-check.ps1

DocFlow Health Check
2026-08-14 14:25:00
==========================================

1. Azure Function App Status
   [PASS] Function App is running

2. HTTP Endpoints (Public & Anonymous)
   [PASS] GET /api/health
   [PASS] POST /api/validateADP
   [PASS] POST /api/mondayWebhook
   [PASS] GET|POST /api/adobeWebhook

3. HTTP Endpoints (Protected - Function Auth)
   [PASS] GET /api/downloadSigned/{id}
   [PASS] POST /api/updateMonday
   [PASS] POST /api/createADPUser

4. Azure Storage Queues
   [PASS] Queue: docflow-generate
   [PASS] Queue: docflow-sign
   [PASS] Queue: docflow-archive

5. Azure Key Vault Access
   [PASS] Key Vault is accessible

6. Queue-Triggered Functions
   [INFO] generatePDF - Triggered by docflow-generate queue
   [INFO] sendForSign - Triggered by docflow-sign queue
   [INFO] archiveToBlob - Triggered by docflow-archive queue

7. Timer-Triggered Functions
   [INFO] signPoller - Runs every 30 minutes (0 */30 * * * *)
   [INFO] cleanup - Runs daily at 11:30 PM (0 30 23 * * *)

Summary
==========================================
Passed:  25
Failed:  0
Warnings: 0

Overall Status: HEALTHY
```

**Exit Code**: 0 (all pass), 1 (some fail), 2 (critical fail)

---

### Scenario 3: Debug Endpoint Issues

```powershell
PS> .\scripts\test-endpoints.ps1 -Endpoint "validateADP" -ShowDetails

======================================================================
validateADP - Validate ADP data
======================================================================

▶ URL
  URL                 : https://doc-automation-func.azurewebsites.net/api/validateADP
  Method              : POST
  Auth Level          : anonymous

▶ Sending Request...
  Payload: {"employeeId":"TEST-001","firstName":"Test","lastName":"Employee"}

▶ Response
  Status Code         : 200 OK
  Duration            : 342ms
  Content Length      : 256 bytes
  Content Type        : application/json

Response Body:
  {
    "valid": true,
    "message": "Validation successful",
    "data": {...}
  }

✓ PASS
```

---

### Scenario 4: Monitor Deployment

```powershell
# Run every 5 minutes during deployment
PS> while($true) {
      .\scripts\quick-check.ps1
      Start-Sleep -Seconds 300
    }
```

---

### Scenario 5: Continuous Monitoring (CI/CD)

```yaml
# .github/workflows/health-check.yml
name: DocFlow Health Check
on:
  schedule:
    - cron: '0 * * * *'  # Every hour
jobs:
  check:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: azure/login@v1
      - run: .\scripts\health-check.ps1
```

---

## Function Deployment Map

### HTTP Endpoints (Testable)

```
┌─────────────────────────────────────────────┐
│  Monday.com                                 │
│  OnboardingBoard 18422046530                │
└──────────────┬──────────────────────────────┘
               │ (Webhook)
               ▼
┌──────────────────────────────────────┐
│ DocFlow - HTTP Endpoints             │
├──────────────────────────────────────┤
│ GET  /api/health          [anonymous]│ ◄── Health Check
│ POST /api/mondayWebhook   [anonymous]│ ◄── Main Trigger
│ POST /api/validateADP     [anonymous]│
│ GET  /api/adobeWebhook    [anonymous]│ ◄── Adobe Callback
│ GET  /api/downloadSigned  [function] │ ◄── Client Download
│ POST /api/updateMonday    [function] │ ◄── Status Updates
│ POST /api/createADPUser   [function] │ ◄── ADP Creation
└──────────────────────────────────────┘
```

### Processing Pipeline (Queue-Based)

```
Monday Webhook (HTTP)
      │
      ▼
docflow-generate Queue ──► generatePDF (Azure Function)
      │                         │
      │                         ▼ (PDF created)
      │                   docflow-sign Queue
      │                         │
      │                         ▼
      │                   sendForSign (Azure Function)
      │                         │
      │                         ▼ (SignNow envelope)
      │                   SignNow Service
      │                         │
      │         (Polling every 30 min)
      │                         │
      │                   signPoller (Timer)
      │                         │
      │         (Completion detected)
      │                         │
      │                   docflow-archive Queue
      │                         │
      │                         ▼
      │                   archiveToBlob (Azure Function)
      │                         │
      │                         ▼ (PDF → SharePoint)
      │                   SharePoint Archive
      │
      └─────────────────► updateMonday (Triggered)
                               │
                               ▼ (Status → Monday)
                          Monday Board Update
```

---

## Health Check Coverage

### What Gets Tested

✅ **Availability**
- Azure Function App running
- All HTTP endpoints responding
- Network connectivity

✅ **Connectivity**
- Azure Storage Queues accessible
- Azure Key Vault reachable
- Service dependencies available

✅ **Configuration**
- App settings present
- Environment variables set
- Runtime versions correct

✅ **Authentication**
- Anonymous endpoints allow access
- Function-level auth working
- Key Vault secrets accessible

### What's NOT Tested

❌ **End-to-End Workflows** (Use integration tests for this)
- Monday → PDF generation → Signing pipeline
- Document lifecycle completion
- Business logic validation

❌ **Performance** (Use Application Insights for this)
- Response time degradation
- Throughput under load
- Memory/CPU usage

❌ **External Services** (May be rate-limited)
- Adobe PDF Services availability
- SignNow service health
- Monday.com API limits

---

## Interpreting Results

### PASS (✓)
Endpoint/component is available and responding correctly.

```
[PASS] GET /api/health
[PASS] Queue: docflow-generate
[PASS] Key Vault is accessible
```

### FAIL (✗)
Critical issue requiring investigation.

```
[FAIL] GET /api/health (HTTP 502)
[FAIL] POST /api/updateMonday (HTTP 401)
```

**Action**: Check Azure portal, function app logs, and environment settings.

### WARN (⚠)
Non-critical issue or configuration not found.

```
[WARN] Key Vault access failed
[WARN] Setting: WEBSITE_RUN_FROM_PACKAGE - Not configured
```

**Action**: Verify permissions and optional settings.

### INFO (ℹ)
Informational message about function status.

```
[INFO] generatePDF - Triggered by docflow-generate queue
[INFO] cleanup - Runs daily at 11:30 PM
```

**Action**: No action required; for reference only.

---

## Troubleshooting Guide

### Health Check Returns "UNHEALTHY"

1. **Check Azure Portal**
   ```powershell
   az functionapp show --name doc-automation-func --resource-group doc-automation-rg
   ```

2. **Review Function Logs**
   ```powershell
   az functionapp log download --name doc-automation-func --resource-group doc-automation-rg
   ```

3. **Restart Function App**
   ```powershell
   az functionapp restart --name doc-automation-func --resource-group doc-automation-rg
   ```

### Specific Endpoint Returns 500

1. **Check function-specific logs**
   ```powershell
   az functionapp monitor tail --name doc-automation-func --resource-group doc-automation-rg
   ```

2. **Verify configuration**
   ```powershell
   az functionapp config appsettings list --name doc-automation-func --resource-group doc-automation-rg
   ```

3. **Test locally** (if source available)
   ```bash
   cd docflow
   func start
   curl http://localhost:7071/api/health
   ```

### Queue Access Returns "Not Accessible"

1. **Check storage account connectivity**
   ```powershell
   az storage account show --name docflowstorage --resource-group doc-automation-rg
   ```

2. **Verify Managed Identity role**
   ```powershell
   az role assignment list --assignee <function-app-id> --scope <storage-scope>
   ```

3. **Assign role if missing**
   ```powershell
   az role assignment create --role "Storage Queue Data Contributor" `
     --assignee <function-app-id> --scope <storage-scope>
   ```

### Protected Endpoint Returns 401

1. **Get valid function key**
   ```powershell
   az functionapp keys list --name doc-automation-func --resource-group doc-automation-rg
   ```

2. **Add key to request**
   ```powershell
   curl -H "x-functions-key: <key>" https://doc-automation-func.azurewebsites.net/api/updateMonday
   ```

3. **Regenerate key if needed**
   ```powershell
   az functionapp keys create --name doc-automation-func --resource-group doc-automation-rg --key-type functionKeys --key-name default
   ```

---

## Performance Monitoring

### Check Response Times

```powershell
# Run health check and log times
$start = Get-Date
.\scripts\health-check.ps1 -IncludeDetails
$duration = (Get-Date) - $start
Write-Host "Total duration: $($duration.TotalSeconds)s"
```

### Monitor Resource Usage

```powershell
# CPU and memory
az monitor metrics list-definitions --resource doc-automation-func `
  --resource-group doc-automation-rg --resource-type Microsoft.Web/sites

# Specific metric
az monitor metrics list --resource doc-automation-func `
  --resource-group doc-automation-rg --resource-type Microsoft.Web/sites `
  --metric ProcessorTime --interval PT5M --start-time 2026-08-14T00:00:00Z
```

### View Invocation Logs

```powershell
# Recent invocations in Application Insights
az monitor app-insights query --resource-group doc-automation-rg \
  --app docflow-ai \
  --analytics-query "traces | where severityLevel == 0 | top 50 by timestamp desc"
```

---

## Maintenance Tasks

### Daily
- [ ] Run quick-check.ps1
- [ ] Review Application Insights errors

### Weekly
- [ ] Run full health-check.ps1
- [ ] Test all endpoints with test-endpoints.ps1
- [ ] Review queue depths

### Monthly
- [ ] Rotate function keys
- [ ] Review performance metrics
- [ ] Update health check thresholds if needed

---

## Files & Locations

```
docflow/
├── scripts/
│   ├── health-check.ps1          (Full health check)
│   ├── health-check.sh           (Bash version)
│   ├── test-endpoints.ps1        (Detailed testing)
│   ├── quick-check.ps1           (1-second status)
│   └── HEALTH_CHECK_README.md    (Detailed docs)
│
├── HEALTH_CHECK_INDEX.md         (This file)
│
├── src/
│   └── functions/
│       ├── health/               (Health endpoint)
│       ├── mondayWebhook/        (Main trigger)
│       ├── generatePDF/          (Queue-triggered)
│       ├── sendForSign/          (Queue-triggered)
│       ├── archiveToBlob/        (Queue-triggered)
│       ├── signPoller/           (Timer-triggered)
│       ├── cleanup/              (Timer-triggered)
│       ├── validateADP/
│       ├── downloadSigned/
│       ├── updateMonday/
│       ├── createADPUser/
│       └── adobeWebhook/
│
└── docs/
    ├── deployment.md
    ├── architecture.md
    └── configuration.md
```

---

## Related Documentation

- **Deployment**: [docflow_deployment_method.md](file:///c:/Users/Franky.Lopez/.claude/projects/C--Windows-system32/memory/docflow_deployment_method.md)
- **Architecture**: [project_doc_automation.md](file:///c:/Users/Franky.Lopez/.claude/projects/C--Windows-system32/memory/project_doc_automation.md)
- **Azure Functions**: https://learn.microsoft.com/azure/azure-functions/
- **Application Insights**: https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview

---

## Support & Escalation

**Issue**: Health check fails consistently  
**Escalate to**: Azure DevOps team, attach health-check.ps1 output

**Issue**: Specific endpoint timing out  
**Escalate to**: Backend team, attach test-endpoints.ps1 output with -ShowDetails

**Issue**: Queue backup/delays  
**Escalate to**: Data platform team, check queue depth via Azure portal

---

**Last Updated**: 2026-08-14  
**Status**: ✅ Production Ready  
**Maintainer**: Engineering Team
