# SharePoint Integration — Deployment Guide

This guide walks through deploying the DocFlow ↔ SharePoint integration step-by-step.

## Pre-Requisites

- Azure subscription with Function App already deployed (`doc-automation-func`)
- SharePoint Online tenant (medwatchers.sharepoint.com)
- Azure AD Tenant Admin rights or SP admin access
- PowerShell with `PnP.PowerShell` (optional, for getting site IDs)

## Step 1: Create Azure AD App Registration

### 1.1 Create Application

1. Go to **Azure Portal** > **Azure Active Directory** > **App registrations**
2. Click **+ New registration**
3. Fill out form:
   - **Name:** `DocFlow SharePoint Integration`
   - **Supported account types:** `Accounts in this organizational directory only`
   - **Redirect URI:** (leave empty for daemon app)
4. Click **Register**

### 1.2 Note Application IDs

Copy and save:
- **Application (client) ID** → `SHAREPOINT_CLIENT_ID`
- **Directory (tenant) ID** → `SHAREPOINT_TENANT_ID`

### 1.3 Grant API Permissions

1. Go to **API permissions**
2. Click **+ Add a permission**
3. Select **Microsoft Graph**
4. Click **Application permissions**
5. Search for and select:
   - `Files.ReadWrite.All` (for file upload/management)
   - `Sites.ReadWrite.All` (for site/drive access)
6. Click **Add permissions**
7. Click **Grant admin consent for [Tenant]** (requires admin)

### 1.4 Create Client Secret

1. Go to **Certificates & secrets**
2. Click **+ New client secret**
3. Fill out:
   - **Description:** `DocFlow Upload Token`
   - **Expires:** `24 months`
4. Click **Add**
5. **Copy the Value** (not ID) → `SHAREPOINT_CLIENT_SECRET`

⚠️ **Important:** Save the secret immediately — it won't display again!

## Step 2: Get SharePoint Site & Drive IDs

### Option A: Via PowerShell (Recommended)

Install PnP PowerShell:
```powershell
Install-Module PnP.PowerShell -Scope CurrentUser
```

Connect and get IDs:
```powershell
# Connect to SharePoint
$siteUrl = "https://medwatchers.sharepoint.com/sites/Onboarding"
Connect-PnPOnline -Url $siteUrl -Credential (Get-Credential)

# Get site ID
$site = Get-PnPSite
$siteId = $site.Id
Write-Host "Site ID: $siteId"

# Get drive ID (document library)
$drives = Get-PnPGraphList
$driveId = $drives | Where-Object { $_.DisplayName -eq "Documents" } | Select-Object -ExpandProperty DriveId
Write-Host "Drive ID: $driveId"

# Full SharePoint Site ID for Graph API
$graphSiteId = "$($siteUrl.Split('/')[2]),$(($site.Id).ToString()),$(Get-PnPSite | Select-Object -ExpandProperty Id)"
Write-Host "Graph Site ID: $graphSiteId"
```

### Option B: Via Microsoft Graph API

Get a token first:
```bash
# Using client credentials
TOKEN=$(curl -s -X POST \
  https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token \
  -d "client_id={clientId}&client_secret={clientSecret}&scope=https://graph.microsoft.com/.default&grant_type=client_credentials" \
  | jq -r '.access_token')

# Get site ID
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/medwatchers.sharepoint.com:/sites/Onboarding" \
  | jq '.id'

# Get drive ID
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/{siteId}/drives" \
  | jq '.value[0].id'
```

Save:
- **Site ID** (full format) → `SHAREPOINT_SITE_ID`
- **Drive ID** (typically 'b!...') → `SHAREPOINT_DRIVE_ID`
- **Site URL** → `SHAREPOINT_SITE_URL`

## Step 3: Configure Azure Function App

### 3.1 Add App Settings

1. Go to **Azure Portal** > **Function App: doc-automation-func**
2. Go to **Settings** > **Configuration**
3. Click **+ New application setting** for each:

| Setting | Value | Source |
|---------|-------|--------|
| `SHAREPOINT_TENANT_ID` | `{guid}` | Step 1.2 |
| `SHAREPOINT_CLIENT_ID` | `{guid}` | Step 1.2 |
| `SHAREPOINT_CLIENT_SECRET` | `{secret}` | Step 1.4 |
| `SHAREPOINT_SITE_ID` | `medwatchers.sharepoint.com,{site-guid},{web-guid}` | Step 2 |
| `SHAREPOINT_DRIVE_ID` | `b!xxxxx=` | Step 2 |
| `SHAREPOINT_SITE_URL` | `https://medwatchers.sharepoint.com/sites/Onboarding` | Step 2 |
| `SHAREPOINT_ENABLED` | `true` | Manual |

4. Click **Save**

### 3.2 Create Storage Queue

1. Go to **Storage account** (associated with Function App)
2. Go to **Queues**
3. Click **+ Queue**
4. **Name:** `sharepoint-upload-queue`
5. Click **OK**

The Azure Functions runtime automatically detects this queue.

## Step 4: Deploy Code

### 4.1 Update Local Repository

Pull the latest code:
```bash
cd ~/docflow
git pull origin main
```

Or if you're using the bundled files:
```bash
# Files should already be in place:
# - src/lib/sharepoint.js
# - src/functions/uploadToSharePoint/
# - Tests in src/tests/
```

### 4.2 Run Tests Locally

```bash
npm test
# Should pass 50+ tests including SharePoint suite
```

### 4.3 Deploy to Azure

Using Kudu (recommended):
```bash
git push azure main
```

Or using Azure Functions Core Tools:
```bash
func azure functionapp publish doc-automation-func --build remote --zip
```

Monitor deployment:
```bash
az functionapp deployment slot swap \
  --resource-group medwatchers \
  --name doc-automation-func \
  --slot staging
```

## Step 5: Verify Integration

### 5.1 Check Function is Deployed

```bash
az functionapp function show \
  --resource-group medwatchers \
  --name doc-automation-func \
  --function-name uploadToSharePoint
```

Should output function metadata without errors.

### 5.2 Test Token Acquisition

Use the downloadSigned endpoint (requires AAD token):
```bash
# Get a token for your Function App's managed identity
TOKEN=$(az account get-access-token --resource-type msft_graph | jq -r '.accessToken')

# Test the health endpoint
curl -H "Authorization: Bearer $TOKEN" \
  "https://doc-automation-func.azurewebsites.net/api/health"
```

### 5.3 Manual Queue Test

Send a test message to the queue:

```bash
# Using Azure Storage Explorer
# 1. Connect to storage account
# 2. Expand "Queues"
# 3. Right-click "sharepoint-upload-queue" > "Add Message"
# 4. Message body (Base64 encoded):
{
  "agreementId": "CBJCHBCAABAAxxxxxx",
  "itemId": "12345",
  "employeeName": "Test User",
  "docType": "Onboarding"
}
```

Or via CLI:
```bash
STORAGE_ACCOUNT="<name>"
STORAGE_KEY="<key>"
MESSAGE='{"agreementId":"CBJCHBCAABAAxxxxxx","itemId":"12345"}'

az storage message put \
  --account-name "$STORAGE_ACCOUNT" \
  --account-key "$STORAGE_KEY" \
  --queue-name sharepoint-upload-queue \
  --content "$MESSAGE"
```

### 5.4 Check Application Insights

1. Go to **Application Insights** (linked to Function App)
2. Go to **Logs**
3. Run query:
   ```kusto
   customEvents
   | where name startswith "sharepoint"
   | order by timestamp desc
   | limit 100
   ```

Should show:
- `sharepoint-token-acquired`
- `sharepoint-upload-complete` (if test succeeded)
- Any errors in red

## Step 6: Enable Automatic Triggering

The integration is now passive (manual queue testing only). To enable automatic triggering after signing:

### 6.1 Update archiveToBlob Function

Already done in the code, but verify:

```javascript
// In src/functions/archiveToBlob/index.js (around line 125)
if (cfg.sharepoint && cfg.sharepoint.enabled) {
  // Queues sharePointMsg to sharepoint-upload-queue
}
```

### 6.2 Update Monday Column Config (Optional)

If you want to add a "SharePoint Link" column to the onboarding board:

1. Go to Monday.com > Onboarding board
2. Add column: **Name:** "SharePoint Link", **Type:** "Link"
3. Note column ID (e.g., `link_sharepoint`)
4. Update Function App settings:
   ```
   MONDAY_COL_SHAREPOINT_LINK=link_sharepoint
   ```

### 6.3 Test Full Flow

1. Add a new person to the Onboarding board
2. Trigger document signing workflow
3. Once Adobe Sign completes, document should:
   - Auto-upload to SharePoint
   - Link appear in Monday (if column configured)
   - Status change to "Shared to SharePoint"

Monitor via Application Insights:
```kusto
customEvents
| where name == "event:archive-stage-complete"
| project timestamp, message, customDimensions
```

## Troubleshooting

### Token Acquisition Fails (401/403)

**Symptom:** `sharepoint-token-acquire-failed` in logs

**Cause:** Client secret expired or app not registered

**Fix:**
1. Check secret expiration: Azure Portal > App registrations > Certificates & secrets
2. If expired, create new secret (Step 1.4) and update Function App settings
3. Verify app has `Sites.ReadWrite.All` permission (Step 1.3)

### Cannot Access SharePoint Drive (403 Forbidden)

**Symptom:** `graph-PUT:/drives/.../content` returns 403

**Cause:** App not granted access to SharePoint site

**Fix:**
1. Go to SharePoint site > Settings > Site permissions
2. Look for the app (by Client ID)
3. If not listed: SharePoint admin > Grant app role > Sites.Selected
4. Assign app to Onboarding site with "Edit" permission
5. Wait 5 minutes for permission sync

### Folder Creation Fails (404 Not Found)

**Symptom:** Parent folder lookup returns 404

**Cause:** Drive structure doesn't exist

**Fix:**
1. Manually create `Documents` folder in SharePoint
2. Share it with the app (Step 3.1)
3. Retry the upload

### Queue Message Not Processing

**Symptom:** Message sits in queue indefinitely

**Cause:** Function not deployed or disabled

**Fix:**
1. Check function is enabled: `az functionapp function show ...`
2. Check logs: Application Insights > Logs
3. Redeploy: `git push azure main`
4. Restart function: `az functionapp restart ...`

### Memory/Timeout Issues

**Symptom:** Upload timeout after ~5 minutes

**Cause:** Large PDF or slow network

**Fix:**
1. Check PDF size (should be < 100MB)
2. Increase Function timeout: Function App > Configuration > Function timeout = 10 minutes
3. Enable App Service scaling (Premium plan)

## Monitoring & Alerting

### Set Up Alert: Upload Failure Rate

1. Application Insights > Alerts > New alert rule
2. **Condition:**
   ```
   custom events
   | where name == "upload-to-sharepoint-failed"
   | summarize FailureCount = count() by bin(timestamp, 5m)
   | where FailureCount > 5
   ```
3. **Action:** Email/SMS/PagerDuty

### Dashboard: SharePoint Uploads

Create a custom dashboard:

```kusto
// Uploads per day
customEvents
| where name == "event:sharepoint-upload-complete"
| summarize Count = count() by bin(timestamp, 1d)
| render timechart

// Average upload size
customEvents
| where name == "event:sharepoint-upload-complete"
| extend Size = todouble(customDimensions.bytes)
| summarize AvgSize = avg(Size), MaxSize = max(Size)

// Top document types
customEvents
| where name == "event:sharepoint-upload-complete"
| extend DocType = customDimensions.docType
| summarize Count = count() by DocType
| render barchart
```

## Performance Tuning

### For High Volume (100+ docs/day)

1. **Function App Scaling:**
   - Switch to **Premium** plan (Auto-scale enabled)
   - Set minimum: 5 instances
   - Set maximum: 20 instances

2. **Timeout Settings:**
   - Go to Function App > Configuration
   - Set "functionTimeout" to "00:10:00" (10 minutes)

3. **Queue Batch Size:**
   - Storage account > Queues > Properties
   - Set batch size to 32 (default)

4. **Disable App Insights for High-Frequency Events:**
   - Only log errors/warnings, not every "upload-complete"

### Token Caching

The integration caches tokens for ~1 hour, reducing token acquisition overhead. Monitor cache hits:

```kusto
customEvents
| where name startswith "sharepoint-token"
| summarize
    Acquired = count(name == "event:sharepoint-token-acquired"),
    CacheHits = count(name =~ "upload.*complete") - count(name == "event:sharepoint-token-acquired")
```

## Rollback Procedure

If integration causes issues:

1. **Disable in Function App:**
   ```
   SHAREPOINT_ENABLED=false
   ```

2. **Clear Queue:**
   ```bash
   az storage message clear \
     --account-name <account> \
     --account-key <key> \
     --queue-name sharepoint-upload-queue
   ```

3. **Restore Previous Deploy:**
   ```bash
   git revert HEAD~1
   git push azure main
   ```

## Support & Escalation

### Check Status Page
https://status.microsoft.com/ (Microsoft 365 status)

### Common SharePoint Outages
- Maintenance windows: typically off-peak (UTC)
- Check status in Teams: `Microsoft Status` app

### Graph API Rate Limits
- **Tenant-wide:** 600 requests/min
- **Per-user:** 2000 requests/hour
- Check current limits: Azure Portal > Microsoft Graph > Quota

### Contact Support
- **SharePoint:** Microsoft 365 admin center > Support
- **Azure Functions:** Azure Portal > Support + troubleshooting
- **Internal:** Slack #engineering

---

**Document Version:** 1.0  
**Last Updated:** August 2026  
**Status:** ✅ Production Ready
