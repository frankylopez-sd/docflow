# SharePoint Integration - Workflow Integration Guide

How to integrate SharePoint uploads into the existing DocFlow pipeline for dual archival.

## Dual Archival Overview

### Current Flow (Blob Only)

```
Monday Item
   ↓ (webhook)
sendForSign
   ↓ (queues blob-archive)
archiveToBlob (downloads from Adobe, uploads to Blob Storage)
   ↓ (updates Monday with blob link)
Monday: link_signed → Blob SAS URL
```

### New Flow (Blob + SharePoint)

```
Monday Item
   ↓ (webhook)
sendForSign
   ├─ (queues blob-archive)           ├─ (queues sharepoint-uploads)  NEW
   │                                  │
   ↓                                  ↓
archiveToBlob                    sharePointUploadFunction  NEW
   ↓                                  ↓
Blob Storage Archive            SharePoint Online
   ↓                                  ↓
Monday: link_signed              Monday: link_sharepoint  NEW
        (Blob SAS)                    (SharePoint webUrl)
```

**Benefits:**
- Redundant storage (two independent copies)
- Employees can access via SharePoint
- System access via Blob Storage
- Automatic folder organization by date/employee
- Different retention/access policies per system

## Integration Points

### 1. sendForSign Function

**File:** `src/functions/sendForSign/index.js`

Current code enqueues to blob-archive:

```javascript
// Current
await queue.enqueue('blob-archive', {
  boardId,
  itemId,
  agreementId,
  firstName,
  lastName,
});
```

**Add SharePoint queue enqueue:**

```javascript
// Add this ALONGSIDE the existing blob-archive queue
await queue.enqueue('sharepoint-uploads', {
  agreementId,
  itemId,
  boardId,
  employeeName: `${firstName} ${lastName}`,
  employeeEmail: empEmail, // from Monday row
  docType: templateName,   // from Monday row
});
```

**Full example:**

```javascript
// In sendForSign function after Adobe Send succeeds:

const { queue } = require('../../lib/queue');

// Dual archival: both blob and SharePoint
await Promise.allSettled([
  // Primary: Azure Blob Storage
  queue.enqueue('blob-archive', {
    boardId,
    itemId,
    agreementId,
    firstName,
    lastName,
  }),
  
  // Secondary: SharePoint Online (NEW)
  queue.enqueue('sharepoint-uploads', {
    agreementId,
    itemId,
    boardId,
    employeeName: `${firstName} ${lastName}`,
    employeeEmail,
    docType: templateName,
  }),
]);

logger.info('sendForSign-dual-archive-queued', {
  agreementId,
  itemId,
  blobQueued: true,
  sharepointQueued: true,
});
```

**Why `allSettled`?**
- Both queues should enqueue even if one fails
- If Blob queue fails, SharePoint should still try
- Improves resilience

### 2. adobeWebhook Function

**File:** `src/functions/adobeWebhook/index.js`

After Adobe Sign notifies that agreement is complete:

```javascript
// Current
const msg = {
  agreementId,
  itemId,
  boardId,
};

// Add SharePoint queueing
await Promise.allSettled([
  queue.enqueue('blob-archive', msg),
  queue.enqueue('sharepoint-uploads', {
    agreementId,
    // itemId will be resolved from Monday if not provided
    // No need to include firstName/lastName; function finds employee info
  }),
]);
```

### 3. Monday Column Setup

Add a new column to store SharePoint links:

**Column Details:**
- **Type:** Link
- **Title:** SharePoint Link
- **Column ID:** `link_sharepoint` (for config references)

**In config.js:**

```javascript
// File: src/lib/config.js
// Already includes:
sharePointLink: env.MONDAY_COL_SHAREPOINT_LINK || 'link_sharepoint',
```

**In .env / App Settings:**

```env
MONDAY_COL_SHAREPOINT_LINK=link_sharepoint
```

### 4. Optional: Monday Statuses

Create new status values in the onboarding board:

- **Shared to SharePoint** - Set after successful SharePoint upload
- **SharePoint Upload Error** - Set if SharePoint fails
- **Archived** - Set after blob archive succeeds (existing)
- **Archive Error** - Set if blob archive fails (existing)

Both functions (`archiveToBlob` and `sharePointUploadFunction`) update these independently.

## Implementation Pattern

### Pattern 1: Parallel Queueing (Recommended)

Queue both uploads immediately, let them run in parallel:

```javascript
// Fast: both queued together, no dependencies
await Promise.allSettled([
  queue.enqueue('blob-archive', blobMsg),
  queue.enqueue('sharepoint-uploads', spMsg),
]);
```

**Pros:**
- Fastest time-to-completion
- Failures in one don't block the other
- Simpler code

**Cons:**
- Both incur latency if either fails
- Harder to track dependency

### Pattern 2: Sequential (Higher Reliability)

Queue blob first, then SharePoint:

```javascript
// Reliable: blob first, then SP
await queue.enqueue('blob-archive', blobMsg);
try {
  await queue.enqueue('sharepoint-uploads', spMsg);
} catch (spErr) {
  logger.warn('sharepoint-queue-failed', spErr);
  // Continue anyway; blob is queued
}
```

**Pros:**
- Guaranteed blob archive (primary)
- SharePoint is bonus (secondary)

**Cons:**
- Slightly slower (sequential)
- More code

### Pattern 3: Conditional (Advanced)

Only queue SharePoint if SharePoint is enabled:

```javascript
const cfg = config.load();

// Always queue blob
await queue.enqueue('blob-archive', blobMsg);

// Only queue SharePoint if configured
if (cfg.sharepoint.enabled) {
  await queue.enqueue('sharepoint-uploads', spMsg).catch(err => {
    logger.warn('sharepoint-queue-not-sent', err);
  });
}
```

## Queue Messages Reference

### Blob Archive Queue

**Queue name:** `blob-archive`

**Message schema:**
```json
{
  "boardId": "18422046530",
  "itemId": "5678901234",
  "agreementId": "CBJCHBCAABACsW7z",
  "firstName": "John",
  "lastName": "Smith"
}
```

**Processed by:** `archiveToBlob` function

### SharePoint Upload Queue

**Queue name:** `sharepoint-uploads`

**Message schema:**
```json
{
  "agreementId": "CBJCHBCAABACsW7z",
  "itemId": "5678901234",           // Optional: resolved from agreementId if missing
  "boardId": "18422046530",         // Optional: reads from config if missing
  "employeeName": "John Smith",     // Optional: resolved from Monday row if missing
  "employeeEmail": "john@company.com", // Optional: grants access if provided
  "docType": "Offer Letter",        // Optional: "Document" if missing
  "firstName": "John",              // Optional: used to construct employeeName
  "lastName": "Smith"               // Optional: used to construct employeeName
}
```

**Processed by:** `sharePointUploadFunction`

## Update Monday Columns

### Existing Columns

- `link_signed` - Updated by archiveToBlob (blob SAS URL)
- `status` - Updated by both functions

### New Columns (Add to Board)

1. **SharePoint Link** (link_sharepoint)
   - Stores: SharePoint file webUrl
   - Updated by: sharePointUploadFunction
   - Visible to: All board members

2. **SharePoint Folder** (link_sharepoint_folder - optional)
   - Stores: Shareable folder link
   - Updated by: sharePointUploadFunction (optional)
   - Visible to: HR team

3. **Archive Status** (status_archive - optional)
   - Values: Pending, Blob Archived, SharePoint Shared, Error
   - Updated by: Both functions
   - Visible to: HR team

## Error Scenarios & Recovery

### Scenario 1: Blob Succeeds, SharePoint Fails

```
archiveToBlob → Success (link_signed updated)
sharePointUploadFunction → Error (DLQ)
```

**Resolution:**
1. Fix SharePoint config (e.g., credentials)
2. Manually replay message from DLQ
3. Document will then have both links

### Scenario 2: Both Fail

```
Both → Error (both go to DLQ)
```

**Resolution:**
1. Check Application Insights for error type
2. Fix underlying issue (auth, network, config)
3. Manually replay from DLQs
4. Order: Fix blob first (primary), then SharePoint

### Scenario 3: SharePoint Succeeds, Blob Fails

```
archiveToBlob → Error (DLQ)
sharePointUploadFunction → Success (link_sharepoint updated)
```

**Resolution:**
1. SharePoint copy is safe
2. Fix blob issue (storage account, credentials)
3. Replay blob archive message
4. When fixed, link_signed will be populated

## Monitoring & Alerting

### Key Metrics

Track via Application Insights:

```
Custom Events:
- blob-uploaded (archiveToBlob success)
- sharepoint-upload-success (sharePointUploadFunction success)
- blob-archive-error (archiveToBlob failure)
- sharepoint-upload-failed (sharePointUploadFunction failure)

Custom Properties:
- agreementId
- itemId
- employeeName
- docType
- bytes
- duration
```

### Recommended Alerts

1. **archiveToBlob Error Rate > 5%**
   - Action: Check blob storage account
   - Severity: High (primary archive failing)

2. **sharePointUploadFunction Error Rate > 10%**
   - Action: Check SharePoint config, auth
   - Severity: Medium (secondary, can replay)

3. **Combined Success Rate < 80%**
   - Action: Escalate, check both systems
   - Severity: Critical

### Dashboard Query

```kusto
customEvents
| where name in ('blob-uploaded', 'sharepoint-upload-success', 'sharepoint-upload-failed')
| summarize Count=count() by name, bin(timestamp, 1h)
```

## Performance Tuning

### Reduce Azure Storage Cost

- Blob Storage: Keep as archive (lower tier, infrequent access)
- Expected: 100s-1000s of PDFs/month
- Cost: ~$1/month at typical scale

### Reduce SharePoint Quota Usage

- Default: 1TB per tenant
- At 1MB per PDF: 1M documents before quota issue
- Consider retention policy: Delete old documents

### Optimize Function Performance

**archiveToBlob:**
- Currently sequential with Monday updates
- No optimization needed (simple blob upload)

**sharePointUploadFunction:**
- Parallel folder creation + upload
- Async permission grants (non-blocking)
- Already optimized

## Testing

### Local Testing

```javascript
// Test with fake message
const msg = {
  agreementId: 'TEST-AGREEMENT-001',
  employeeName: 'Jane Doe',
  employeeEmail: 'jane.doe@medwatchers.com',
  docType: 'Offer Letter',
};

// Create fake PDF
const fakeBuffer = Buffer.from('PDF content here');

// Test sharepointClient
const result = await require('./src/lib/sharepointClient')
  .uploadSignedDocument({
    pdfBuffer: fakeBuffer,
    employeeName: 'Jane Doe',
    employeeEmail: 'jane.doe@medwatchers.com',
    docType: 'Offer Letter',
    agreementId: 'TEST-001',
  });

console.log('Upload result:', result);
```

### Integration Testing

1. Create test Monday item
2. Send to Adobe
3. Sign document (or use test signing)
4. Verify both queues receive messages
5. Check Application Insights logs
6. Verify both links appear in Monday
7. Verify SharePoint folder created
8. Verify employee can access folder

### Regression Testing

Before deploying:
- [ ] Existing blob archive flow still works
- [ ] Monday updates still work
- [ ] Error cases handled gracefully
- [ ] Logs contain expected events
- [ ] No performance degradation

## Rollback Plan

If SharePoint integration breaks:

1. **Immediate:** Set `SHAREPOINT_ENABLED=false`
   - Functions return early
   - No errors thrown
   - Blob archive continues

2. **Drain queue:** 
   - Let sharepoint-uploads queue empty
   - Or move to DLQ for manual inspection

3. **Fix issue** (auth, config, etc.)

4. **Re-enable:** Set `SHAREPOINT_ENABLED=true`

5. **Replay DLQ messages** (if any)

## Checklist for Deployment

- [ ] sharepointClient.js created in src/lib/
- [ ] sharePointUploadFunction created in src/functions/
- [ ] function.json configured for queue trigger
- [ ] Config vars added (SHAREPOINT_* env vars)
- [ ] Monday columns created (link_sharepoint, etc.)
- [ ] sendForSign updated to queue both
- [ ] adobeWebhook updated to queue both
- [ ] Queue binding configured in function.json
- [ ] Test with sample document
- [ ] Verify logs in Application Insights
- [ ] Verify SharePoint folder structure created
- [ ] Verify Monday updated with both links
- [ ] Monitor error rates for 24 hours
- [ ] Document deployment in CHANGELOG.md

## Next Steps

1. Complete setup guide (SHAREPOINT_SETUP_GUIDE.md)
2. Configure Azure AD app registration
3. Deploy functions and libraries
4. Run integration tests
5. Monitor for 24h
6. Enable in production

## Support

For questions, check:
- SHAREPOINT_INTEGRATION_COMPLETE.md (detailed API)
- SHAREPOINT_SETUP_GUIDE.md (configuration steps)
- Application Insights logs (troubleshooting)
- GraphQL Explorer (SharePoint API testing)
