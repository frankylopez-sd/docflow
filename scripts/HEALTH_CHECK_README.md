# DocFlow Health Check Scripts

Comprehensive health check and endpoint testing utilities for the DocFlow document automation platform.

## Overview

DocFlow health checks verify:
- **11 Azure Functions** deployed and operational
- **HTTP Endpoints** (public and protected) responding correctly
- **Azure Storage Queues** (generate, sign, archive) connectivity
- **Azure Key Vault** secret access
- **Function App Configuration** and runtime settings
- **Queue-triggered Functions** status
- **Timer-triggered Functions** configuration

## Scripts

### 1. `health-check.ps1` (PowerShell)

Comprehensive health check for Windows/PowerShell environments.

#### Usage

```powershell
# Basic health check
.\health-check.ps1

# Include detailed response information
.\health-check.ps1 -IncludeDetails

# Custom app/resource group
.\health-check.ps1 -FunctionAppName "doc-automation-func" -ResourceGroup "doc-automation-rg"

# Set timeout (default 30 seconds)
.\health-check.ps1 -TimeoutSeconds 60
```

#### Output

```
[PASS] Function App is running
[PASS] GET /api/health
[PASS] POST /api/validateADP
[PASS] POST /api/mondayWebhook
[WARN] Key Vault access failed

Summary
================================================
Passed:   25
Failed:   0
Warnings: 1

Overall Status: HEALTHY
```

#### Exit Codes

- `0` - All checks passed (HEALTHY)
- `1` - Some checks failed (DEGRADED)
- `2` - Multiple checks failed (UNHEALTHY)

---

### 2. `health-check.sh` (Bash/POSIX)

Health check for Linux/macOS/WSL environments (POSIX-compliant).

#### Usage

```bash
# Basic health check
./health-check.sh

# Include detailed output
./health-check.sh --include-details

# Custom configuration
./health-check.sh --app-name doc-automation-func --resource-group doc-automation-rg

# Environment variables
export FUNCTION_APP_NAME="doc-automation-func"
export RESOURCE_GROUP="doc-automation-rg"
./health-check.sh
```

#### Requirements

- `bash` or POSIX shell
- `curl` (for HTTP requests)
- `az` CLI (for Azure queries)
- Access to Azure subscription

---

### 3. `test-endpoints.ps1` (Detailed Endpoint Testing)

Detailed endpoint testing with verbose output, timing, and auth verification.

#### Usage

```powershell
# Test all endpoints
.\test-endpoints.ps1

# Test with detailed request/response bodies
.\test-endpoints.ps1 -ShowDetails

# Test specific endpoint
.\test-endpoints.ps1 -Endpoint "health"
.\test-endpoints.ps1 -Endpoint "validateADP" -ShowDetails

# Test with custom payload
.\test-endpoints.ps1 -Endpoint "validateADP" -Payload '{"employeeId":"EMP-123","firstName":"John"}'

# Custom function app
.\test-endpoints.ps1 -FunctionAppName "doc-automation-func" -ShowDetails
```

#### Example Output

```
======================================================================
health - Application health check
======================================================================

▶ URL
  URL                 : https://doc-automation-func.azurewebsites.net/api/health
  Method              : GET
  Auth Level          : anonymous
  Route               : health

▶ Sending Request...
  [Request sent]

▶ Response
  Status Code         : 200 OK
  Duration            : 245ms
  Content Length      : 156 bytes
  Content Type        : application/json

✓ PASS

Test Summary
======================================================================
Total Tests:    7
Passed:         7
Failed:         0
Avg Duration:   234ms

Overall Status: PASS
```

---

## Function Inventory

### HTTP-Triggered (Directly Testable)

#### Public/Anonymous Endpoints

| Endpoint | Method | Route | Description |
|----------|--------|-------|-------------|
| health | GET | `/api/health` | Application health check |
| validateADP | POST | `/api/validateADP` | Validate ADP employee data |
| mondayWebhook | POST | `/api/mondayWebhook` | Monday.com webhook receiver |
| adobeWebhook | GET/POST | `/api/adobeWebhook` | Adobe webhook receiver |

#### Protected Endpoints (Function Key Required)

| Endpoint | Method | Route | Description |
|----------|--------|-------|-------------|
| downloadSigned | GET | `/api/downloadSigned/{agreementId}` | Download signed PDF |
| updateMonday | POST | `/api/updateMonday` | Update Monday.com item |
| createADPUser | POST | `/api/createADPUser` | Create ADP user record |

### Queue-Triggered Functions

| Function | Queue | Trigger | Purpose |
|----------|-------|---------|---------|
| generatePDF | `docflow-generate` | Monday webhook → PDF generation | Create unsigned PDF from template |
| sendForSign | `docflow-sign` | PDF generated → SignNow envelope | Send document for e-signature |
| archiveToBlob | `docflow-archive` | Signing complete → Archive | Store signed PDF in SharePoint |

### Timer-Triggered Functions

| Function | Schedule | Purpose |
|----------|----------|---------|
| signPoller | Every 30 minutes | Poll SignNow for completion status |
| cleanup | 11:30 PM daily | Clean up temporary blob storage |

---

## Endpoint Testing Guide

### 1. Testing Public Endpoints

No authentication required. Test directly:

```powershell
# Health check
curl https://doc-automation-func.azurewebsites.net/api/health

# Validate ADP
curl -X POST https://doc-automation-func.azurewebsites.net/api/validateADP \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"TEST-001"}'
```

### 2. Testing Protected Endpoints

Requires function key from Azure Function App:

```powershell
# Get function key
$funcKey = az functionapp keys list `
  --name "doc-automation-func" `
  --resource-group "doc-automation-rg" `
  --query "functionKeys.default" -o tsv

# Test with key
curl -X POST https://doc-automation-func.azurewebsites.net/api/updateMonday \
  -H "Content-Type: application/json" \
  -H "x-functions-key: $funcKey" \
  -d '{"itemId":0,"updates":{}}'
```

### 3. Testing Queue Functions

Queue-triggered functions cannot be tested directly via HTTP. Monitor via:

```powershell
# Check queue depth
az storage queue metadata show --name "docflow-generate" --auth-mode login

# View queue messages (if any)
az storage queue message list --queue-name "docflow-generate" --auth-mode login

# View function logs
az functionapp log download --name "doc-automation-func" --resource-group "doc-automation-rg"
```

### 4. Testing Timer Functions

Timer functions run on schedule. Monitor via:

```powershell
# View recent invocations in Application Insights
az monitor app-insights metrics show \
  --resource-group "doc-automation-rg" \
  --app "docflow-ai" \
  --metric "functionExecutionCount"

# View invocation details
az monitor app-insights query \
  --resource-group "doc-automation-rg" \
  --app "docflow-ai" \
  --analytics-query "customMetrics | where name == 'signPoller_invocation' | top 10 by timestamp desc"
```

---

## Troubleshooting

### Endpoint Returns 401 (Unauthorized)

**Issue**: Protected endpoint requires function key.

**Solution**:
```powershell
# Retrieve function key
$key = az functionapp keys list --name "doc-automation-func" `
  --resource-group "doc-automation-rg" --query "functionKeys.default" -o tsv

# Add to header
curl -H "x-functions-key: $key" ...
```

### Endpoint Returns 403 (Forbidden)

**Issue**: CORS or IP restriction.

**Check**:
```powershell
# Verify function app network settings
az functionapp config show --name "doc-automation-func" --resource-group "doc-automation-rg"
```

### Queue Access Denied

**Issue**: Storage account permissions missing.

**Solution**:
```powershell
# Verify Managed Identity permissions
az role assignment list --assignee <function-app-object-id> --scope /subscriptions/<sub>/resourceGroups/doc-automation-rg
```

### Health Check Returns 502 (Bad Gateway)

**Issue**: Function App crashed or not responding.

**Check**:
```powershell
# Check app status
az functionapp show --name "doc-automation-func" --resource-group "doc-automation-rg" --query "state"

# Restart app
az functionapp restart --name "doc-automation-func" --resource-group "doc-automation-rg"

# View error logs
az functionapp log download --name "doc-automation-func" --resource-group "doc-automation-rg"
```

### Key Vault Access Failed

**Issue**: Managed Identity doesn't have Key Vault permissions.

**Solution**:
```powershell
# Assign Key Vault Secret User role to function app
$functionAppId = az functionapp identity show --name "doc-automation-func" `
  --resource-group "doc-automation-rg" --query "principalId" -o tsv

az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee-object-id $functionAppId \
  --scope /subscriptions/<sub>/resourceGroups/doc-automation-rg/providers/Microsoft.KeyVault/vaults/docflow-kv
```

---

## Integration with CI/CD

### GitHub Actions

```yaml
name: DocFlow Health Check

on:
  schedule:
    - cron: '0 * * * *'  # Every hour
  workflow_dispatch:

jobs:
  health-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      
      - name: Run health check
        run: |
          chmod +x scripts/health-check.sh
          scripts/health-check.sh --include-details
```

### Azure DevOps

```yaml
trigger:
  - main

schedules:
  - cron: "0 * * * *"
    displayName: Hourly health check
    branches:
      include:
      - main

jobs:
  - job: HealthCheck
    pool:
      vmImage: 'ubuntu-latest'
    steps:
      - checkout: self
      
      - task: AzureCLI@2
        inputs:
          azureSubscription: 'DocFlow'
          scriptType: 'bash'
          scriptLocation: 'scriptPath'
          scriptPath: '$(System.DefaultWorkingDirectory)/scripts/health-check.sh'
          arguments: '--include-details'
```

---

## Performance Baselines

Typical response times for healthy endpoints:

| Endpoint | Expected Duration | Threshold |
|----------|-------------------|-----------|
| health | 200-300ms | > 1000ms = slow |
| validateADP | 300-500ms | > 2000ms = slow |
| mondayWebhook | 500-1000ms | > 5000ms = slow |
| downloadSigned | 1000-2000ms | > 10000ms = slow |

If endpoints consistently exceed thresholds, check:
- Azure subscription quotas
- Storage account scaling settings
- Key Vault rate limits
- Monday.com API rate limits

---

## Monitoring & Alerts

### Application Insights Queries

```kusto
# Function execution count over time
customMetrics
| where name == "docflow_execution_count"
| summarize count() by bin(timestamp, 1m)
| render linechart

# Error rate by function
customMetrics
| where name == "docflow_error_count"
| extend function = tostring(customDimensions.function)
| summarize errors = sum(value) by function
| render barchart

# Queue depth over time
customMetrics
| where name == "docflow_queue_depth"
| extend queue = tostring(customDimensions.queue)
| summarize depth = avg(value) by queue, bin(timestamp, 5m)
| render timechart
```

### Alert Rules

Recommended alerts:

1. **Function App Down** - Status code 502+ for 5+ minutes
2. **High Error Rate** - >5% errors for 10 minutes
3. **Queue Backup** - Depth > 1000 messages
4. **Slow Endpoints** - Response time > 5 seconds
5. **Storage Quota** - >80% usage

---

## Related Documentation

- [DocFlow Deployment Method](../docs/deployment.md)
- [Azure Functions Runtime](https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node)
- [Application Insights](https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview)
- [Azure Storage Queues](https://learn.microsoft.com/en-us/azure/storage/queues/storage-queues-introduction)
