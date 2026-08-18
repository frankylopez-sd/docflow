# SharePoint Integration - Quick Reference

One-page summary for developers integrating SharePoint into DocFlow.

## What You're Getting

✅ **sharepointClient.js** - High-level API for uploading documents  
✅ **sharePointUploadFunction** - Azure Function for queue-based uploads  
✅ **sharepoint.js** (existing) - Low-level Graph API client  
✅ **Dual archival** - Both Blob Storage AND SharePoint  
✅ **Automatic organization** - Folders by year/month/employee  
✅ **Permissions management** - Grant employee access automatically  
✅ **Monday integration** - Links stored in new `link_sharepoint` column  

## Files Created

| File | Purpose |
|------|---------|
| `src/lib/sharepointClient.js` | High-level SharePoint API |
| `src/functions/sharePointUploadFunction/index.js` | Queue-triggered upload function |
| `src/functions/sharePointUploadFunction/function.json` | Function binding config |
| `SHAREPOINT_INTEGRATION_COMPLETE.md` | Full documentation |
| `SHAREPOINT_SETUP_GUIDE.md` | Step-by-step setup |
| `SHAREPOINT_INTEGRATION_WITH_WORKFLOW.md` | Workflow integration guide |
| `.env.example` | Updated with SP config vars |

## Quick Setup (5 minutes)

### 1. Create Azure AD App (Azure Portal)

```
Azure Active Directory → App Registrations → New registration
Name: DocFlow SharePoint
Add permissions: Sites.ReadWrite.All, Files.ReadWrite.All, User.ReadWrite.All
Create client secret (copy value)
```

### 2. Find SharePoint IDs (Graph Explorer)

```
GET /sites/medwatchers.sharepoint.com:/sites/HR
→ Copy "id" field (format: tenant,site,web)

GET /sites/{siteId}/drives
→ Copy Documents library "id"
```

### 3. Set Config (Azure Portal Function App)

```
SHAREPOINT_ENABLED=true
SHAREPOINT_TENANT_ID=<from Azure AD>
SHAREPOINT_CLIENT_ID=<from App Reg>
SHAREPOINT_CLIENT_SECRET=<from App Reg secret>
SHAREPOINT_SITE_ID=<from Graph Explorer>
SHAREPOINT_SITE_URL=https://medwatchers.sharepoint.com/sites/HR
SHAREPOINT_DRIVE_ID=<from Graph Explorer>
```

### 4. Add Monday Column

```
Onboarding Board → Add Column
Type: Link
Name: SharePoint Link
Column ID: link_sharepoint
```

### 5. Queue SharePoint Upload

```javascript
// In sendForSign or adobeWebhook:
await queue.enqueue('sharepoint-uploads', {
  agreementId,
  itemId,
  boardId,
  employeeName: `${firstName} ${lastName}`,
  employeeEmail,
  docType,
});
```

## Usage Examples

### Upload Document

```javascript
const client = require('./lib/sharepointClient');

const result = await client.uploadSignedDocument({
  pdfBuffer,
  employeeName: 'John Smith',
  employeeEmail: 'john@company.com',
  docType: 'Offer Letter',
  agreementId: 'CBJCHBCAABACsW7z',
  itemId: '5678901234',
  boardId: '18422046530',
});

// result.webUrl → File URL
// result.folderUrl → Folder shareable link
// result.accessGranted → Did employee get access?
```

### List Employee Documents

```javascript
const client = require('./lib/sharepointClient');

const docs = await client.listEmployeeDocuments('John Smith');
// Returns: [{ name, id, webUrl, size, createdDateTime }, ...]
```

### Get Document Info (with metadata)

```javascript
const client = require('./lib/sharepointClient');

const info = await client.getDocumentInfo(itemId);
// Returns: { name, size, metadata: { docType, employeeName, ... } }
```

## Folder Structure

Automatically created by date:

```
DocFlow/
└── 2026/
    └── 08/
        └── john-smith/
            ├── Offer-Letter_1691234567890.pdf
            ├── NDA_1691234568901.pdf
            └── ...
```

## Queue Messages

### SharePoint Uploads Queue

**Name:** `sharepoint-uploads`

**Message:**
```json
{
  "agreementId": "CBJCHBCAABACsW7z",
  "itemId": "5678901234",
  "boardId": "18422046530",
  "employeeName": "John Smith",
  "employeeEmail": "john@company.com",
  "docType": "Offer Letter"
}
```

## Environment Variables

```env
SHAREPOINT_ENABLED=true                    # Master switch
SHAREPOINT_TENANT_ID=...                  # From Azure AD
SHAREPOINT_CLIENT_ID=...                  # From App Registration
SHAREPOINT_CLIENT_SECRET=...              # From App Registration
SHAREPOINT_SITE_ID=...                    # From Graph Explorer
SHAREPOINT_SITE_URL=https://...           # SharePoint site URL
SHAREPOINT_DRIVE_ID=...                   # From Graph Explorer

MONDAY_COL_SHAREPOINT_LINK=link_sharepoint # Column ID
```

## Metadata Stored

Each file stores custom properties:

```json
{
  "docType": "Offer Letter",
  "employeeName": "John Smith",
  "employeeEmail": "john@company.com",
  "signedDate": "2026-08-17T14:23:45.123Z",
  "agreementId": "CBJCHBCAABACsW7z",
  "uploadSource": "DocFlow"
}
```

## Error Handling

| Error | Action |
|-------|--------|
| 401 (Auth) | Check credentials in App Settings |
| 404 (Site/Drive) | Verify IDs via Graph Explorer |
| 429 (Rate limit) | Auto-retried with backoff |
| 5xx (Server) | Auto-retried, then DLQ |
| Permission grant fails | Logged, non-blocking |
| Monday update fails | Logged, non-blocking |

## Monitoring

### Key Logs

```
sharepoint-upload-start
sharepoint-upload-success
sharepoint-upload-failed
sharepoint-employee-access-granted
sharepoint-metadata-set
```

### Application Insights Query

```kusto
customEvents
| where name startswith 'sharepoint-'
| summarize Count=count() by name, bin(timestamp, 1h)
```

## Testing

### Manual Queue Test

```
Azure Portal → Function App → Storage → Queues
Create message on sharepoint-uploads:
{
  "agreementId": "TEST-001",
  "employeeName": "Test User",
  "employeeEmail": "your-email@company.com",
  "docType": "Test"
}
```

### Check Results

1. **logs:** Application Insights → Logs → `sharepoint*`
2. **SharePoint:** Documents → DocFlow → 2026 → 08 → test-user/
3. **Monday:** New link in `link_sharepoint` column

## Dual Archival (Blob + SharePoint)

Both systems store copies:

| System | Purpose | Access | Retention |
|--------|---------|--------|-----------|
| **Blob Storage** | System archive | SAS URLs | Long-term |
| **SharePoint** | Employee access | Direct folder | Policy-based |

Queue both:

```javascript
await Promise.allSettled([
  queue.enqueue('blob-archive', blobMsg),
  queue.enqueue('sharepoint-uploads', spMsg),
]);
```

## Troubleshooting

### "401 Unauthorized"
→ Check SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET in App Settings

### "404 Not Found"
→ Verify SHAREPOINT_SITE_ID, SHAREPOINT_DRIVE_ID via Graph Explorer

### Folder Not Created
→ Check /DocFlow exists in SharePoint, verify permissions

### Employee Can't Access
→ Verify employee email exists in Azure AD, check access logs

### SharePoint Link Not in Monday
→ Check monday.updateStatus() call in sharePointUploadFunction

## API Reference

### uploadSignedDocument(options)

```javascript
await client.uploadSignedDocument({
  pdfBuffer: Buffer,           // Required: PDF content
  employeeName: string,        // Required: Employee name
  employeeEmail?: string,      // Optional: Grant access
  docType?: string,            // Default: 'Document'
  agreementId?: string,        // For tracking
  itemId?: string,             // Monday item ID
  boardId?: string,            // Monday board ID
  fileName?: string,           // Override filename
})
```

Returns:
```javascript
{
  success: true,
  itemId: string,              // SharePoint item ID
  webUrl: string,              // File URL
  folderUrl: string,           // Folder shareable link
  accessGranted: boolean,      // Permission granted?
  bytes: number,
  metadata: Object,
}
```

### Other Functions

```javascript
await client.grantEmployeeAccess(itemId, email)
await client.listEmployeeDocuments(employeeName)
await client.deleteDocument(itemId)
await client.getDocumentInfo(itemId)
await client.createShareableLink(itemId)
await client.createMondayShortcut(itemId, mondayId, boardId)
```

## Cost Estimate

At typical scale (100 docs/month, 1MB each):

| Component | Cost |
|-----------|------|
| Graph API calls | Free (included in M365) |
| SharePoint storage | Minimal (1TB included) |
| Azure Function | <$1/month |
| Total | < $5/month |

## Performance

- Token cache: 1 hour
- Typical upload time: 2-5 seconds
- Folder creation: Lazy (on first doc)
- Permissions: Async (non-blocking)

## Security

✅ OAuth2 (app-only, no user login)  
✅ Application permissions (not delegated)  
✅ Read-only access for employees  
✅ Organization-scoped links (not public)  
✅ Custom properties (searchable in SharePoint)  
✅ Token cached in memory (1h TTL)  

## Next Steps

1. Read SHAREPOINT_SETUP_GUIDE.md for detailed setup
2. Create Azure AD app registration
3. Find SharePoint IDs via Graph Explorer
4. Set environment variables
5. Deploy sharePointUploadFunction
6. Add Monday column
7. Test with sample document
8. Monitor logs for 24 hours
9. Deploy to production

## Support

- **Setup issues?** → SHAREPOINT_SETUP_GUIDE.md
- **API questions?** → SHAREPOINT_INTEGRATION_COMPLETE.md
- **Workflow integration?** → SHAREPOINT_INTEGRATION_WITH_WORKFLOW.md
- **Troubleshooting?** → Check Application Insights logs
- **Graph API help?** → Graph Explorer + MS Docs
