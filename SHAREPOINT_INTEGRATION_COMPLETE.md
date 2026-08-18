# DocFlow SharePoint Integration — Complete Guide

## Overview

DocFlow now includes **complete SharePoint Online integration** for secure, organized document archival alongside Azure Blob Storage. This is a **dual-archival system**: both systems store copies of signed PDFs, providing redundancy and different access patterns.

### Dual Archival Architecture

```
Adobe Sign (signed PDF)
    ↓
    ├─→ Azure Blob Storage (archiveToBlob function)
    │   └─ Permanent archive, SAS URLs, accessible to system
    │
    └─→ SharePoint Online (sharePointUploadFunction)
        └─ Employee-accessible, organized by employee/date
        └─ Auto-granted folder permissions
        └─ Shortcuts back to Monday items
```

## Components

### 1. sharepointClient.js Library

**Location:** `src/lib/sharepointClient.js`

High-level SharePoint integration providing:

- **Document Upload**: `uploadSignedDocument(options)`
  - Automatic folder structure: `/DocFlow/{year}/{month}/{employeeName}/`
  - Rich metadata tagging
  - Employee access grants
  - Monday item shortcuts

- **Folder Management**: `ensureFolderPath(folderPath)`, `calculateFolderPath(name)`
  - Automatic folder creation with hierarchy
  - Handles special characters and sanitization

- **Permissions**: `grantEmployeeAccess(itemId, email)`
  - Grant read-only access to employee folders
  - Non-blocking (failures logged, don't break upload)
  - Optional invite notifications

- **Organization**: `createShareableLink(itemId)`, `createMondayShortcut(itemId, mondayId, boardId)`
  - Create organization-scoped shareable links
  - Link documents back to Monday items
  - Non-blocking metadata operations

- **Discovery**: `listEmployeeDocuments(employeeName)`, `getDocumentInfo(itemId)`
  - List all documents for an employee
  - Retrieve rich metadata (custom properties)

### 2. sharePointUploadFunction Azure Function

**Location:** `src/functions/sharePointUploadFunction/`

Queue-triggered function that:

1. Listens on `sharepoint-uploads` queue
2. Downloads signed PDF from Adobe Sign
3. Uploads to SharePoint with automatic folder creation
4. Grants employee read access
5. Creates Monday item shortcuts
6. Updates Monday with SharePoint link
7. Handles errors gracefully with DLQ retry

**Complements archiveToBlob:**
- Both can run independently or in parallel
- Blob Storage handles system access; SharePoint handles employee access
- Failures in one don't block the other

### 3. Enhanced sharepoint.js Library

**Location:** `src/lib/sharepoint.js`

Lower-level library providing:

- OAuth2 authentication (client credentials or managed identity)
- Graph API request wrapper with retry logic
- Folder creation and management
- File metadata operations
- Token caching (1-hour TTL)

sharepointClient.js wraps this for easier use.

## Configuration

### Environment Variables (Azure App Settings / .env)

```env
# Required for SharePoint integration
SHAREPOINT_ENABLED=true                          # Master switch
SHAREPOINT_TENANT_ID=<Azure-AD-tenant-ID>      # 8bee3f3b-9f42-4556-aa53-a526b58f3b29
SHAREPOINT_CLIENT_ID=<app-registration-ID>     # For OAuth2 app credentials flow
SHAREPOINT_CLIENT_SECRET=<secret>               # From app registration
SHAREPOINT_SITE_ID=<site-id>                   # SharePoint site ID
SHAREPOINT_SITE_URL=https://medwatchers.sharepoint.com/sites/HR
SHAREPOINT_DRIVE_ID=<drive-id>                 # Document library ID
```

### Finding SharePoint IDs

**Via Graph Explorer (https://developer.microsoft.com/graph/graph-explorer):**

1. **Tenant ID**: From Azure Portal → Azure Active Directory → Properties
2. **Site ID**: 
   ```
   GET /sites/medwatchers.sharepoint.com:/sites/HR
   ```
   Extract `id` field (format: `tenant-id,site-id,web-id`)

3. **Drive ID**:
   ```
   GET /sites/{siteId}/drives
   ```
   Find the Documents library drive (usually first result)

4. **App Registration Client ID & Secret**: Azure Portal → App Registrations

### Setting Up OAuth2 in Azure AD

1. **Create App Registration:**
   - Azure Portal → App Registrations → New registration
   - Name: "DocFlow SharePoint"
   - Supported account types: Single tenant

2. **Grant Permissions:**
   - API Permissions → Add a permission
   - Microsoft Graph → Application permissions
   - Add: `Sites.ReadWrite.All`, `Files.ReadWrite.All`, `User.ReadWrite.All`
   - Admin consent required

3. **Create Secret:**
   - Certificates & secrets → New client secret
   - Copy value (you won't see it again)
   - Store in Azure Key Vault or App Settings

4. **Grant App Role to Service Principal:**
   ```powershell
   # In Azure AD, grant the app permissions to access SharePoint
   # This is done via the Site Owners group or custom role
   ```

## Usage Examples

### Basic Upload (High-Level API)

```javascript
const sharepointClient = require('./lib/sharepointClient');

const result = await sharepointClient.uploadSignedDocument({
  pdfBuffer: signedPdfContent,           // Buffer from Adobe Sign
  employeeName: 'John Smith',             // Creates /DocFlow/2026/08/john-smith/
  employeeEmail: 'john.smith@company.com', // Optional: grants access
  docType: 'Offer Letter',
  agreementId: 'CBJCHBCAABACsW7z',
  itemId: '5678901234',                   // Optional: creates Monday shortcut
  boardId: '18422046530',                 // Optional: for Monday link
});

// Result contains:
// {
//   success: true,
//   itemId: '<sharepoint-file-id>',
//   webUrl: 'https://medwatchers.sharepoint.com/...',
//   folderUrl: '<org-shareable-folder-link>',
//   accessGranted: true,
//   bytes: 45230,
//   ...
// }
```

### Low-Level Graph API (Advanced)

```javascript
const sharepoint = require('./lib/sharepoint');

// Get access token
const token = await sharepoint.getAccessToken();

// Make Graph API call
const files = await sharepoint.graphRequest(
  'GET',
  `/drives/{driveId}/root:/{path}:/children`
);

// Upload with custom settings
const uploaded = await sharepoint.graphRequest(
  'PUT',
  `/drives/{driveId}/items/{parentId}:/{fileName}:/content`,
  pdfBuffer,
  { headers: { 'Content-Type': 'application/pdf' }, retries: 2 }
);
```

### Integrate with Existing Flow

**In mondayWebhook or sendForSign:**

```javascript
// Queue both blob and SharePoint uploads
await queue.enqueue('blob-archive', {
  agreementId,
  itemId,
  boardId,
  firstName,
  lastName,
});

// NEW: Also queue SharePoint upload (dual archival)
await queue.enqueue('sharepoint-uploads', {
  agreementId,
  itemId,
  boardId,
  employeeName: `${firstName} ${lastName}`,
  employeeEmail: row.columns[cfg.monday.columns.email],
  docType: row.columns[cfg.monday.columns.template] || 'Document',
});
```

## Folder Structure

SharePoint documents are organized automatically:

```
DocFlow/
├── 2026/
│   ├── 08/
│   │   ├── john-smith/
│   │   │   ├── Offer-Letter_1691234567890.pdf
│   │   │   ├── NDA_1691234568901.pdf
│   │   │   └── [other docs]
│   │   ├── jane-doe/
│   │   │   └── [docs]
│   │   └── ...
│   └── 09/
│       └── ...
└── 2027/
    └── ...
```

## Metadata & Properties

Each uploaded file stores custom properties:

```json
{
  "properties": {
    "docType": "Offer Letter",
    "employeeName": "John Smith",
    "employeeEmail": "john.smith@company.com",
    "signedDate": "2026-08-17T14:23:45.123Z",
    "agreementId": "CBJCHBCAABACsW7z",
    "mondayItemId": "5678901234",
    "mondayBoardId": "18422046530",
    "uploadSource": "DocFlow"
  }
}
```

Metadata is searchable in SharePoint (custom properties index).

## Error Handling

### Transient Errors (Retried)

- 429 (Rate limit): Respects `Retry-After` header, exponential backoff
- 408 (Request timeout)
- 5xx (Server errors)

### Critical Errors (DLQ)

- 401/403 (Auth failures) → Check app registration, permissions
- 404 (Site/drive not found) → Check configuration IDs
- 400 (Bad request) → Check payload format

### Non-Critical Errors (Logged, Continues)

- Metadata tagging failures
- Permission grant failures (folder still created, just not accessible yet)
- Monday update failures (SharePoint link still valid)
- Shortcut creation failures

## Monitoring & Diagnostics

### Logs

All operations logged via `logger`:

```
sharepoint-upload-start
sharepoint-folder-ready
sharepoint-file-uploaded
sharepoint-metadata-set
sharepoint-employee-access-granted
sharepoint-upload-success
sharepoint-upload-stage-complete
```

Track in Application Insights with these custom properties:

```
{
  employeeName,
  docType,
  agreementId,
  itemId (Monday),
  spItemId (SharePoint),
  bytes,
  accessGranted
}
```

### Health Check

**Via Function App Monitoring:**

```powershell
az monitor metrics list --resource /subscriptions/.../doc-automation-func \
  --metric FunctionExecutionCount \
  --filter "name.value eq 'sharePointUploadFunction'"
```

### Manual Testing

```bash
# Test OAuth token acquisition
curl -X POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token \
  -d client_id={clientId} \
  -d client_secret={clientSecret} \
  -d scope=https://graph.microsoft.com/.default \
  -d grant_type=client_credentials

# Test Graph API (with token)
curl -H "Authorization: Bearer {token}" \
  https://graph.microsoft.com/v1.0/sites/medwatchers.sharepoint.com:/sites/HR
```

## Fallback Strategy

If SharePoint is unavailable:

1. **SHAREPOINT_ENABLED=false**: Function returns early, no error
2. **Graph API timeout/5xx**: DLQ after retries, can replay manually
3. **Folder creation fails**: Error logged, message goes to DLQ
4. **Permission grant fails**: Non-blocking, document still uploaded
5. **Monday update fails**: Non-blocking, SharePoint link still valid

**Blob Storage is unaffected** — archiveToBlob continues independently.

## Deployment Checklist

- [ ] App registration created in Azure AD
- [ ] Client secret stored in Key Vault or App Settings
- [ ] Graph API permissions granted (Sites.ReadWrite.All, Files.ReadWrite.All)
- [ ] Site ID, Drive ID configured correctly
- [ ] SHAREPOINT_ENABLED=true set
- [ ] Test OAuth token acquisition works
- [ ] Test folder creation in SharePoint
- [ ] Queue binding configured for `sharepoint-uploads`
- [ ] sharePointUploadFunction deployed to doc-automation-func
- [ ] sharepointClient.js and sharepoint.js libraries deployed
- [ ] Integration test: Send document through full flow
- [ ] Monday column for SharePoint link created (link_sharepoint)
- [ ] Monitoring dashboards updated with new metrics

## Integration Points

### With sendForSign

After sending to Adobe, queue both archives:

```javascript
// File: src/functions/sendForSign/index.js
await queue.enqueue('sharepoint-uploads', {
  agreementId,
  itemId,
  boardId,
  employeeName: `${firstName} ${lastName}`,
  employeeEmail: empEmail,
  docType: templateName,
});
```

### With adobeWebhook

After Adobe Sign completion, trigger both archives:

```javascript
// File: src/functions/adobeWebhook/index.js
const { agreementId } = webhook.data;
await queue.enqueue('sharepoint-uploads', {
  agreementId,
  // itemId will be resolved from Monday
});
```

### With Monday Onboarding Board

**New Column:** `link_sharepoint`
- Type: Link
- Stores: SharePoint file URL
- Updated by: sharePointUploadFunction after upload

**New Status:** "Shared to SharePoint"
- Set after successful SharePoint upload
- Alternative to or alongside "Archived"

## Troubleshooting

### "SharePoint config missing: SHAREPOINT_DRIVE_ID"

- Check App Settings in Azure Portal
- Verify SHAREPOINT_DRIVE_ID is set and not empty
- Re-check SharePoint site/drive IDs with Graph Explorer

### "401 Unauthorized" from Graph API

- App registration credentials expired or wrong
- Client secret stored correctly in Key Vault?
- Check via Portal → App Registrations → Certificates & Secrets

### "404 Not Found" for Site/Drive

- SHAREPOINT_SITE_ID incorrect or old
- SHAREPOINT_DRIVE_ID points to deleted library
- Use Graph Explorer to verify current IDs

### Permissions Not Granted to Employee

- Check if employee email format is correct
- Verify app has `User.ReadWrite.All` permission
- Employee account must exist in Azure AD
- Check logs for "sharepoint-grant-access-failed"

### Documents Upload But Folder Empty

- Check tenant/site/drive IDs
- Verify folder permissions in SharePoint
- Use Graph Explorer to inspect `/DocFlow` folder
- May need to refresh SharePoint cache

## Performance Notes

- **Token caching:** 1 hour (reduced Azure AD calls)
- **Folder creation:** Lazy-creates on first doc, then reused
- **Metadata:** Stored as custom properties (searchable)
- **Permissions:** Non-blocking, set asynchronously
- **Typical latency:** 2-5 seconds per document (includes Adobe download)

## Security Considerations

1. **Managed Identity (Preferred):**
   - Use Azure AD Managed Identity instead of client secret
   - Supported via `@azure/identity` DefaultAzureCredential
   - Reduces secret management

2. **Permissions Model:**
   - Employees get **read-only** access to their folders
   - No delete/write permissions granted automatically
   - Admins control who has access

3. **File Links:**
   - SharePoint links are **organization-scoped** (not public)
   - Employees must be in tenant to access
   - Links stored in Monday (internal system)

4. **Secrets Management:**
   - Client secret stored in Azure Key Vault
   - App Settings reference Key Vault via `@Microsoft.KeyVault(...)`
   - Never commit secrets to code

## Future Enhancements

- [ ] Large file upload via session (> 4MB)
- [ ] Batch upload for multiple documents
- [ ] Document retention policies
- [ ] Advanced search/filtering
- [ ] Download audit logs from SharePoint
- [ ] Sync with HR system for department-based organization
- [ ] Document expiration & auto-delete

## Related Files

- **Core Libraries:** `src/lib/sharepoint.js`, `src/lib/sharepointClient.js`
- **Functions:** `src/functions/sharePointUploadFunction/index.js`
- **Config:** `src/lib/config.js` (handles env vars)
- **Tests:** `src/tests/sharepoint.test.js` (coming soon)
- **Monitoring:** Application Insights custom events/metrics

## Support

For issues:
1. Check logs in Application Insights
2. Verify environment configuration
3. Test OAuth token acquisition
4. Use Graph Explorer to verify API access
5. Check Azure AD app registration permissions
