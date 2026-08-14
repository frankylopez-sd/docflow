# ValidateADP Regional Issue Diagnosis Guide

## Overview

This guide provides a systematic approach to determine if validateADP is experiencing regional availability or performance issues by deploying to multiple Azure regions and comparing behavior.

## Regional Hypothesis

**Issue**: ValidateADP may be failing or performing inconsistently in certain regions.

**Test Strategy**:
1. Deploy validateADP to primary region (westus) - current production
2. Deploy validateADP to secondary region (eastus) - for comparison
3. Run identical test suites against both deployments
4. Analyze results to identify regional dependencies

## Quick Start (3 Steps)

### Step 1: Deploy to Secondary Region
```powershell
cd C:\Users\Franky.Lopez\docflow
.\deploy-multiregion.ps1 -PrimaryRegion westus -SecondaryRegion eastus
```

**What this does:**
- Creates new resource group in eastus
- Creates new storage account in eastus
- Creates new function app in eastus
- Deploys validateADP codebase to both regions
- Runs health checks on both

**Expects:** Both regions should return 200 OK on `/api/health`

### Step 2: Run Regional Tests
```powershell
.\test-validateadp-regional.ps1 `
  -Primary https://doc-automation-func.azurewebsites.net `
  -Secondary https://doc-automation-func-eastus.azurewebsites.net `
  -Iterations 10 `
  -Verbose
```

**What this does:**
- Sends 10 identical validateADP requests to each region
- Measures response time, success rate, and error patterns
- Compares reliability and performance
- Identifies systematic failures

**Interprets Results:**
- ✓ Both regions OK + similar latency = No regional issue
- ✗ Secondary fails consistently = Regional issue in eastus
- ✗ Primary slower than secondary = Performance degradation in westus
- ✗ Timeout pattern in one region = Network or cold-start issue

### Step 3: Deep Diagnosis (if issue found)
```powershell
.\diagnose-regional-issue.ps1 `
  -PrimaryApp doc-automation-func `
  -SecondaryApp doc-automation-func-eastus `
  -PrimaryResourceGroup doc-automation-rg `
  -SecondaryResourceGroup doc-automation-rg-eastus `
  -CheckExternal `
  -RetrieveLogs
```

**What this does:**
- Verifies deployment state in each region
- Checks application configuration consistency
- Retrieves error logs from both regions
- Tests external dependencies (Monday.com, Adobe, Storage)
- Identifies root cause of regional differences

## Detailed Analysis

### Regional Issue Patterns

#### Pattern 1: Secondary Region Completely Down
```
PRIMARY: ✓ 200 OK (45ms avg)
SECONDARY: ✗ Connection Error or Timeout
```
**Likely Causes:**
- Function app deployment failed in secondary
- App Service Plan not created in secondary region
- Storage account inaccessible from secondary region
- WARP firewall blocking secondary region outbound

**Fix:**
```powershell
# Verify secondary app exists
az functionapp show -n doc-automation-func-eastus -g doc-automation-rg-eastus

# Check app service plan
az appservice plan list -g doc-automation-rg-eastus

# Verify storage connectivity
az storage account show -n [storageName] -g doc-automation-rg-eastus
```

#### Pattern 2: Secondary Slower Than Primary
```
PRIMARY: ✓ 200 OK (45ms avg)
SECONDARY: ✓ 200 OK (200ms avg)
```
**Likely Causes:**
- Cold start (first call) in secondary region
- Secondary region geographically farther from external APIs
- Secondary region has different VM SKU
- Network latency to dependent services (Monday, Adobe)

**Fix:**
```powershell
# Warm up secondary region (pre-load execution)
$warmupPayload = '{"email":"warmup@example.com"}'
for ($i = 1; $i -le 5; $i++) {
  Invoke-WebRequest -Uri "https://doc-automation-func-eastus.azurewebsites.net/api/validateADP" `
    -Method POST -Body $warmupPayload -ContentType "application/json"
  Start-Sleep -Seconds 2
}

# Run tests again
.\test-validateadp-regional.ps1 -Primary ... -Secondary ... -Iterations 10
```

#### Pattern 3: Authentication/Configuration Failure in One Region
```
PRIMARY: ✓ 200 OK with valid response
SECONDARY: ✗ 401 Unauthorized OR Invalid Key Vault reference
```
**Likely Causes:**
- Key Vault not accessible from secondary region
- MSI (Managed Identity) not configured in secondary
- Secret references not propagated to secondary
- Regional Key Vault endpoint difference

**Fix:**
```powershell
# Check Key Vault access
az keyvault show -n mw-docflow-kv -g doc-automation-rg

# Verify managed identity in secondary
az functionapp identity show -n doc-automation-func-eastus -g doc-automation-rg-eastus

# Check if app settings are replicated
az functionapp config appsettings list -n doc-automation-func -g doc-automation-rg | wc -l
az functionapp config appsettings list -n doc-automation-func-eastus -g doc-automation-rg-eastus | wc -l
```

#### Pattern 4: Intermittent Failures in One Region
```
PRIMARY: 10/10 success (100%)
SECONDARY: 7/10 success (70%) - random failures
```
**Likely Causes:**
- Flaky network connectivity in secondary region
- Rate limiting on external APIs hitting secondary harder
- Intermittent outage of dependent service by region
- Connection pool exhaustion in secondary

**Fix:**
```powershell
# Increase retry logic and backoff
# Test with larger payload to identify buffer issues
# Monitor external API usage per region

# Example: Monitor Monday.com API rate limit
$headers = @{ Authorization = "Bearer $env:MONDAY_API_TOKEN" }
$result = Invoke-WebRequest -Uri "https://api.monday.com/graphql" `
  -Method POST `
  -Body '{"query":"query{me{id}}"}' `
  -Headers $headers
$result.Headers | Where-Object { $_ -match "RateLimit" }
```

### Dependency Matrix

Test each external dependency separately to isolate which one has regional issues:

| Dependency | Endpoint | Region Test |
|---|---|---|
| **Monday.com** | `api.monday.com/graphql` | Call from each region's function app |
| **Adobe Sign** | `api.na1.echosign.com/api/rest/v6` | Token generation + API call |
| **Azure Storage** | `doc-auto-[region].blob.core.windows.net` | Write/read test blob |
| **Azure Key Vault** | `mw-docflow-kv.vault.azure.net` | Secret retrieval test |

**Test Script Template:**
```powershell
function Test-Dependency {
    param($Region, $DependencyName, $Endpoint)

    $startTime = Get-Date
    try {
        $response = Invoke-WebRequest -Uri $Endpoint -TimeoutSec 10 -UseBasicParsing
        $latency = (Get-Date) - $startTime
        Write-Host "$Region/$DependencyName: OK ($($latency.TotalMilliseconds)ms)"
        return $true
    } catch {
        Write-Host "$Region/$DependencyName: FAIL ($($_.Exception.Message))"
        return $false
    }
}

# Run from each region's function app context
Test-Dependency -Region "Primary" -DependencyName "Monday" -Endpoint "https://api.monday.com/graphql"
Test-Dependency -Region "Secondary" -DependencyName "Monday" -Endpoint "https://api.monday.com/graphql"
```

## Cleanup (When Testing Complete)

```powershell
# Delete secondary region resources if issue is confirmed to be non-regional
az group delete -n doc-automation-rg-eastus --yes

# Keep secondary if regional difference is found (for monitoring/backup)
Write-Host "Secondary deployment preserved for regional monitoring"
```

## Results Interpretation

### No Regional Issue Found
- ✓ Both regions pass 100% of requests
- ✓ Response times are comparable
- ✓ Same error patterns in both regions
- **Action**: Issue is not regional; investigate other factors (data, time-based, user-specific)

### Regional Issue Confirmed
- ✗ One region has significantly higher failure rate
- ✗ Performance degradation in one region
- ✗ Specific error type only in one region
- **Action**: Follow root cause diagnosis section above

## Monitoring & Telemetry

### Application Insights Queries

```kusto
// Query validateADP performance by region
requests
| where name == "POST /api/validateADP"
| where cloud_RoleInstance startswith "doc-automation"
| summarize
    Count=count(),
    AvgDuration=avg(duration),
    FailureCount=sum(itemCount * (toint(success == false)))
    by cloud_RoleInstance
| project Region=cloud_RoleInstance, RequestCount=Count, AvgResponseTime=AvgDuration, Failures=FailureCount
```

```kusto
// Query dependency failures by type
dependencies
| where name in ("Monday API", "Adobe Sign API", "Storage Account")
| where cloud_RoleInstance startswith "doc-automation"
| summarize
    Calls=count(),
    Failures=sum(itemCount * (toint(success == false)))
    by cloud_RoleInstance, name
| project Region=cloud_RoleInstance, Dependency=name, TotalCalls=Calls, Failures=Failures
```

## File Reference

| File | Purpose |
|---|---|
| `deploy-multiregion.ps1` | Deploy validateADP to primary and secondary regions |
| `test-validateadp-regional.ps1` | Run comparative tests (latency, reliability) |
| `diagnose-regional-issue.ps1` | Deep diagnostic of deployment and dependencies |
| `REGIONAL_DIAGNOSIS_GUIDE.md` | This guide |

## Next Steps

1. **Immediate**: Run Steps 1-2 to collect diagnostic data
2. **Analysis**: Share test results in engineering meeting
3. **Root Cause**: Run Step 3 and dependency tests if issue confirmed
4. **Resolution**: Fix identified regional issue or implement fallback strategy
5. **Monitoring**: Set up regional health checks in Application Insights

## Support & Questions

For detailed logs and metrics:
- **Primary Logs**: `https://doc-automation-func.scm.azurewebsites.net/api/logs/web`
- **Secondary Logs**: `https://doc-automation-func-eastus.scm.azurewebsites.net/api/logs/web`
- **App Insights**: Azure Portal → doc-automation-func → Application Insights
