# DocFlow ↔ SharePoint Integration

## Overview

The SharePoint integration enables automatic upload of fully-signed PDFs to SharePoint Online after Adobe Sign completion. Documents are organized in a folder hierarchy by year/month/docType with full metadata tagging.

### Architecture

```
Adobe Sign (Signed PDF)
    ↓
archiveToBlob (Azure Blob Storage)
    ↓
[Queue: sharepoint-upload-queue]
    ↓
uploadToSharePoint (Azure Function)
    ↓
SharePoint Online (Microsoft Graph API)
    ↓
[Update Monday Onboarding row with link]
```

## Configuration

### Required Environment Variables

Add these to your Azure Function App Settings or `.env`:

```env
# SharePoint tenant & site info
SHAREPOINT_TENANT_ID=12345678-1234-1234-1234-123456789012
SHAREPOINT_SITE_ID=medwatchers.sharepoint.com,site-uuid,web-uuid
SHAREPOINT_DRIVE_ID=b!XXXXX...=
SHAREPOINT_SITE_URL=https://medwatchers.sharepoint.com/sites/Onboarding

# Authentication: OAuth 2.0 client credentials (app registration)
SHAREPOINT_CLIENT_ID=12345678-1234-1234-1234-123456789012
SHAREPOINT_CLIENT_SECRET=xxxxx~xxxxxxxxxxxxxxxxxxxxxxxx

# Enable the integration
SHAREPOINT_ENABLED=true
```

### Optional: Monday.com Column Mapping

```env
# Add this to config.json columns section (if not using default)
MONDAY_COL_SHAREPOINT_LINK=link_sharepoint
```

### Getting SharePoint Configuration Values

#### 1. Tenant ID
```bash
# From Azure AD
az account show --query tenantId -o tsv

# Or from Microsoft Graph
curl -H "Authorization: Bearer <token>" \
  https://graph.microsoft.com/v1.0/organization \
  | jq '.value[0].id'
```

#### 2. Site ID
```bash
# Via PowerShell (requires SP admin)
$site = Get-PnPTenantSite -Url "https://medwatchers.sharepoint.com/sites/Onboarding"
$site.Id  # Site collection ID

# Via Microsoft Graph
curl -H "Authorization: Bearer <token>" \
  'https://graph.microsoft.com/v1.0/sites/medwatchers.sharepoint.com:/sites/Onboarding' \
  | jq '.id'
```

#### 3. Drive ID
```bash
# Via Microsoft Graph (requires Site.Read.All permission)
curl -H "Authorization: Bearer <token>" \
  'https://graph.microsoft.com/v1.0/sites/{siteId}/drives' \
  | jq '.value[0].id'  # First (default) document library
```

#### 4. Create App Registration
```bash
# In Azure Portal > App registrations > New registration
# Name: DocFlow SharePoint Integration
# Redirect URI: (leave empty for daemon)

# Grant API permissions:
# - Sites.ReadWrite.All (or Sites.Selected for granular)
# - User.Read.All (optional, for metadata)

# Create client secret:
# - Certificates & secrets > New client secret
# - Duration: 24 months
# - Copy Value (not ID)
```

## API Reference

### Microsoft Graph Endpoints

#### Upload PDF to SharePoint

```javascript
// PUT /drives/{driveId}/items/{folderId}:/{fileName}:/content
const response = await axios.put(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${fileName}:/content`,
  pdfBuffer,
  {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf',
    },
  }
);
// Response: { id, name, webUrl, size, ... }
```

**Error Handling:**
- `401 Unauthorized` → Token expired/invalid; call `getAccessToken()` again
- `403 Forbidden` → Insufficient permissions (check app role)
- `404 Not Found` → Folder doesn't exist; call `ensureFolderPath()`
- `409 Conflict` → File exists; use `@microsoft.graph.conflictBehavior: 'rename'`
- `429 Too Many Requests` → Rate limited; retry after `Retry-After` header (default: 60s)
- `503 Service Unavailable` → Transient; retry with exponential backoff

#### Get or Create Folder

```javascript
// GET /drives/{driveId}/root:/{folderPath}
const response = await axios.get(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${folderPath}`,
  {
    headers: { Authorization: `Bearer ${token}` },
  }
);
// Response: { id, name, folder: {...}, ... }
```

If folder doesn't exist (404), create it:

```javascript
// POST /drives/{driveId}/items/{parentId}/children
const response = await axios.post(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children`,
  {
    name: 'FolderName',
    folder: {},
    '@microsoft.graph.conflictBehavior': 'rename',
  },
  {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }
);
// Response: { id, name, folder: {...}, ... }
```

#### Set Custom Metadata (Properties)

```javascript
// PATCH /drives/{driveId}/items/{itemId}
const response = await axios.patch(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`,
  {
    properties: {
      'docType': 'Onboarding',
      'employeeName': 'John Doe',
      'signedDate': '2026-08-13T18:30:00Z',
      'agreementId': 'agreement-uuid',
    },
  },
  {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }
);
// Response: { id, name, properties: {...}, ... }
```

#### Get File Metadata

```javascript
// GET /drives/{driveId}/items/{itemId}
const response = await axios.get(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`,
  {
    headers: { Authorization: `Bearer ${token}` },
  }
);
// Response: { id, name, size, webUrl, properties: {...}, ... }
```

#### Delete File

```javascript
// DELETE /drives/{driveId}/items/{itemId}
const response = await axios.delete(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`,
  {
    headers: { Authorization: `Bearer ${token}` },
  }
);
// Response: (empty on success, 204 No Content)
```

#### List Files in Folder

```javascript
// GET /drives/{driveId}/root:/{folderPath}:/children
const response = await axios.get(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${folderPath}:/children`,
  {
    headers: { Authorization: `Bearer ${token}` },
  }
);
// Response: { value: [ {...}, {...}, ... ] }
```

### Token Acquisition

#### OAuth 2.0 Client Credentials Flow

```javascript
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token

Content-Type: application/x-www-form-urlencoded
Accept: application/json

client_id={clientId}
&client_secret={clientSecret}
&scope=https://graph.microsoft.com/.default
&grant_type=client_credentials
```

**Response:**
```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3599
}
```

**Errors:**
- `invalid_client` → Client ID/secret mismatch
- `invalid_grant` → Credentials expired
- `AADSTS70001` → App not registered in tenant
- `AADSTS65001` → User hasn't consented to scopes (use `/oauth2/v2.0/authorize` for interactive flow)

## Module API

### `sharepoint.js` Public Functions

```javascript
const sharepoint = require('./lib/sharepoint');

// Get AAD access token (cached for ~1 hour)
const token = await sharepoint.getAccessToken();

// Ensure folder hierarchy exists
const folderId = await sharepoint.ensureFolderPath('Onboarding');

// Upload PDF with metadata
const result = await sharepoint.uploadPDF(
  pdfBuffer,
  {
    fileName: 'employee_123_onboarding_1692014400000.pdf',
    docType: 'Onboarding',
    employeeName: 'John Doe',
    agreementId: 'CBJCHBCAABAAxxxxxx',
    signDate: '2026-08-13T18:30:00Z',
  },
  { retries: 2 }
);
// Returns: { id, name, webUrl, itemId, driveId, bytes }

// Get file info
const fileInfo = await sharepoint.getFileInfo(itemId);

// Delete file
const deleted = await sharepoint.deleteFile(itemId);

// List files in folder
const files = await sharepoint.listFiles('Documents/Onboarding/2026/08');

// Direct Graph API call
const data = await sharepoint.graphRequest(
  'GET',
  `/drives/{driveId}/items/{itemId}`,
  null,
  { retries: 3 }
);
```

## Error Handling

### Retry Strategy

The integration uses exponential backoff (500ms base):

```
Attempt 1: 500ms    (original error)
Attempt 2: 1000ms   (2x backoff)
Attempt 3: 2000ms   (4x backoff)
Attempt 4: 4000ms   (8x backoff)
```

**Retryable Errors:**
- `429 Too Many Requests` → Rate limited (check `Retry-After` header)
- `408 Request Timeout` → Transient connectivity
- `5xx Service Errors` → Temporary backend issue

**Non-Retryable Errors:**
- `400 Bad Request` → Invalid input (fix + redeploy)
- `401 Unauthorized` → Token invalid (rotate client secret)
- `403 Forbidden` → Insufficient permissions (grant app role)
- `404 Not Found` → Resource missing (use `ensureFolderPath()`)

### Common Issues & Resolution

#### "Token acquisition failed: AADSTS65001"
**Cause:** App not registered with required permissions
**Fix:**
1. Go to Azure Portal > App registrations > {app-name}
2. API permissions > Add permission > Microsoft Graph > Sites.ReadWrite.All
3. Grant admin consent

#### "Folder creation failed: 403 Forbidden"
**Cause:** App role not assigned to SharePoint site
**Fix:**
1. SharePoint admin > Settings > Site permissions
2. Add {clientId} with "Edit" permission
3. Or use Microsoft 365 admin > Grant app role > Sites.Selected

#### "Retry exhausted: graph-PUT:/drives/.../content"
**Cause:** File size > 4MB or network latency
**Fix:** Use resumable upload session (delta upload) for large files:
```javascript
// POST /drives/{driveId}/items/{parentId}:/{fileName}:/createUploadSession
const session = await sharepoint.graphRequest('POST', uploadSessionUrl, {
  item: {
    '@microsoft.graph.conflictBehavior': 'rename',
    name: fileName,
  },
});
// Then upload in chunks (Azure SDK handles this)
```

#### "No Monday item found with agreementId"
**Cause:** Agreement signed before onboarding row created
**Fix:** Add manual retry or check Monday → Adobe Sign sync is working

## Monitoring & Logging

All operations log to Azure Application Insights:

```javascript
// Success events
logger.event('sharepoint-upload-complete', {
  itemId: 'uuid',
  fileName: 'file.pdf',
  bytes: 1024,
  docType: 'Onboarding',
  employeeName: 'John Doe',
});

// Warnings (non-blocking failures)
logger.warn('sharepoint-metadata-failed', {
  itemId: 'uuid',
  error: 'PATCH failed',
});

// Errors (blocking failures → DLQ)
logger.error('sharepoint-upload-failed', err, {
  agreementId: 'uuid',
  itemId: 'uuid',
  graphStatus: 503,
  graphData: { error: { ... } },
});
```

### Alerting

Set up Application Insights alerts:

1. **Share Point Upload Failure Rate > 5%** (last 5 min)
   - Action: Page on-call
   - Threshold: > 5 errors

2. **Token Acquisition Failures** (any)
   - Action: Auto-rotate client secret
   - Query: `customEvents | where name == "sharepoint-token-acquire-failed"`

3. **Folder Creation Timeout** (429s)
   - Action: Increase retry base delay
   - Query: `customEvents | where name =~ "retry.*folder.*429"`

## Testing

### Local Setup

```env
# .env.local
SHAREPOINT_TENANT_ID=12345678-1234-1234-1234-123456789012
SHAREPOINT_CLIENT_ID=12345678-1234-1234-1234-123456789012
SHAREPOINT_CLIENT_SECRET=xxxxx~xxxxxxxx
SHAREPOINT_SITE_ID=medwatchers.sharepoint.com,uuid,uuid
SHAREPOINT_DRIVE_ID=b!XXXXX=
SHAREPOINT_ENABLED=true
```

### Unit Test Example

```javascript
const sharepoint = require('../lib/sharepoint');
const config = require('../lib/config');

describe('sharepoint', () => {
  beforeEach(() => {
    sharepoint._resetTokenCache();
    config.reset();
  });

  test('uploadPDF uploads and returns webUrl', async () => {
    const buffer = Buffer.from('PDF content');
    const result = await sharepoint.uploadPDF(buffer, {
      fileName: 'test.pdf',
      docType: 'Test',
      employeeName: 'Test User',
    });

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('webUrl');
    expect(result.name).toBe('test.pdf');
  });

  test('ensureFolderPath creates nested folders', async () => {
    const folderId = await sharepoint.ensureFolderPath('TestDocs');
    expect(folderId).toBeTruthy();
    expect(typeof folderId).toBe('string');
  });
});
```

## Deployment

### 1. Add Dependencies

SharePoint integration requires `axios` (already in `package.json`).

```bash
npm install  # Installs existing deps including axios
```

### 2. Deploy to Azure

```bash
# Using Kudu (recommended)
git push azure main

# Or manual zip upload
func azure functionapp publish doc-automation-func \
  --build remote \
  --zip
```

### 3. Configure App Settings

In Azure Portal > Function App > Configuration:

| Setting | Value |
|---------|-------|
| SHAREPOINT_TENANT_ID | {guid} |
| SHAREPOINT_CLIENT_ID | {guid} |
| SHAREPOINT_CLIENT_SECRET | {secret} |
| SHAREPOINT_SITE_ID | {siteId} |
| SHAREPOINT_DRIVE_ID | {driveId} |
| SHAREPOINT_ENABLED | true |

### 4. Create Queue Storage

In Azure Portal > Storage Account > Queues:

```
+ Create new queue
  Name: sharepoint-upload-queue
  Access level: Inherited from container
```

### 5. Verify Deployment

```bash
# Check function logs
az functionapp log tail --name doc-automation-func --resource-group medwatchers

# Test queue trigger
curl -X POST http://localhost:7071/admin/functions/uploadToSharePoint \
  -H "Content-Type: application/json" \
  -d '{
    "agreementId": "CBJCHBCAABAAxxxxxx",
    "itemId": "123",
    "employeeName": "John Doe"
  }'
```

## Performance Tuning

### Rate Limiting

Microsoft Graph has sliding-window rate limits: **600 requests per minute per tenant** (varies by workload).

**Current retry strategy:**
- Base delay: 500ms
- Backoff: exponential (2x per retry)
- Max retries: 3

**Optimization for high volume:**

```javascript
// In config.js:
docflow: {
  sharepoint: {
    rateLimitPerMin: 300,  // Self-impose 300/min to stay safe
  },
}

// In sharepoint.js:
const limiter = new RateLimiter(300, 60000, 'graph-rate-limit');
await limiter.acquire();
// then make request
```

### Concurrency

The `uploadToSharePoint` function is queue-triggered; Azure Functions scales automatically:

- **Consumption plan:** up to 200 concurrent instances
- **Premium plan:** configurable (default 100)

To avoid rate limiting with high concurrency:
1. Increase retry base delay: `DOCFLOW_RETRY_BASE_MS=1000`
2. Enable App Service auth logging to spot-check tokens
3. Monitor Graph API throttling via Application Insights

## FAQ

**Q: Can I use managed identity instead of client secret?**
A: Yes! Update `sharepoint.js::getAccessToken()`:
```javascript
// Already supports DefaultAzureCredential fallback
// Just omit SHAREPOINT_CLIENT_SECRET; MI handles auth
```

**Q: How do I redirect files to a different site?**
A: Update config:
```env
SHAREPOINT_SITE_ID=medwatchers.sharepoint.com,site2-uuid,web2-uuid
SHAREPOINT_DRIVE_ID=b!XXXXX2=
```

**Q: What if archiveToBlob succeeds but SharePoint upload fails?**
A: Document is in Azure Blob (permanent archive). SharePoint link stays missing. Retry via:
1. Manually in Azure Queue Storage Explorer
2. Auto-replay via DLQ handler (future)
3. Manual re-trigger: `func azure functionapp publish ... --zip && trigger uploadToSharePoint`

**Q: How do I rotate the client secret?**
A: 
1. Create new secret in Azure Portal (keep old one)
2. Update `SHAREPOINT_CLIENT_SECRET` in Function App settings
3. Delete old secret after 24 hours (grace period for in-flight requests)

---

## Related Documentation

- [DocFlow API Specification](./API_SPECIFICATION.md)
- [Azure Functions Storage Queue Binding](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-storage-queue)
- [Microsoft Graph Drive API Reference](https://learn.microsoft.com/en-us/graph/api/resources/drive)
- [OAuth 2.0 Client Credentials Flow](https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-client-creds-grant-flow)
