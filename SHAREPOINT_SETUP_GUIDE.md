# SharePoint Integration Setup Guide

Quick reference for configuring SharePoint Online integration with DocFlow.

## Prerequisites

- Admin access to Azure AD / Office 365 tenant
- SharePoint Online site created (e.g., `/sites/HR`)
- Document library ready (typically "Documents")

## Step 1: Create Azure AD App Registration

### 1.1 Create the App

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure Active Directory → App Registrations**
3. Click **New registration**
4. Fill in:
   - **Name:** `DocFlow SharePoint`
   - **Supported account types:** Single tenant (this organization only)
   - **Redirect URI:** Leave blank (service-to-service, no user login)
5. Click **Register**

### 1.2 Grant API Permissions

1. In the app registration, go to **API Permissions**
2. Click **Add a permission**
3. Select **Microsoft Graph → Application Permissions**
4. Search for and add these permissions:
   - `Sites.ReadWrite.All` (read/write SharePoint sites)
   - `Files.ReadWrite.All` (upload files)
   - `User.ReadWrite.All` (grant access to users)
5. Click **Grant admin consent for [Organization]**

### 1.3 Create Client Secret

1. In the app registration, go to **Certificates & secrets**
2. Click **New client secret**
3. Description: `DocFlow SharePoint Auth`
4. Expires: `24 months`
5. Click **Add**
6. **Copy the Value immediately** (you won't see it again)
7. Store securely in Azure Key Vault or note for Step 4

## Step 2: Find SharePoint IDs

Use [Microsoft Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) to find IDs.

### 2.1 Get Tenant ID

1. In Azure Portal: **Azure Active Directory → Properties**
2. Copy **Tenant ID** (format: `8bee3f3b-9f42-4556-aa53-a526b58f3b29`)

### 2.2 Get Site ID

1. In Graph Explorer, run:
   ```
   GET /sites/medwatchers.sharepoint.com:/sites/HR
   ```
2. Copy the `id` field from response
3. Format: `tenant-id,site-id,web-id`

### 2.3 Get Drive ID

1. In Graph Explorer, run:
   ```
   GET /sites/{siteId}/drives
   ```
   (Substitute the full `id` from above)
2. Look for the **Documents** library (usually first result)
3. Copy its `id` field

**Example Response:**
```json
{
  "value": [
    {
      "id": "b!abc123...xyz789",
      "name": "Documents",
      "webUrl": "https://medwatchers.sharepoint.com/sites/HR/Shared Documents"
    }
  ]
}
```

## Step 3: Get Client ID

1. In the app registration: **Overview**
2. Copy **Application (client) ID** (format: `8bee3f3b-9f42-4556-aa53-a526b58f3b29`)

## Step 4: Configure Azure Function App Settings

### Via Azure Portal

1. Go to **Function App → doc-automation-func**
2. Navigate to **Settings → Configuration**
3. Add these environment variables:

| Key | Value | Source |
|-----|-------|--------|
| `SHAREPOINT_ENABLED` | `true` | Literal |
| `SHAREPOINT_TENANT_ID` | (from Step 2.1) | Azure AD |
| `SHAREPOINT_CLIENT_ID` | (from Step 3) | App Registration |
| `SHAREPOINT_CLIENT_SECRET` | (from Step 1.3) | App Registration secret |
| `SHAREPOINT_SITE_ID` | (from Step 2.2) | Graph Explorer |
| `SHAREPOINT_SITE_URL` | `https://medwatchers.sharepoint.com/sites/HR` | Literal |
| `SHAREPOINT_DRIVE_ID` | (from Step 2.3) | Graph Explorer |

4. Click **Save**
5. Function app will restart automatically

### Via PowerShell (Alternative)

```powershell
$resourceGroup = "doc-automation-rg"
$functionApp = "doc-automation-func"

$settings = @{
    "SHAREPOINT_ENABLED" = "true"
    "SHAREPOINT_TENANT_ID" = "..."
    "SHAREPOINT_CLIENT_ID" = "..."
    "SHAREPOINT_CLIENT_SECRET" = "..."
    "SHAREPOINT_SITE_ID" = "..."
    "SHAREPOINT_SITE_URL" = "https://medwatchers.sharepoint.com/sites/HR"
    "SHAREPOINT_DRIVE_ID" = "..."
}

foreach ($key in $settings.Keys) {
    az functionapp config appsettings set `
        --name $functionApp `
        --resource-group $resourceGroup `
        --settings "$key=$($settings[$key])"
}
```

## Step 5: Test Connection

### Option A: Via Azure Portal (Recommended)

1. In the Function App, go to **Functions → health → Code + Test**
2. Add test endpoint:
   ```javascript
   const sharepointClient = require('./lib/sharepointClient');
   
   module.exports = async function (context) {
     try {
       const token = await require('./lib/sharepoint').getAccessToken();
       context.res = { status: 200, body: 'SharePoint auth OK' };
     } catch (err) {
       context.res = { status: 500, body: err.message };
     }
   };
   ```
3. Run and check response

### Option B: Manual Graph API Test

Using Graph Explorer:

```
GET /drives/{driveId}/root
```

Should return the SharePoint drive root if auth is working.

### Option C: Send Test Document

Queue a message to test the full flow:

```powershell
# Via Azure Storage Explorer
# Create message on `sharepoint-uploads` queue:
{
  "agreementId": "TEST-001",
  "employeeName": "Test User",
  "employeeEmail": "your-email@medwatchers.com",
  "docType": "Test Document"
}
```

Monitor logs in Application Insights for:
```
sharepoint-upload-start
sharepoint-upload-success
```

## Step 6: Verify Folder Creation

1. Go to SharePoint site → **Documents**
2. You should see a **DocFlow** folder created
3. Inside: folders organized by year/month/employee name

Example structure after first upload:
```
Documents/
└── DocFlow/
    └── 2026/
        └── 08/
            └── test-user/
                └── Test-Document_1692273445001.pdf
```

## Step 7: Configure Monday.com Board

Add a new column to store SharePoint link:

1. Open **Onboarding Board**
2. Click **+ Add Column**
3. Choose **Link** type
4. Name: `SharePoint Link`
5. Column ID: `link_sharepoint` (important for code reference)
6. Save

Update Monday config in `.env` / App Settings:

```env
MONDAY_COL_SHAREPOINT_LINK=link_sharepoint
```

## Step 8: Deploy sharePointUploadFunction

1. Ensure the function is in `src/functions/sharePointUploadFunction/`
2. Push to repo (GitHub Actions will auto-deploy)
3. Or manually deploy:

```powershell
# Publish to Azure
func azure functionapp publish doc-automation-func

# Verify function deployed
az functionapp function list --name doc-automation-func \
  --resource-group doc-automation-rg \
  --query "[?name=='sharePointUploadFunction']"
```

## Troubleshooting

### "401 Unauthorized"

**Problem:** Auth token acquisition fails

**Solution:**
- Check `SHAREPOINT_CLIENT_ID` and `SHAREPOINT_CLIENT_SECRET` are correct
- Verify credentials were copied from the right place
- Check App Registrations → Certificates & Secrets (secret might be expired)
- Verify API permissions are granted with **Admin consent**

### "404 Not Found"

**Problem:** Site, drive, or folder not found

**Solution:**
- Re-verify Site ID and Drive ID via Graph Explorer
- Confirm SharePoint site `/sites/HR` actually exists
- Check site URL in SHAREPOINT_SITE_URL matches
- Try GET `/sites/medwatchers.sharepoint.com:/sites/HR` in Graph Explorer

### "Empty value for setting"

**Problem:** Environment variable not set or is blank

**Solution:**
- Check App Settings in Azure Portal
- All SHAREPOINT_* variables must be non-empty
- Look for typos in variable names
- Restart function app after changing settings

### Function Never Completes

**Problem:** Function hangs or times out

**Solution:**
- Check logs in Application Insights
- May be waiting for folder creation
- Increase timeout if network is slow: edit `function.json`
- Check network connectivity from function to SharePoint

## Security Checklist

- [ ] Client secret stored in Azure Key Vault (not in code)
- [ ] App Settings reference Key Vault via `@Microsoft.KeyVault(...)`
- [ ] API permissions are application (not delegated)
- [ ] No public API endpoints expose SharePoint IDs or tokens
- [ ] Access logs monitored in Application Insights
- [ ] Regular rotation of client secret (e.g., every 6 months)
- [ ] Managed Identity considered as alternative to client secret

## Next Steps

1. Test with sample document upload
2. Monitor logs in Application Insights
3. Verify Monday board updated with SharePoint link
4. Check employee can access folder in SharePoint
5. Deploy to production when confident

## Support Resources

- [Microsoft Graph SharePoint API Docs](https://learn.microsoft.com/en-us/graph/api/drive-list-children)
- [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer)
- [Azure AD App Registration Guide](https://learn.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app)
- DocFlow logs: Application Insights → Logs → `sharepoint*` queries
