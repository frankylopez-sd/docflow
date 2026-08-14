# DocFlow Poison Queue - Quick Start Guide

**For**: Developers implementing DocFlow
**Time**: 15 minutes to understand
**Goal**: Understand how poison queue handles SharePoint failures

---

## The Problem

```
PDF Generated
  ↓
SharePoint Upload Fails
  └─ Why? Network timeout, auth error, site down, etc.
  
Question: What happens to the document?
```

**Without poison queue**: Document lost or stuck
**With poison queue**: Automatic retry + fallback + alert

---

## The Solution (30-Second Version)

```
Try SharePoint (immediate)
  ├─ Success? → Done. ✓
  └─ Failure? → Continue...
  
Store in Blob (immediate fallback)
  └─ Done. PDF is safe. ✓
  
Retry SharePoint (hourly for 24 hours)
  ├─ Success? → Update Monday, remove from queue. ✓
  └─ Still failing after 24hrs?
     ├─ Move PDF to "poison-fallback/"
     ├─ Create ops alert in Monday
     └─ Wait for manual intervention
```

---

## How It Works (3 Files)

### 1. SharePoint Library (`lib/sharepoint.js`)

**Does**: Upload PDFs to SharePoint with auth + retry

```javascript
const { tryUpload } = require('../../lib/sharepoint');

const result = await tryUpload(pdfBuffer, 'document.pdf');
if (result.success) {
  console.log('Uploaded!', result.webUrl);
} else {
  console.log('Failed:', result.error);
  // Will be retried by poison queue handler
}
```

**Key Features**:
- OAuth2 authentication (ClientCredentials flow)
- 2 automatic retries on transient errors
- 30-second timeout
- Returns `{success, uploadId, webUrl}` or `{success: false, error}`

### 2. Archive Function (`functions/archiveToBlob/index.js`)

**Does**: Download signed PDF, attempt upload, handle failures

**Flow**:
```
Download PDF from Adobe
  ↓
Try SharePoint (via sharepoint.js)
  ├─ Success? → Store link in Monday
  ├─ Failure? → Continue
  ↓
Store PDF in Blob (fallback)
  ├─ PDF is now safe ✓
  ├─ Link stored in Monday
  └─ Enqueue poison retry message
```

**Code Changes**:
```javascript
// New imports
const sharepoint = require('../../lib/sharepoint');

// Try SharePoint first
const spResult = await sharepoint.tryUpload(signedPdf, fileName);
if (spResult.success) {
  permanentUrl = spResult.webUrl;
  uploadLocation = 'sharepoint';
} else {
  // SharePoint failed: will retry via poison queue
  uploadLocation = 'blob-fallback';
}

// Always store in blob if SharePoint not used
if (!permanentUrl) {
  const uploaded = await blob.uploadPDF(cfg.storage.archiveContainer, blobKey, signedPdf);
  permanentUrl = blob.blobUrl(cfg.storage.archiveContainer, blobKey);
  
  // Enqueue for retry
  if (uploadLocation === 'blob-fallback') {
    context.bindings.poisonRetryQueue = JSON.stringify({
      agreementId,
      itemId,
      retry_count: 0,
      firstFailedAt: new Date().toISOString(),
    });
  }
}
```

### 3. Poison Queue Handler (`functions/poisonQueueHandler/index.js`)

**Does**: Monitors retry queue, retries SharePoint hourly, handles 24-hour timeout

**Trigger**: Timer every 5 minutes
**Runs**:
1. Scan retry queue
2. For each message:
   - If < 24hrs old: Try SharePoint again
   - If >= 24hrs old: Move to fallback + alert

**Key Functions**:
```javascript
// Check if message has been failing too long
isExpiredPoisonMessage(msg)  // Returns true if > 24hrs

// Calculate backoff (2^retryCount × 60s)
getBackoffMs(retryCount)  // Returns milliseconds

// Process one message
processPoisonMessage(msg, context)  // Returns {action: 'retry'|'resolved'|'fallback'|'failed'}
```

---

## Data Flow: Step by Step

### Step 1: Initial Upload Attempt (archiveToBlob)

```javascript
{
  "agreementId": "AGREE-12345",
  "itemId": "45678",
  "fileName": "45678_Offer_Letter_1725000000.pdf",
  "error": "timeout",
  "retry_count": 0,
  "firstFailedAt": "2026-08-13T10:30:00.000Z"
}
↓ Enqueued to: docflow-archive-retry
```

### Step 2: Handler Reads Queue (poisonQueueHandler - runs every 5 min)

```
Time: 10:35 (5 min after failure)
Message age: 5 minutes (< 24hrs)
Action: Try SharePoint again

Backoff calculation:
  2^0 × 60,000ms = 60s ± 10% (3-4 minutes total wait)
  Actual retry: 10:33-10:35
```

### Step 3a: Retry Succeeds

```javascript
// SharePoint upload succeeds
Result: {success: true, uploadId: 'xyz', webUrl: 'https://...'}
Action: Remove message from queue, update Monday
Status: COMPLETE ✓
```

### Step 3b: Retry Fails (< 24hrs)

```javascript
// SharePoint still down
Result: {success: false, error: 'Connection timeout'}

// Re-enqueue with backoff
{
  ...same message...,
  "retry_count": 1,
  "nextRetryAt": "2026-08-13T11:02:00.000Z"  // 2^1 × 60s = 2 min
}
↓ Back to: docflow-archive-retry
```

### Step 3c: Retry Fails (>= 24hrs)

```
Time: 2026-08-14T10:30 (24hrs later)
Message age: 24 hours (EXPIRED)
Action: Move to fallback

Steps:
1. Download PDF from blob (it's safe there)
2. Move to: poison-fallback/AGREE-12345_1725086400.pdf
3. Create Monday alert: [ALERT] SharePoint Fallback: AGREE-12345
4. Update status: "Poison - Awaiting Manual Upload"
5. Remove from retry queue
```

---

## Configuration Needed

### Local Development

```env
# Add to .env
SHAREPOINT_SITE_URL=https://tenant.sharepoint.com/sites/documents
SHAREPOINT_CLIENT_ID=<from-entra-id>
SHAREPOINT_CLIENT_SECRET=<from-entra-id>
SHAREPOINT_TENANT_ID=<your-tenant-id>
MONDAY_OPS_ALERTS_BOARD_ID=<your-board-id>  # Optional
```

### Azure Production

```
Function App → Configuration → Application Settings

SHAREPOINT_SITE_URL = https://...
SHAREPOINT_CLIENT_ID = @Microsoft.KeyVault(SecretUri=...)
SHAREPOINT_CLIENT_SECRET = @Microsoft.KeyVault(SecretUri=...)
SHAREPOINT_TENANT_ID = <value>
MONDAY_OPS_ALERTS_BOARD_ID = <value>
```

### Create the Retry Queue

```bash
az storage queue create \
  --account-name <storage> \
  --name docflow-archive-retry
```

---

## Testing Locally

### Test 1: Normal SharePoint Upload

```bash
# Run with valid SharePoint credentials
npm test -- poison-queue.test.js
```

### Test 2: Simulate SharePoint Failure

```bash
# Disable SharePoint credentials
unset SHAREPOINT_CLIENT_ID

# Trigger document generation
# Watch logs for: archive-sharepoint-failed-using-blob
# Verify: poisonRetryQueue message created
# Run handler timer manually
```

### Test 3: 24-Hour Expiration

```javascript
// Modify test to set firstFailedAt to 25 hours ago
const msg = {
  agreementId: 'TEST-123',
  firstFailedAt: new Date(Date.now() - 25*3600*1000).toISOString(),
};

// Run processPoisonMessage
// Verify: poison-fallback-stored event
// Verify: Monday alert created
```

---

## Production Monitoring

### Check Queue Depth

```bash
az storage queue metadata show \
  --account-name docflow-storage \
  --name docflow-archive-retry \
  --auth-mode login
```

**Healthy**: 0-2 messages
**Warning**: 2-5 messages
**Alert**: > 5 messages

### Check Logs

**Application Insights**:
```kusto
traces
| where message contains "poison" or message contains "sharepoint"
| order by timestamp desc
| limit 50
```

**Key Events**:
- `archive-sharepoint-failed-using-blob` - Failure happened
- `poison-queue-scan-start` - Handler running
- `poison-sharepoint-retry-success` - Retry worked
- `poison-fallback-stored` - 24-hour timeout hit

### Check Monday Status

1. Onboarding Board → Filter status = "Poison"
2. Click item → View status history
3. Look for "Poison Queue - Retrying" or "Poison - Awaiting Manual"

---

## Troubleshooting

### Queue Keeps Growing

**Likely cause**: SharePoint is down or auth failed

**Check**:
```bash
curl -I https://tenant.sharepoint.com/sites/documents
# Should return 200

# Test auth
curl -X POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token \
  -d "client_id=<id>&client_secret=<secret>&grant_type=client_credentials"
# Should return access_token
```

**Fix**: Restore SharePoint or update credentials, then handler will auto-retry

### Document Stuck > 24hrs

**Likely cause**: SharePoint never came back online

**Check**:
```bash
# Verify blob fallback exists
az storage blob exists \
  --account-name <storage> \
  --container-name pdf-archive \
  --name "poison-fallback/AGREE-12345_*"

# Should return true (blob storage as fallback)
```

**Options**:
1. Wait for SharePoint restoration, manually retry
2. Accept blob as final storage, mark Monday as "Completed"
3. Escalate to SharePoint team

### Handler Not Running

**Check**:
```bash
# Verify function is enabled
az functionapp function show \
  --resource-group <rg> \
  --name <app> \
  --function-name poisonQueueHandler

# Check logs
az functionapp log tail -g <rg> -n <app> --provider "Application Insights"
```

**Fix**: Restart function app or enable timer trigger

---

## Key Takeaways

1. **Immediate**: PDF always stored in blob (safe)
2. **Automatic**: Retries SharePoint hourly for 24 hours
3. **Smart**: Exponential backoff to avoid thundering herd
4. **Fallback**: After 24hrs, stays in blob + ops alert
5. **Observable**: Every action logged, searchable in Monday

---

## Files to Know

| File | Purpose | Edit When |
|------|---------|-----------|
| `lib/sharepoint.js` | SharePoint upload | Changing upload logic |
| `functions/archiveToBlob/index.js` | Main archive | Adding new metadata fields |
| `functions/poisonQueueHandler/index.js` | Retry logic | Changing backoff strategy |
| `POISON_QUEUE_HANDLING.md` | Full reference | Need details |
| `OPS_RUNBOOK_POISON_QUEUE.md` | Operations guide | Ops team troubleshooting |
| `ENV_CONFIG_TEMPLATE.md` | Configuration | Setting up environment |

---

## Next Steps

1. **Setup**: Follow `ENV_CONFIG_TEMPLATE.md` for configuration
2. **Test**: Run `poison-queue.test.js` locally
3. **Deploy**: Deploy poisonQueueHandler function to Azure
4. **Verify**: Check queue is created and handler is running
5. **Train**: Share `OPS_RUNBOOK_POISON_QUEUE.md` with ops team
6. **Monitor**: Set up Application Insights alerts

---

## Questions?

- **How do I change the retry interval?** → Modify `getBackoffMs()` base value in poisonQueueHandler
- **What if I want 48-hour retry instead of 24?** → Change `24 * 3600 * 1000` in `isExpiredPoisonMessage()`
- **Can I manually retry a message?** → Yes, re-enqueue with `az storage queue send`
- **What if SharePoint permissions change mid-retry?** → Auth errors don't retry, fail immediately to alert
- **How many retries happen in 24 hours?** → Approximately 14-16 with exponential backoff

See full documentation in `POISON_QUEUE_HANDLING.md` for comprehensive answers.
