# DocFlow Health Check - Quick Reference

One-page cheat sheet for the most common health check commands.

## Status & Health Checks

```powershell
# Is it running? (5 seconds)
.\quick-check.ps1

# Full health check (30 seconds)
.\health-check.ps1

# Full health check with details
.\health-check.ps1 -IncludeDetails

# Bash version (Linux/macOS/WSL)
./health-check.sh
./health-check.sh --include-details
```

## Endpoint Testing

```powershell
# Test all endpoints with timing
.\test-endpoints.ps1

# Test with detailed responses
.\test-endpoints.ps1 -ShowDetails

# Test specific endpoint
.\test-endpoints.ps1 -Endpoint "health"
.\test-endpoints.ps1 -Endpoint "validateADP" -ShowDetails

# Test with custom payload
.\test-endpoints.ps1 -Endpoint "validateADP" `
  -Payload '{"employeeId":"EMP-123"}'
```

## Direct Endpoint Testing (curl)

```bash
# Public endpoints (no auth)
curl https://doc-automation-func.azurewebsites.net/api/health

curl -X POST https://doc-automation-func.azurewebsites.net/api/validateADP \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"TEST-001"}'

# Protected endpoints (need function key)
KEY=$(az functionapp keys list --name doc-automation-func \
  --resource-group doc-automation-rg --query "functionKeys.default" -o tsv)

curl -X POST https://doc-automation-func.azurewebsites.net/api/updateMonday \
  -H "x-functions-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"itemId":0,"updates":{}}'
```

## Azure CLI Commands

```bash
# Function app status
az functionapp show --name doc-automation-func \
  --resource-group doc-automation-rg --query "state" -o tsv

# List app settings
az functionapp config appsettings list --name doc-automation-func \
  --resource-group doc-automation-rg

# Get function key
az functionapp keys list --name doc-automation-func \
  --resource-group doc-automation-rg --query "functionKeys.default" -o tsv

# View logs
az functionapp log download --name doc-automation-func \
  --resource-group doc-automation-rg

# Restart app
az functionapp restart --name doc-automation-func \
  --resource-group doc-automation-rg

# Check queue
az storage queue exists --name "docflow-generate" --auth-mode login

# View queue depth
az storage queue metadata show --name "docflow-generate" --auth-mode login
```

## Monitoring & Logs

```bash
# Real-time log stream
az functionapp log tail --name doc-automation-func \
  --resource-group doc-automation-rg

# Application Insights - Recent errors
az monitor app-insights query --resource-group doc-automation-rg \
  --app docflow-ai \
  --analytics-query "traces | where severityLevel >= 2 | top 20 by timestamp desc"

# Application Insights - Function invocations
az monitor app-insights query --resource-group doc-automation-rg \
  --app docflow-ai \
  --analytics-query "requests | where name == 'health' | top 20 by timestamp desc"
```

## Quick Troubleshooting

| Problem | Command |
|---------|---------|
| App is down | `az functionapp restart --name doc-automation-func --resource-group doc-automation-rg` |
| Endpoint returns 401 | `az functionapp keys list --name doc-automation-func --resource-group doc-automation-rg` |
| Queue not accessible | `az role assignment list --assignee <func-app-id> --scope <storage-scope>` |
| Check recent errors | `az functionapp log tail --name doc-automation-func --resource-group doc-automation-rg` |
| Settings missing | `az functionapp config appsettings list --name doc-automation-func --resource-group doc-automation-rg` |

## Endpoints Summary

| Endpoint | Auth | Method | Purpose |
|----------|------|--------|---------|
| `/api/health` | None | GET | Health check |
| `/api/validateADP` | None | POST | Validate ADP data |
| `/api/mondayWebhook` | None | POST | Monday webhook |
| `/api/adobeWebhook` | None | GET/POST | Adobe webhook |
| `/api/downloadSigned/{id}` | Function Key | GET | Download PDF |
| `/api/updateMonday` | Function Key | POST | Update Monday |
| `/api/createADPUser` | Function Key | POST | Create ADP user |

## Functions Overview

**HTTP-Triggered**: 7 (testable via endpoint)
- health, validateADP, mondayWebhook, adobeWebhook, downloadSigned, updateMonday, createADPUser

**Queue-Triggered**: 3 (automatic processing)
- generatePDF (docflow-generate queue)
- sendForSign (docflow-sign queue)
- archiveToBlob (docflow-archive queue)

**Timer-Triggered**: 2 (scheduled)
- signPoller (every 30 minutes)
- cleanup (daily at 11:30 PM)

## Expected Results

**HEALTHY**
```
[PASS] GET /api/health
[PASS] POST /api/validateADP
[PASS] Queue: docflow-generate
[PASS] Key Vault is accessible
Passed:  25, Failed: 0, Warnings: 0
Overall Status: HEALTHY
```

**DEGRADED**
```
[PASS] GET /api/health
[WARN] Key Vault access failed
Passed:  24, Failed: 0, Warnings: 1
Overall Status: DEGRADED (action recommended)
```

**UNHEALTHY**
```
[FAIL] GET /api/health (HTTP 502)
[FAIL] POST /api/validateADP (HTTP 500)
Passed:  20, Failed: 3, Warnings: 2
Overall Status: UNHEALTHY (immediate action required)
```

## Performance Baselines

| Endpoint | Normal | Slow | Critical |
|----------|--------|------|----------|
| health | 200ms | >1s | >5s |
| validateADP | 300ms | >2s | >5s |
| mondayWebhook | 500ms | >5s | >10s |
| downloadSigned | 1000ms | >5s | >10s |

## Exit Codes

```
0 = HEALTHY (all checks pass)
1 = DEGRADED (some checks fail)
2 = UNHEALTHY (critical failures)
```

## Environment Variables

```bash
# Set defaults
export FUNCTION_APP_NAME="doc-automation-func"
export RESOURCE_GROUP="doc-automation-rg"

# Then run scripts
./health-check.sh
```

## Common Issues & Quick Fixes

**502 Bad Gateway**
```powershell
az functionapp restart --name doc-automation-func --resource-group doc-automation-rg
```

**401 Unauthorized**
```powershell
$key = az functionapp keys list --name doc-automation-func --resource-group doc-automation-rg --query "functionKeys.default" -o tsv
# Use $key in header: x-functions-key: $key
```

**Queue Access Denied**
```powershell
$id = az functionapp identity show --name doc-automation-func --resource-group doc-automation-rg --query "principalId" -o tsv
az role assignment create --role "Storage Queue Data Contributor" --assignee-object-id $id --scope <storage-scope>
```

**Key Vault Access Failed**
```powershell
$id = az functionapp identity show --name doc-automation-func --resource-group doc-automation-rg --query "principalId" -o tsv
az keyvault set-policy --name docflow-kv --object-id $id --secret-permissions get list
```

## Monitoring Schedule

- **Every 5 min** (during deployment): `quick-check.ps1`
- **Every hour** (production): `health-check.ps1`
- **After changes**: `test-endpoints.ps1`
- **Weekly**: Full `health-check.ps1` with `-IncludeDetails`

## CI/CD Integration

### GitHub Actions
```yaml
- name: Health Check
  run: .\scripts\health-check.ps1
```

### Azure DevOps
```yaml
- script: ./scripts/health-check.sh --include-details
  displayName: 'Health Check'
```

## Documentation

- **Full Docs**: `HEALTH_CHECK_README.md`
- **Index**: `../HEALTH_CHECK_INDEX.md`
- **Deployment**: Memory file `docflow_deployment_method.md`

---

**Last Updated**: 2026-08-14 | **Version**: 1.0.0
