# ValidateADP Regional Testing & Diagnosis Toolkit

**Purpose**: Determine if validateADP issues are caused by regional Azure deployment differences.

## Quick Start (< 5 minutes)

```powershell
cd C:\Users\Franky.Lopez\docflow

# Run complete automated diagnosis
.\run-full-regional-diagnosis.ps1

# Results will be saved to: regional-diagnosis-reports/diagnosis-YYYYMMDD-HHMMSS.html
```

Open the generated HTML report to see complete results and recommendations.

## What This Tests

✓ **Availability**: Can validateADP be called in both regions?
✓ **Reliability**: What's the success rate in each region?
✓ **Performance**: Is one region significantly slower?
✓ **Configuration**: Are app settings properly deployed to both regions?
✓ **Dependencies**: Can each region reach Monday.com, Adobe Sign, Storage, Key Vault?
✓ **Networking**: WARP firewall rules, regional restrictions, DNS issues

## Three Ways to Run

### Option 1: Fully Automated (Recommended)
```powershell
.\run-full-regional-diagnosis.ps1
```
- Runs all steps in sequence
- Generates HTML report
- Best for initial issue investigation

### Option 2: Manual Step-by-Step

**Step 1: Deploy to secondary region**
```powershell
.\deploy-multiregion.ps1 -PrimaryRegion westus -SecondaryRegion eastus
```
Expected output:
- ✓ Resource group created in eastus
- ✓ Storage account created in eastus  
- ✓ Function app created in eastus
- ✓ Code deployed to both regions
- ✓ Health checks passed (200 OK)

**Step 2: Run comparative tests**
```powershell
.\test-validateadp-regional.ps1 `
  -Primary https://doc-automation-func.azurewebsites.net `
  -Secondary https://doc-automation-func-eastus.azurewebsites.net `
  -Iterations 10 `
  -Verbose
```
Expected output:
- Shows success rate per region
- Latency comparison
- Error patterns
- Diagnosis of issue type

**Step 3: Deep diagnostic (if issue found)**
```powershell
.\diagnose-regional-issue.ps1 `
  -PrimaryApp doc-automation-func `
  -SecondaryApp doc-automation-func-eastus `
  -PrimaryResourceGroup doc-automation-rg `
  -SecondaryResourceGroup doc-automation-rg-eastus `
  -CheckExternal -RetrieveLogs
```

### Option 3: Custom Configuration
```powershell
# Use different regions
.\deploy-multiregion.ps1 -PrimaryRegion westus -SecondaryRegion northeurope

# Skip deployment (already deployed)
.\deploy-multiregion.ps1 -SkipDeploy

# Skip expensive tests
.\deploy-multiregion.ps1 -SkipTests

# Run fewer test iterations
.\test-validateadp-regional.ps1 -Primary ... -Secondary ... -Iterations 3
```

## Understanding Results

### Scenario 1: Both Regions Healthy
```
✓ PRIMARY:   200 OK | 45ms avg | 10/10 success
✓ SECONDARY: 200 OK | 48ms avg | 10/10 success
```
**Conclusion**: No regional issue. Issue is application-wide, data-specific, or user-specific.
**Action**: Look at user data, timing patterns, external service availability.

### Scenario 2: Secondary Region Down
```
✓ PRIMARY:   200 OK | 45ms avg | 10/10 success
✗ SECONDARY: Connection timeout | 0/10 success
```
**Conclusion**: Regional infrastructure issue in eastus.
**Action**: 
- Check Azure portal for deployment status
- Verify function app exists: `az functionapp show -n doc-automation-func-eastus -g doc-automation-rg-eastus`
- Check WARP firewall rules for eastus
- Review network topology

### Scenario 3: Secondary Much Slower
```
✓ PRIMARY:   200 OK | 45ms avg | 10/10 success
✓ SECONDARY: 200 OK | 300ms avg | 10/10 success
```
**Conclusion**: Performance degradation in secondary region (cold start, geography, SKU).
**Action**:
- Warm up secondary deployment (run several requests)
- Check if SKU is identical in both regions
- Review dependency latency by region
- Consider enabling Premium tier for consistent performance

### Scenario 4: Authentication Failure
```
✓ PRIMARY:   200 OK | 45ms avg | 10/10 success
✗ SECONDARY: 401 Unauthorized | 0/10 success
```
**Conclusion**: Configuration/authentication issue in secondary region.
**Action**:
- Verify app settings replicated: `az functionapp config appsettings list -n doc-automation-func-eastus -g doc-automation-rg-eastus`
- Check Key Vault access from secondary region
- Verify managed identity is configured in eastus
- Check if secrets exist in Key Vault for both regions

## Diagnostics Included

### 1. Deployment Verification
- ✓ Function app exists in both regions
- ✓ Consumption plan allocated correctly
- ✓ Storage account created and accessible
- ✓ Health endpoint responding

### 2. Configuration Comparison
- ✓ App Settings count (should be equal)
- ✓ Required settings present (ADOBE_*, MONDAY_*, STORAGE_*)
- ✓ Environment consistency
- ✓ Runtime version matching

### 3. Application Logs
- ✓ Recent error entries
- ✓ ValidateADP specific logs
- ✓ Exception patterns
- ✓ Performance metrics

### 4. External Dependencies
- ✓ Monday.com API reachability
- ✓ Adobe Sign API reachability
- ✓ Azure Storage account access
- ✓ Key Vault secret retrieval

## Common Issues & Solutions

### Issue: WARP SSL Certificate Error
**Symptom**: All Azure CLI commands fail with SSL error
**Solution**: Run diagnostics from command line; HTML report will show results from working region

### Issue: Secondary Deployment Failed
**Symptom**: "Function app not found" in secondary region
**Solution**: 
```powershell
# Retry deployment
.\deploy-multiregion.ps1 -SecondaryRegion eastus

# Or clean up and retry
az group delete -n doc-automation-rg-eastus --yes
.\deploy-multiregion.ps1 -SecondaryRegion eastus
```

### Issue: Tests Run Against Undefined Endpoints
**Symptom**: "Could not resolve host" errors
**Solution**: Verify endpoints are correct and apps are running
```powershell
# Check if apps exist
az functionapp list --query "[?contains(name, 'doc-automation')].{name:name, location:location}"

# Check if they're running
az functionapp show -n doc-automation-func -g doc-automation-rg --query "state"
```

### Issue: Slow Secondary Region
**Symptom**: Secondary consistently 10x slower than primary
**Solution**: 
```powershell
# Warm up the secondary (first call is always slow)
$payload = '{"email":"warmup@test.com","firstName":"Warmup","lastName":"Test"}'
$url = "https://doc-automation-func-eastus.azurewebsites.net/api/validateADP"
for ($i=1; $i -le 10; $i++) {
  Invoke-WebRequest -Uri $url -Method POST -Body $payload -ContentType "application/json" | Out-Null
  Start-Sleep -Seconds 2
}

# Re-run tests
.\test-validateadp-regional.ps1 -Primary ... -Secondary ... -Iterations 5
```

## Advanced Usage

### Custom Dependency Testing
```powershell
# Test specific Monday.com API call from both regions
# Can only be done by running from within each function app container

# From Primary: 
# ssh into doc-automation-func via Kudu
# curl -H "Authorization: Bearer $MONDAY_API_TOKEN" https://api.monday.com/graphql

# From Secondary:
# ssh into doc-automation-func-eastus via Kudu
# curl -H "Authorization: Bearer $MONDAY_API_TOKEN" https://api.monday.com/graphql
```

### Monitoring Template
```powershell
# Set up continuous monitoring
while ($true) {
    .\test-validateadp-regional.ps1 `
      -Primary https://doc-automation-func.azurewebsites.net `
      -Secondary https://doc-automation-func-eastus.azurewebsites.net `
      -Iterations 1
    
    Start-Sleep -Seconds 300  # Run every 5 minutes
}
```

### JSON Report Export (for automated processing)
```powershell
# Modify test-validateadp-regional.ps1 to export JSON
# Add at end: $results | ConvertTo-Json | Out-File results.json
```

## Cleanup

```powershell
# Delete secondary region (if not needed for failover)
az group delete -n doc-automation-rg-eastus --yes

# Keep secondary if:
# - Regional issue was found
# - You want load balancing / failover capability
# - You're setting up geographically distributed deployment

# Keep logs for future comparison
# Reports are in: C:\Users\Franky.Lopez\docflow\regional-diagnosis-reports\
```

## Files Reference

| File | Purpose | Run Time |
|---|---|---|
| `run-full-regional-diagnosis.ps1` | End-to-end automated workflow | 5-10 min |
| `deploy-multiregion.ps1` | Deploy to primary & secondary | 3-5 min |
| `test-validateadp-regional.ps1` | Comparative testing | 1-2 min |
| `diagnose-regional-issue.ps1` | Deep diagnostic analysis | 2-3 min |
| `REGIONAL_DIAGNOSIS_GUIDE.md` | Detailed explanation & patterns | Reference |
| `REGIONAL_TESTING_README.md` | This file | Reference |

## Report Output

All runs generate reports in:
```
C:\Users\Franky.Lopez\docflow\regional-diagnosis-reports\
  ├── diagnosis-20260813-143022.html    # Interactive HTML report
  └── diagnosis-20260813-143022.txt     # Text summary
```

## FAQ

**Q: Do I need to buy extra Azure resources?**
A: Temporary - secondary region uses Consumption plan (pay-as-you-go). Delete after testing.

**Q: How long does full diagnosis take?**
A: 5-10 minutes including deployments and tests.

**Q: Can I run this from WARP?**
A: Yes, CLI may fail on some commands, but tests work because they use HTTP endpoints not Azure CLI.

**Q: What if primary region itself is failing?**
A: Still valuable - comparison shows both regions failing, indicating it's application-wide not regional.

**Q: Should I keep secondary deployment?**
A: Yes if: regional issue found, want redundancy, need failover. No if: issue is non-regional, cost concern.

## Support

For detailed issues:
1. Check `REGIONAL_DIAGNOSIS_GUIDE.md` for pattern matching
2. Review generated HTML report for specific failures
3. Run `diagnose-regional-issue.ps1` with `-Verbose` flag for more details
4. Check Application Insights logs in Azure portal
5. Review Kudu logs: `https://[app-name].scm.azurewebsites.net/api/logs/web`
