# EventSourcing Usage Guide

## Overview

EventSourcing provides an immutable, queryable event log for every step in the DocFlow document lifecycle. All state changes are recorded as timestamped events stored in Azure Blob Storage, enabling:

- **Full audit trail** of document processing
- **State recovery** by replaying events from any point
- **Debugging** complex multi-step workflows
- **Compliance** with document handling regulations

## API Reference

### Writing Events

#### `writeEvent(jobId, eventType, data, metadata)`

Records an immutable event for a job.

**Parameters:**
- `jobId` (string, required): Unique job identifier (Monday itemId or similar)
- `eventType` (string, required): Event classification (e.g., `pdf-generated`, `signed`)
- `data` (Object, required): Event payload containing the state change
- `metadata` (Object, optional): Additional context (author, source, userId, etc.)

**Returns:** `Promise<{eventId, timestamp, sequence, blobName}>`

**Example:**
```javascript
const eventSourcing = require('./eventSourcing');

// Record that a PDF was generated
await eventSourcing.writeEvent(
  'item-12345',              // jobId
  'pdf-generated',           // eventType
  {
    pdfUrl: 'https://blob.../doc.pdf',
    size: 1048576,
    templateId: 'tmpl-789',
  },
  {
    author: 'system',
    source: 'generatePDF-function',
    functionVersion: '1.2.3',
  }
);

// Record a signing milestone
await eventSourcing.writeEvent(
  'item-12345',
  'sent-for-signature',
  {
    agreementId: 'agreement-xxx-yyy',
    signerEmail: 'john@example.com',
    sentAt: new Date().toISOString(),
  },
  { author: 'sendForSign-function' }
);

// Record completion
await eventSourcing.writeEvent(
  'item-12345',
  'signed',
  {
    completedAt: new Date().toISOString(),
    signatureId: 'sig-aaa-bbb',
  },
  { author: 'adobeWebhook-function' }
);
```

---

### Querying Events

#### `getHistory(jobId, options)`

Retrieves all events for a job with pagination support.

**Parameters:**
- `jobId` (string, required): Job identifier
- `options` (Object, optional):
  - `skip` (number, default 0): Number of events to skip
  - `limit` (number, default 100): Maximum events to return

**Returns:** `Promise<{jobId, events, total, skip, limit, returned, hasMore}>`

**Example:**
```javascript
// Get first 100 events
const page1 = await eventSourcing.getHistory('item-12345');
console.log(`Retrieved ${page1.returned} of ${page1.total} events`);
console.log(page1.events);

// Paginate through results
let skip = 0;
let allEvents = [];
while (true) {
  const result = await eventSourcing.getHistory('item-12345', { skip, limit: 50 });
  allEvents.push(...result.events);
  if (!result.hasMore) break;
  skip += 50;
}
```

#### `getEvent(jobId, sequence)`

Retrieves a specific event by sequence number.

**Parameters:**
- `jobId` (string, required): Job identifier
- `sequence` (number, required): Event sequence number (0-indexed)

**Returns:** `Promise<Object|null>` — Event or null if not found

**Example:**
```javascript
// Get 3rd event
const event = await eventSourcing.getEvent('item-12345', 2);
if (event) {
  console.log(`Event type: ${event.eventType}`);
  console.log(`Recorded at: ${event.timestamp}`);
}
```

#### `getEventCount(jobId)`

Gets the total number of events for a job.

**Returns:** `Promise<number>`

**Example:**
```javascript
const count = await eventSourcing.getEventCount('item-12345');
console.log(`Job has ${count} events`);
```

#### `listJobs()`

Lists all jobIds that have recorded events.

**Returns:** `Promise<string[]>` — Array of jobIds, sorted

**Example:**
```javascript
const allJobs = await eventSourcing.listJobs();
console.log(`${allJobs.length} jobs with events`);
```

---

### Replaying Events

#### `replayFrom(jobId, options)`

Replays events from a specific point to reconstruct state transitions.

**Parameters:**
- `jobId` (string, required): Job identifier
- `options` (Object, optional):
  - `fromSequence` (number): Replay from this sequence onward
  - `toSequence` (number): Replay until this sequence
  - `fromTimestamp` (string): Replay from this ISO timestamp
  - `toTimestamp` (string): Replay until this ISO timestamp

**Returns:** `Promise<{jobId, events, count, fromSequence, toSequence, ...}>`

**Example:**
```javascript
// Get all events
const allEvents = await eventSourcing.replayFrom('item-12345', {});

// Replay from sequence 3 onward
const fromEvent3 = await eventSourcing.replayFrom('item-12345', {
  fromSequence: 3
});

// Replay between specific times
const between = await eventSourcing.replayFrom('item-12345', {
  fromTimestamp: '2026-08-10T10:00:00Z',
  toTimestamp: '2026-08-10T11:00:00Z'
});

// Replay a specific window (events 2-5)
const window = await eventSourcing.replayFrom('item-12345', {
  fromSequence: 2,
  toSequence: 5
});
```

#### `reduceEvents(jobId, initialState, reducer)`

Replays all events through a reducer function to compute the final state.

This is the core event sourcing pattern: **replay all events → apply transformations → recover state**.

**Parameters:**
- `jobId` (string, required): Job identifier
- `initialState` (Object, required): Starting state (e.g., `{}`)
- `reducer` (Function, required): `(state, event) => newState`
  - Receives current state and an event
  - Returns updated state
  - Can be async

**Returns:** `Promise<Object>` — Final computed state

**Example:**
```javascript
const initialState = {
  status: null,
  pdfUrl: null,
  agreementId: null,
  signedAt: null,
  archivedAt: null,
};

const jobReducer = (state, event) => {
  if (event.eventType === 'pdf-generated') {
    state.pdfUrl = event.data.pdfUrl;
    state.status = 'pdf-ready';
  }
  if (event.eventType === 'sent-for-signature') {
    state.agreementId = event.data.agreementId;
    state.status = 'awaiting-signature';
  }
  if (event.eventType === 'signed') {
    state.signedAt = event.timestamp;
    state.status = 'signed';
  }
  if (event.eventType === 'archived') {
    state.archivedAt = event.timestamp;
    state.status = 'archived';
  }
  if (event.eventType === 'error') {
    state.lastError = event.data.error;
    state.status = 'failed';
  }
  return state;
};

// Recover job state from event log
const currentState = await eventSourcing.reduceEvents(
  'item-12345',
  initialState,
  jobReducer
);

console.log(`Job status: ${currentState.status}`);
console.log(`PDF URL: ${currentState.pdfUrl}`);
```

---

### Admin Operations

#### `deleteJob(jobId)`

Deletes all events for a job (e.g., for GDPR right-to-be-forgotten).

**Returns:** `Promise<{deleted: number}>`

**Example:**
```javascript
const result = await eventSourcing.deleteJob('item-12345');
console.log(`Deleted ${result.deleted} events`);
```

---

## Integration with DocFlow Functions

### Example 1: Update `mondayWebhook` to Log Job Creation

**File:** `src/functions/mondayWebhook/index.js`

```javascript
const eventSourcing = require('../../lib/eventSourcing');

async function handleWebhook(req) {
  // ... existing logic ...

  const jobId = `${boardId}-${itemId}`;
  
  // Log job creation
  await eventSourcing.writeEvent(
    jobId,
    'job-created',
    {
      boardId,
      itemId,
      templateId: template,
      signerEmail: email,
      managerEmail: manager,
    },
    {
      author: 'mondayWebhook',
      source: 'Monday.com',
      webhookTimestamp: event.timestamp,
    }
  );

  // ... continue with processing ...
}
```

### Example 2: Update `generatePDF` to Log Success and Failures

**File:** `src/functions/generatePDF/index.js`

```javascript
const eventSourcing = require('../../lib/eventSourcing');

async function generate(jobId, itemId, templateId, data) {
  try {
    const pdfBuffer = await adobe.generatePDF(templateId, data);
    const { url, sasUrl } = await blob.uploadPDF(
      config.load().storage.tempContainer,
      `${jobId}.pdf`,
      pdfBuffer
    );

    // Log success
    await eventSourcing.writeEvent(
      jobId,
      'pdf-generated',
      {
        size: pdfBuffer.length,
        url,
        sasUrl,
        templateId,
      },
      {
        author: 'generatePDF',
        pdfServicesJobId: jobId, // Adobe's job ID for debugging
      }
    );

    return { url, sasUrl };
  } catch (err) {
    // Log failure
    await eventSourcing.writeEvent(
      jobId,
      'pdf-generation-failed',
      {
        error: err.message,
        code: err.code,
        details: err.response?.data,
      },
      { author: 'generatePDF' }
    );
    throw err;
  }
}
```

### Example 3: Add Admin Dashboard Function to Query Event History

**File:** `src/functions/getJobHistory/index.js`

```javascript
const eventSourcing = require('../../lib/eventSourcing');
const logger = require('../../lib/logger');

module.exports = async function (context, req) {
  try {
    const { jobId, skip = 0, limit = 100 } = req.query;

    if (!jobId) {
      return {
        status: 400,
        body: { error: 'jobId query parameter required' },
      };
    }

    // Get event history
    const history = await eventSourcing.getHistory(jobId, { skip, limit });

    // Compute current state by replaying
    const state = await eventSourcing.reduceEvents(
      jobId,
      {},
      (state, event) => {
        state[event.eventType] = event.timestamp;
        return state;
      }
    );

    context.res = {
      status: 200,
      body: {
        jobId,
        currentState: state,
        history,
      },
    };
  } catch (err) {
    logger.error('get-job-history-failed', err, { jobId: req.query.jobId });
    context.res = {
      status: 500,
      body: { error: err.message },
    };
  }
};
```

---

## Storage Structure

Events are stored in Azure Blob Storage with this structure:

```
events/
├── {jobId}/
│   ├── 2026-08-10T10_00_00_123-00000000-pdf-generated.json
│   ├── 2026-08-10T10_00_15_456-00000001-sent-for-signature.json
│   ├── 2026-08-10T10_30_45_789-00000002-signed.json
│   └── 2026-08-10T11_00_00_000-00000003-archived.json
└── {jobId2}/
    └── ...

events-index/
├── {jobId}/
│   └── index.json  (metadata: count, lastUpdate, event summaries)
└── {jobId2}/
    └── index.json
```

Blob names follow this pattern:
```
events/{jobId}/{ISO_DATE}T{HH_MM_SS_mmm}-{SEQUENCE}-{EVENT_TYPE}.json
```

This ensures:
- **Natural chronological sorting** by ISO timestamp
- **Lexicographic traversal** of all events for a jobId using a prefix filter
- **Immutability** (no overwrites allowed)

---

## Event Schema

Each event is a JSON object:

```json
{
  "eventId": "1723289400123-a1b2c3d4e5f6g7h8",
  "jobId": "item-12345",
  "timestamp": "2026-08-10T10:30:00.123Z",
  "sequence": 2,
  "eventType": "signed",
  "data": {
    "completedAt": "2026-08-10T10:30:00Z",
    "signatureId": "sig-xxx-yyy-zzz"
  },
  "metadata": {
    "author": "adobeWebhook",
    "source": "Adobe Sign",
    "recordedAt": "2026-08-10T10:30:00.123Z"
  }
}
```

---

## Best Practices

### 1. Assign a Consistent `jobId`

Use a stable, unique identifier for each document job:
```javascript
const jobId = `${boardId}-${itemId}`;  // Good
const jobId = `${boardId}-${itemId}-${Date.now()}`; // Avoid: timestamps not stable
```

### 2. Use Descriptive Event Types

Event type names should be **past-tense verbs** describing what happened:
```javascript
'job-created'              // Good
'pdf-generated'            // Good
'sent-for-signature'       // Good
'signature-received'       // Good
'archive-failed'           // Good
'PDFMade'                  // Bad: present tense, camelCase
'error'                    // Bad: too generic
```

### 3. Keep Data Payloads Focused

Store only the delta/change, not the full state:
```javascript
// Good: only the change
await eventSourcing.writeEvent(jobId, 'pdf-generated', {
  pdfUrl: 'https://...',
  size: 1048576,
});

// Bad: redundant/duplicate data
await eventSourcing.writeEvent(jobId, 'pdf-generated', {
  jobId: itemId,           // Already in context
  timestamp: Date.now(),   // System adds this
  status: 'pdf-ready',     // Store in reducer instead
  pdfUrl: '...',
  templateId: '...',
  signerEmail: '...',
  // ... entire row from Monday
});
```

### 4. Log Metadata for Debugging

Use `metadata` to track _where_ and _who_ caused the event:
```javascript
await eventSourcing.writeEvent(jobId, 'pdf-generation-failed', error, {
  author: 'generatePDF-function',
  adobeJobId: err.response?.data?.id,
  retryAttempt: 2,
  errorCategory: 'adobe-api',
});
```

### 5. Use `reduceEvents` to Recover State

Instead of storing state in Monday, rebuild it from events:
```javascript
// ✓ Better: event sourcing
const state = await eventSourcing.reduceEvents(jobId, {}, jobReducer);
await monday.updateItem(itemId, { statusColumn: state.status });

// ✗ Avoid: duplicating state everywhere
state.pdfUrl = event.data.pdfUrl;
state.agreementId = ...
// ... duplicate updates in 3 different functions
```

### 6. Handle Failures as Events

Don't just throw errors — log them as events:
```javascript
try {
  await adobe.generatePDF(...);
} catch (err) {
  // Log the failure as an event
  await eventSourcing.writeEvent(jobId, 'pdf-generation-failed', {
    error: err.message,
    code: err.code,
    retryable: isTransient(err),
  });
  throw err;
}
```

---

## Performance Considerations

- **Event size**: Keep events <1 MB (typically <10 KB)
- **Query performance**: Listing events for a job is O(n); index metadata helps
- **Replay cost**: Reducing 1000+ events is linear but fast (~100ms)
- **Write throughput**: Blob Storage allows ~20K writes/sec per account

For high-volume scenarios, consider:
- Archiving old events to cold storage
- Creating summary snapshots every N events
- Partitioning jobIds across multiple containers

---

## Testing

### Unit Tests

Use mocked config and logger:

```javascript
jest.mock('../lib/config');
jest.mock('../lib/logger');

config.load.mockReturnValue({ storage: { accountName: 'test', ... } });

// Test API contracts
await expect(eventSourcing.writeEvent(null, 'test', {}))
  .rejects.toThrow('jobId is required');
```

### Integration Tests

Run against Azure Storage Emulator:

```bash
# Start emulator
docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite

# Set env var
export STORAGE_ACCOUNT_NAME=devstoreaccount1

# Run tests
npm test -- eventSourcing.integration.test.js
```

---

## Troubleshooting

### Events aren't persisting

1. Check Azure Storage connection string / credentials
2. Verify container permissions (ensure `createIfNotExists` succeeds)
3. Check `logger.event('blob-uploaded', ...)` in Application Insights

### Replay is returning wrong state

1. Verify reducer logic handles all event types
2. Check event order with `getHistory(jobId)`
3. Use `replayFrom(jobId, {fromSequence: N})` to debug specific windows

### Performance degradation

1. Monitor event count per job (if > 10K, consider snapshots)
2. Check Blob Storage metrics (throttling?) in Azure Portal
3. Profile reducer function — avoid O(n²) operations

---

## Related

- [Azure Blob Storage Documentation](https://learn.microsoft.com/azure/storage/blobs/)
- [Event Sourcing Pattern](https://martinfowler.com/eaaDev/EventSourcing.html)
- [DocFlow README](../../README.md)
