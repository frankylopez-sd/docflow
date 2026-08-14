# EventSourcing Integration Guide for DocFlow

## Overview

This guide explains how to integrate the EventSourcing module into the existing DocFlow functions to create a complete audit trail of all document processing steps.

**Key decisions:**
- **JobId Convention**: Use `${boardId}-${itemId}` as the unique job identifier
- **When to Log**: After every successful step, and on every failure
- **What to Log**: The state change (delta), not the entire row
- **Metadata**: Author (function name), source system, error details

---

## Architecture

```
Monday Webhook (trigger)
  ↓ writes event: job-created
  ↓
generatePDF (Adobe PDF Services)
  ↓ writes event: pdf-generated (or pdf-generation-failed)
  ↓
sendForSign (Adobe Sign)
  ↓ writes event: sent-for-signature
  ↓
adobeWebhook (Sign completion)
  ↓ writes event: signed (or sign-failed)
  ↓
signPoller (fallback polling)
  ↓ writes event: polling-complete
  ↓
archiveToBlob
  ↓ writes event: archived
  ↓
updateMonday (sync back)
  ↓ (reads state from events, updates Monday)
```

**Event Log (immutable):**
```
job-created (itemId, boardId, template, signer, manager)
pdf-generated (pdfUrl, size)
sent-for-signature (agreementId, signerEmail)
signed (signatureId, completedAt)
archived (blobUrl)
```

**State Recovery:**
```
replay all events → apply jobStateReducer → final state
  {
    status: 'archived',
    pdfUrl: '...',
    agreementId: '...',
    signedAt: '...',
  }
```

---

## Integration Steps

### Step 1: Modify `mondayWebhook` to Record Job Creation

**File:** `src/functions/mondayWebhook/index.js`

Add these imports at the top:
```javascript
const eventSourcing = require('../../lib/eventSourcing');
```

In the main handler, after validating the webhook, record the job creation:

```javascript
async function handleWebhook(req) {
  const cfg = config.load();
  const body = req.body || {};

  // ... existing validation and challenge response ...

  const event = body.event || {};
  const boardId = event.boardId || cfg.monday.onboardingBoardId;
  const itemId = event.pulseId || event.itemId;
  const jobId = `${boardId}-${itemId}`;

  // Get item details from Monday
  const item = await monday.getItem(itemId, boardId, [
    cfg.monday.columns.email,
    cfg.monday.columns.startDate,
    cfg.monday.columns.position,
    cfg.monday.columns.manager,
    cfg.monday.columns.template,
  ]);

  // *** NEW: Record job creation event ***
  try {
    await eventSourcing.writeEvent(
      jobId,
      'job-created',
      {
        boardId,
        itemId,
        templateId: item.template,
        signerEmail: item.email,
        signerName: item.name,
        startDate: item.startDate,
        position: item.position,
        manager: item.manager,
      },
      {
        author: 'mondayWebhook',
        source: 'Monday.com',
        webhookTimestamp: event.timestamp,
      }
    );
  } catch (err) {
    logger.warn('event-write-failed-continuing', err, { jobId });
    // Continue even if event log fails — don't block the workflow
  }

  // ... continue with queue message ...
}
```

### Step 2: Modify `generatePDF` to Log PDF Generation

**File:** `src/functions/generatePDF/index.js`

Add import:
```javascript
const eventSourcing = require('../../lib/eventSourcing');
```

Wrap the PDF generation and upload:

```javascript
async function generateAndUpload(jobId, itemId, boardId, templateId, data) {
  let pdfBuffer;
  try {
    // Generate PDF
    pdfBuffer = await adobe.generatePDF(templateId, data);

    // Upload to temp storage
    const { url, sasUrl } = await blob.uploadPDF(
      config.load().storage.tempContainer,
      `${jobId}.pdf`,
      pdfBuffer
    );

    // *** NEW: Log PDF generation success ***
    await eventSourcing.writeEvent(
      jobId,
      'pdf-generated',
      {
        size: pdfBuffer.length,
        url,
        sasUrl,
        templateId,
        uploadedTo: 'temp',
      },
      {
        author: 'generatePDF',
        adobeJobId: jobId, // For tracing Adobe API calls
      }
    );

    return { url, sasUrl };
  } catch (err) {
    // *** NEW: Log PDF generation failure ***
    try {
      await eventSourcing.writeEvent(
        jobId,
        'pdf-generation-failed',
        {
          error: err.message,
          code: err.code,
          details: err.response?.data || null,
          retryable: _isTransient(err),
        },
        {
          author: 'generatePDF',
          errorType: err.constructor.name,
        }
      );
    } catch (eventErr) {
      logger.warn('event-write-failed', eventErr, { jobId });
    }

    throw err;
  }
}

function _isTransient(err) {
  return err && (err.code === 'ECONNRESET' || (err.response && err.response.status >= 500));
}
```

### Step 3: Modify `sendForSign` to Log Signing Request

**File:** `src/functions/sendForSign/index.js`

Add import:
```javascript
const eventSourcing = require('../../lib/eventSourcing');
```

After successfully sending for signature:

```javascript
async function sendAgreement(jobId, pdfUrl, signerEmail) {
  try {
    const response = await adobe.sendAgreement(pdfUrl, signerEmail);

    // *** NEW: Log sent-for-signature event ***
    await eventSourcing.writeEvent(
      jobId,
      'sent-for-signature',
      {
        agreementId: response.agreementId,
        signerEmail,
        sentAt: new Date().toISOString(),
        esign: response.esign,
        nextUrl: response.nextUrl || null,
      },
      {
        author: 'sendForSign',
        adobeResponse: {
          agreementId: response.agreementId,
          // Don't log full response — just essential fields
        },
      }
    );

    return response;
  } catch (err) {
    // *** NEW: Log failure ***
    try {
      await eventSourcing.writeEvent(
        jobId,
        'send-for-signature-failed',
        {
          error: err.message,
          signerEmail,
          retryable: _isTransient(err),
        },
        { author: 'sendForSign' }
      );
    } catch (eventErr) {
      logger.warn('event-write-failed', eventErr);
    }

    throw err;
  }
}
```

### Step 4: Modify `adobeWebhook` to Log Signature Completion

**File:** `src/functions/adobeWebhook/index.js`

Add import:
```javascript
const eventSourcing = require('../../lib/eventSourcing');
```

When processing the signed webhook:

```javascript
async function handleSignatureWebhook(event) {
  const jobId = event.jobId; // Extract from event context
  const { agreementId, status, completedAt } = event.data;

  if (status === 'SIGNED') {
    // *** NEW: Log signature completion ***
    await eventSourcing.writeEvent(
      jobId,
      'signed',
      {
        agreementId,
        completedAt: completedAt || new Date().toISOString(),
        signatureId: event.signatureId,
        status,
      },
      {
        author: 'adobeWebhook',
        adobeWebhookId: event.webhookId,
      }
    );

    // Continue with download + archive
    return { success: true };
  } else if (status === 'DECLINED' || status === 'EXPIRED') {
    // *** NEW: Log failure cases ***
    await eventSourcing.writeEvent(
      jobId,
      'signing-failed',
      {
        agreementId,
        status,
        reason: event.reason || null,
      },
      { author: 'adobeWebhook' }
    );

    throw new Error(`Signing ${status.toLowerCase()}`);
  }
}
```

### Step 5: Modify `archiveToBlob` to Log Archival

**File:** `src/functions/archiveToBlob/index.js`

Add import:
```javascript
const eventSourcing = require('../../lib/eventSourcing');
```

After archiving:

```javascript
async function archiveSignedPDF(jobId, signedPdfBuffer) {
  try {
    const blobName = `${jobId}.pdf`;
    const { url, sasUrl } = await blob.uploadPDF(
      config.load().storage.archiveContainer,
      blobName,
      signedPdfBuffer
    );

    // *** NEW: Log archival ***
    await eventSourcing.writeEvent(
      jobId,
      'archived',
      {
        blobUrl: url,
        sasUrl,
        size: signedPdfBuffer.length,
        archivedAt: new Date().toISOString(),
      },
      {
        author: 'archiveToBlob',
        container: config.load().storage.archiveContainer,
      }
    );

    return { url, sasUrl };
  } catch (err) {
    // *** NEW: Log archive failure ***
    await eventSourcing.writeEvent(
      jobId,
      'archive-failed',
      {
        error: err.message,
        retryable: true,
      },
      { author: 'archiveToBlob' }
    );

    throw err;
  }
}
```

### Step 6: Modify `updateMonday` to Read from Event Log

**File:** `src/functions/updateMonday/index.js`

Add import:
```javascript
const eventSourcing = require('../../lib/eventSourcing');
```

Instead of reading state from Monday columns, reconstruct from events:

```javascript
async function syncJobStatus(jobId, itemId, boardId) {
  try {
    // *** NEW: Recover current state from event log ***
    const state = await eventSourcing.reduceEvents(
      jobId,
      { status: 'unknown', pdfUrl: null, archivedUrl: null },
      jobStateReducer
    );

    // Determine Monday status
    let mondayStatus = 'Processing';
    if (state.status === 'archived') mondayStatus = 'Completed';
    else if (state.status === 'failed') mondayStatus = 'Failed';
    else if (state.status === 'signed') mondayStatus = 'Signed';
    else if (state.status === 'awaiting-signature') mondayStatus = 'Awaiting Signature';

    // Update Monday with the recovered state
    const updates = {
      [config.load().monday.columns.status]: mondayStatus,
    };

    if (state.pdfUrl) {
      updates[config.load().monday.columns.pdfUrl] = state.pdfUrl;
    }
    if (state.archivedUrl) {
      updates[config.load().monday.columns.signedPdfUrl] = state.archivedUrl;
    }

    await monday.updateItem(itemId, boardId, updates);

    return { success: true, state };
  } catch (err) {
    logger.error('sync-failed', err, { jobId });
    throw err;
  }
}

const jobStateReducer = (state, event) => {
  if (event.eventType === 'pdf-generated') {
    state.pdfUrl = event.data.url;
    state.status = 'pdf-ready';
  }
  if (event.eventType === 'sent-for-signature') {
    state.status = 'awaiting-signature';
    state.agreementId = event.data.agreementId;
  }
  if (event.eventType === 'signed') {
    state.status = 'signed';
  }
  if (event.eventType === 'archived') {
    state.status = 'archived';
    state.archivedUrl = event.data.blobUrl;
  }
  if (event.eventType.includes('failed')) {
    state.status = 'failed';
  }
  return state;
};
```

---

## New Functions

### Event Ledger Function

A new function to query event history and replay state:

**File:** `src/functions/eventLedger/index.js`

See the complete implementation in `eventLedger/index.js`. This function provides:

- `GET /api/eventLedger?jobId=...` — Full event history
- `GET /api/eventLedger?jobId=...&action=state` — Replay to current state
- `GET /api/eventLedger?jobId=...&action=replay&fromSeq=N` — Replay from point N
- `GET /api/eventLedger?action=listJobs` — All jobs with events

---

## Configuration (function.json)

Create `src/functions/eventLedger/function.json`:

```json
{
  "bindings": [
    {
      "authLevel": "function",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["get"]
    },
    {
      "type": "http",
      "direction": "out",
      "name": "$return"
    }
  ]
}
```

---

## Event Schema Reference

### job-created
```javascript
{
  eventType: 'job-created',
  data: {
    boardId: string,
    itemId: string,
    templateId: string,
    signerEmail: string,
    signerName: string,
    startDate: string,
    position: string,
    manager: string,
  }
}
```

### pdf-generated
```javascript
{
  eventType: 'pdf-generated',
  data: {
    size: number,
    url: string,
    sasUrl: string,
    templateId: string,
    uploadedTo: 'temp' | 'archive',
  }
}
```

### pdf-generation-failed
```javascript
{
  eventType: 'pdf-generation-failed',
  data: {
    error: string,
    code: string,
    details: object,
    retryable: boolean,
  }
}
```

### sent-for-signature
```javascript
{
  eventType: 'sent-for-signature',
  data: {
    agreementId: string,
    signerEmail: string,
    sentAt: ISO timestamp,
    esign: boolean,
  }
}
```

### signed
```javascript
{
  eventType: 'signed',
  data: {
    agreementId: string,
    completedAt: ISO timestamp,
    signatureId: string,
    status: 'SIGNED' | 'DECLINED' | 'EXPIRED',
  }
}
```

### archived
```javascript
{
  eventType: 'archived',
  data: {
    blobUrl: string,
    sasUrl: string,
    size: number,
    archivedAt: ISO timestamp,
  }
}
```

---

## Testing the Integration

### 1. Trigger a Job

Send a Monday webhook to create a job.

### 2. Check Event Log

```bash
curl "https://doc-automation-func.azurewebsites.net/api/eventLedger?jobId=12345-67890"
```

Response:
```json
{
  "jobId": "12345-67890",
  "totalEvents": 5,
  "events": [
    {
      "sequence": 0,
      "type": "job-created",
      "timestamp": "2026-08-10T10:00:00.000Z",
      "data": { ... }
    },
    {
      "sequence": 1,
      "type": "pdf-generated",
      "timestamp": "2026-08-10T10:00:05.000Z",
      "data": { ... }
    },
    ...
  ]
}
```

### 3. Check Current State

```bash
curl "https://doc-automation-func.azurewebsites.net/api/eventLedger?jobId=12345-67890&action=state"
```

Response:
```json
{
  "jobId": "12345-67890",
  "eventCount": 5,
  "currentState": {
    "status": "archived",
    "pdfUrl": "https://...",
    "agreementId": "agreement-xxx",
    "signedAt": "2026-08-10T10:00:30.000Z",
    "archivedUrl": "https://..."
  }
}
```

### 4. Replay from a Point

```bash
curl "https://doc-automation-func.azurewebsites.net/api/eventLedger?jobId=12345-67890&action=replay&fromSeq=2"
```

Shows the state transitions from sequence 2 onward.

---

## Monitoring & Debugging

### Application Insights

All event operations log metrics:
- `event-written` — Event successfully recorded
- `event-history-retrieved` — Query results
- `event-replay` — Replay operations
- `event-reduce-failed` — Reducer errors

Query in Application Insights:
```kusto
customEvents
| where name startswith 'event-'
| where properties.jobId == "12345-67890"
| order by timestamp desc
```

### Storage Metrics

Monitor Blob Storage usage:
- **Blob count**: `telemetry:blob-count` in Application Insights
- **Upload throughput**: Check Azure Portal → Storage Account → Metrics
- **Queries**: Events listed by prefix query (list blobs per jobId)

---

## Performance Notes

- **Event write**: ~50ms per event (includes retry)
- **History retrieval**: ~100ms for 100 events
- **State replay**: ~200ms for 1000 events
- **Storage**: ~1-5 KB per event, so 1000 events ≈ 5 MB per job

For high-volume jobs, consider:
- Archiving old events after 90 days
- Creating snapshots every 100 events
- Partitioning by time (events-2026-08/jobId/...)

---

## Related

- [EventSourcing API Reference](src/lib/eventSourcing.USAGE.md)
- [EventSourcing Implementation](src/lib/eventSourcing.js)
- [Event Ledger Function](src/functions/eventLedger/index.js)
