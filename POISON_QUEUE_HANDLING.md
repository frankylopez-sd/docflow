# DocFlow Poison Queue Handling for SharePoint Failures

## Overview

This document describes the comprehensive poison queue handling strategy for DocFlow when SharePoint uploads fail repeatedly. The system implements a 24-hour retry window with exponential backoff, followed by automatic fallback to Azure Blob Storage with operational alerts.

## Architecture

```
PDF Generated
    ↓
[archiveToBlob Function]
    ├─ Try: SharePoint Upload (immediate)
    │   └─ Fails → Enqueue to docflow-archive-retry
    ├─ Fallback: Azure Blob Storage (automatic)
    └─ Success → Update Monday + Archive Board
         ↑
[poisonQueueHandler Timer - Every 5 min]
    └─ Read docflow-archive-retry queue
       ├─ < 24hrs failed: Retry SharePoint (exponential backoff)
       │  └─ Success → Remove from queue
       │  └─ Failure → Re-enqueue with backoff
       └─ >= 24hrs failed: Move to Blob + Create Ops Alert
           └─ Update Monday: "Poison - Awaiting Manual Upload"
```

## Queue Architecture

### Primary Queues
- **docflow-archive**: Main archive processing queue
- **docflow-archive-retry**: Poison queue for failed SharePoint uploads
- **docflow-archive-retry-poison**: Dead-letter queue (auto-created by Azure if retries exhausted)

### Message Flow

1. **Initial Failure** (archiveToBlob)
   ```javascript
   {
     agreementId: "AGREE-12345",
     itemId: "45678",
     boardId: "18422046530",
     fileName: "45678_Offer_Letter_1725000000.pdf",
     tempKey: "45678_Offer_Letter_1725000000.pdf",
     archiveKey: "45678_Offer_Letter_1725000000.pdf",
     error: "Initial SharePoint upload failed",
     retry_count: 0,
     firstFailedAt: "2026-08-13T10:30:00.000Z"
   }
   ```

2. **Retry Attempt** (poisonQueueHandler)
   ```javascript
   {
     ...same message...,
     retry_count: 1,
     nextRetryAt: "2026-08-13T11:02:00.000Z",  // backoff applied
     firstFailedAt: "2026-08-13T10:30:00.000Z"   // original timestamp
   }
   ```

## Retry Strategy

### Exponential Backoff
- Base interval: 60 seconds
- Formula: `2^retryCount * 60s` (capped at 24 hours)
- Jitter: ±10% random variance to avoid thundering herd

### Timeline Example
```
Attempt 1: Immediate (t+0s)
Attempt 2: t + 2m (2^1 * 60s) + jitter
Attempt 3: t + 4m (2^2 * 60s) + jitter
Attempt 4: t + 8m (2^3 * 60s) + jitter
Attempt 5: t + 16m (2^4 * 60s) + jitter
Attempt 6: t + 32m (2^5 * 60s) + jitter
...
After 24 hours: MOVE TO FALLBACK
```

### Total Attempts in 24 Hours
With exponential backoff (60s base), approximately **14-16 retry attempts** before the 24-hour window expires.

## Fallback Strategy (After 24 Hours)

When a message has been retrying for over 24 hours:

### 1. PDF Retrieval
- PDF is downloaded from Azure Blob Storage (stored during initial archive attempt)
- If not in temp container, check archive container
- If retrieval fails → log incident + mark as FAILED_RETRIEVAL

### 2. Move to Permanent Fallback
- PDF stored in blob archive with path: `poison-fallback/{agreementId}_{timestamp}.pdf`
- Blob URL is logged and tracked

### 3. Create Operational Alert
- **Alert Board**: Monday.com ops alerts board (MONDAY_OPS_ALERTS_BOARD_ID)
- **Alert Item Fields**:
  - Name: `[ALERT] SharePoint Fallback: {agreementId}`
  - Status: Active / Critical
  - Description: Detailed error message + blob URL
  - Agreement ID: Link to original document
  - Blob URL: Direct link to fallback storage

### 4. Update Original Row
- Monday.com onboarding row updated with status: `"Poison - Awaiting Manual Upload"`
- Maintains audit trail of all retry attempts

## Implementation Details

### archiveToBlob Function (src/functions/archiveToBlob/index.js)

Changes:
- Imports `sharepoint` library
- Attempts SharePoint upload with `sharepoint.tryUpload()`
- If SharePoint fails:
  - Falls back to blob immediately
  - Enqueues to `docflow-archive-retry` for hourly retry
  - Logs event: `archive-poison-retry-enqueued`
- Tracks upload location: 'sharepoint', 'blob', or 'blob-fallback'

```javascript
const spResult = await sharepoint.tryUpload(signedPdf, fileName);
if (spResult.success) {
  permanentUrl = spResult.webUrl;
  uploadLocation = 'sharepoint';
} else {
  // Will retry via poison queue handler
  uploadLocation = 'blob-fallback';
  // Enqueue for retry
  context.bindings.poisonRetryQueue = JSON.stringify(retryMsg);
}
```

### poisonQueueHandler Function (src/functions/poisonQueueHandler/index.js)

**Trigger**: Timer-based, every 5 minutes (cron: `0 */5 * * * *`)

**Processing Steps**:
1. Scan `docflow-archive-retry` queue
2. For each message:
   - Check age (expired if > 24hrs)
   - If expired: Move to fallback + alert
   - If not expired: Attempt SharePoint retry
   - If retry succeeds: Remove from queue
   - If retry fails: Re-enqueue with backoff

**Queue Bindings**:
```json
{
  "type": "timerTrigger",
  "schedule": "0 */5 * * * *"
}
{
  "type": "queue",
  "direction": "out",
  "name": "retryQueue",
  "queueName": "docflow-archive-retry"
}
```

### SharePoint Library (src/lib/sharepoint.js)

Functions:
- `getAccessToken()`: Obtains Bearer token via ClientCredentials flow
- `uploadPDF(buffer, fileName)`: Uploads to SharePoint with timeout handling
- `tryUpload(buffer, fileName)`: Non-throwing wrapper, returns `{success, uploadId, error}`

Authentication:
- Requires: `SHAREPOINT_CLIENT_ID`, `SHAREPOINT_CLIENT_SECRET`, `SHAREPOINT_TENANT_ID`
- Flow: OAuth2 ClientCredentials → Graph API access token → SharePoint upload
- Timeout: 30 seconds per upload attempt

Retry Logic:
- Max retries: 2 (3 total attempts)
- Retryable errors: 5xx, timeout, connection reset
- Non-retryable: Auth errors, 4xx client errors

## Configuration (Environment Variables)

### Required for SharePoint
```
SHAREPOINT_SITE_URL=https://tenant.sharepoint.com/sites/documents
SHAREPOINT_CLIENT_ID=<app-id>
SHAREPOINT_CLIENT_SECRET=<app-secret>
SHAREPOINT_TENANT_ID=<tenant-id>
```

### Optional
```
MONDAY_OPS_ALERTS_BOARD_ID=<board-id>  # Default: uses archiveBoardId
DOCFLOW_RETRY_BASE_MS=60000            # Default: 60,000ms (backoff base)
```

## Monitoring & Logging

### Log Events

**Success Path**:
- `blob-uploaded`: PDF stored in blob
- `sharepoint-upload-success`: PDF stored in SharePoint
- `archive-stage-complete`: Final archive row created

**Retry Path**:
- `archive-sharepoint-failed-using-blob`: Initial SP failure
- `archive-poison-retry-enqueued`: Message queued for retry
- `poison-queue-scan-start`: Handler timer fired
- `poison-sharepoint-retry-success`: Retry succeeded
- `poison-requeued-for-retry`: Message re-enqueued with backoff

**Fallback Path**:
- `poison-fallback-stored`: PDF moved to blob fallback
- `poison-ops-alert-created`: Ops alert item created
- `poison-queue-{status}` warnings: Monday update attempts

**Error Path**:
- `poison-pdf-retrieval-failed`: PDF not found in blob
- `poison-process-failed`: Handler encountered exception
- `poison-queue-scan-error`: Handler crash

### Metrics to Monitor

| Metric | Alert Threshold | Action |
|--------|-----------------|--------|
| Poison queue depth | > 5 | Investigate SharePoint availability |
| Fallback operations | > 2/hour | Escalate to SharePoint team |
| 24-hour timeout events | > 0 | Manual review required |
| Handler scan failures | Any | Page on-call engineer |

## Manual Resolution

When a document lands in the "Poison - Awaiting Manual Upload" state:

### Option 1: Fix SharePoint & Re-attempt
1. Investigate SharePoint connectivity/auth
2. Fix underlying issue
3. Manually trigger retry:
   ```bash
   az servicebus queue send --queue-name docflow-archive-retry \
     --content '{"agreementId":"...", "retry_count":0, ...}'
   ```
4. Monitor retry via logs

### Option 2: Accept Blob Storage
1. Verify blob URL is accessible
2. Update Monday row status to "Completed"
3. Document reason in Monday notes
4. Close ops alert

### Option 3: Escalate
1. Gather logs (agreementId, timestamps, errors)
2. Open incident with SharePoint team
3. Place document on hold pending resolution

## Testing

### Unit Tests
```javascript
// Test backoff calculation
expect(getBackoffMs(0, 60000)).toBeLessThan(70000);  // ~60s ± 10%
expect(getBackoffMs(5, 60000)).toBeLessThan(2000000); // ~32m ± 10%

// Test expiration detection
const old = {firstFailedAt: new Date(Date.now() - 25*3600*1000)};
expect(isExpiredPoisonMessage(old)).toBe(true);

// Test PDF retrieval fallback
const msg = {agreementId: 'test', tempKey: 'notfound'};
const result = await processPoisonMessage(msg);
expect(result.action).toBe('failed');
```

### Integration Tests
1. **Trigger Failure Path**:
   - Disable SharePoint credentials
   - Generate PDF via Monday trigger
   - Verify retry queue population

2. **Test Retry Loop**:
   - Monitor `docflow-archive-retry` queue
   - Verify exponential backoff
   - Confirm Monday status updates

3. **Test Fallback (24-hour)**:
   - Set `firstFailedAt` to 25 hours ago
   - Run handler manually
   - Verify blob fallback + ops alert

## Disaster Recovery

### Recover Messages from Dead-Letter
If messages reach `docflow-archive-retry-poison` (dead-letter):
```bash
az servicebus queue deadletter receive --queue-name docflow-archive-retry

# Move message back to main retry queue
az servicebus queue send --queue-name docflow-archive-retry \
  --content '<message-body>'
```

### Bulk Retry
To retry all queued messages immediately (bypass backoff):
```bash
# Peek all messages in retry queue
az servicebus queue peek --queue-name docflow-archive-retry --count 32

# Re-enqueue with retry_count=0 to start over
# (requires custom script to read + rewrite)
```

## Deployment Notes

### Azure Function Configuration
1. **Function App Settings**:
   - Add SharePoint credentials to Key Vault
   - Reference via App Settings (e.g., `@Microsoft.KeyVault(SecretUri=...)`)
   - Ensure Managed Identity has Key Vault read permissions

2. **Queue Visibility**:
   - Poison messages visible after 5 max retries (Azure default)
   - Handler scans retry queue independently
   - No dependency on dead-letter forwarding

3. **Cost Considerations**:
   - Blob storage: negligible (one copy per failed document)
   - Queue messages: retained 7 days (configurable)
   - Function invocations: timer runs every 5 min (43.2k/mo)

## Future Enhancements

1. **Adaptive Backoff**: Increase base interval if SharePoint latency detected
2. **Batch Upload**: Upload multiple retry queue messages in parallel
3. **Automatic Resolution**: Check SharePoint health before retry attempts
4. **Cost Optimization**: Delete blob fallback after N days + human confirmation
5. **Notification Integration**: Slack/email alerts for ops team
