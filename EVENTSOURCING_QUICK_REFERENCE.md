# EventSourcing Quick Reference

## One-Minute Overview

EventSourcing logs every step of a document processing job as immutable events. Use it to:
- **Audit**: Track every change to a document job
- **Debug**: See exactly what happened and when
- **Recover**: Rebuild state from events if something breaks

## API Cheat Sheet

### Write an Event
```javascript
const eventSourcing = require('../lib/eventSourcing');

await eventSourcing.writeEvent(
  'item-12345',           // jobId
  'pdf-generated',        // eventType (past tense)
  { pdfUrl: '...', size: 1024 },  // data (the change)
  { author: 'myFunction' } // metadata (optional)
);
```

### Query Events
```javascript
// Get all events for a job
const history = await eventSourcing.getHistory('item-12345');
console.log(history.events);  // Array of all events

// Get just the count
const count = await eventSourcing.getEventCount('item-12345');

// List all jobs
const allJobs = await eventSourcing.listJobs();
```

### Replay Events
```javascript
// Get all events in chronological order
const replay = await eventSourcing.replayFrom('item-12345', {});

// Replay from event #3 onward
const fromEvent3 = await eventSourcing.replayFrom('item-12345', {
  fromSequence: 3
});

// Replay between two dates
const dateRange = await eventSourcing.replayFrom('item-12345', {
  fromTimestamp: '2026-08-10T10:00:00Z',
  toTimestamp: '2026-08-10T11:00:00Z'
});
```

### Reduce Events to State
```javascript
// Define a reducer (transforms events → state)
const reducer = (state, event) => {
  if (event.eventType === 'pdf-generated') {
    state.pdfUrl = event.data.pdfUrl;
  }
  if (event.eventType === 'signed') {
    state.signedAt = event.timestamp;
  }
  return state;
};

// Apply reducer to all events
const currentState = await eventSourcing.reduceEvents(
  'item-12345',
  { pdfUrl: null, signedAt: null },  // initial state
  reducer
);
console.log(currentState);
// Output: { pdfUrl: "https://...", signedAt: "2026-08-10T10:30:00Z" }
```

### Delete a Job
```javascript
const result = await eventSourcing.deleteJob('item-12345');
console.log(`Deleted ${result.deleted} events`);
```

---

## Common Event Types

| Event Type | When to Log | Example Data |
|---|---|---|
| `job-created` | New document request created | `{templateId, signerEmail, manager}` |
| `pdf-generated` | PDF successfully created | `{pdfUrl, size, templateId}` |
| `pdf-generation-failed` | PDF creation error | `{error, code, retryable}` |
| `sent-for-signature` | Document sent to signer | `{agreementId, signerEmail, sentAt}` |
| `signed` | Signer signed the document | `{signatureId, completedAt}` |
| `signing-failed` | Signing declined or expired | `{status, reason}` |
| `archived` | Document moved to permanent storage | `{blobUrl, archivedAt}` |
| `error` | Generic failure | `{error, errorType, retryable}` |

---

## Integration Pattern

In each DocFlow function, wrap operations with event logging:

```javascript
async function myFunction(jobId, data) {
  try {
    // Do the work
    const result = await doSomething(data);

    // Log success
    await eventSourcing.writeEvent(
      jobId,
      'operation-succeeded',
      { result: result },
      { author: 'myFunction' }
    );

    return result;
  } catch (err) {
    // Log failure
    await eventSourcing.writeEvent(
      jobId,
      'operation-failed',
      { error: err.message, retryable: err.transient },
      { author: 'myFunction' }
    );
    throw err;
  }
}
```

---

## Querying Events via HTTP

The `eventLedger` function provides HTTP endpoints:

```bash
# Get all events for a job
curl "https://your-func.azurewebsites.net/api/eventLedger?jobId=item-12345"

# Get current state
curl "https://your-func.azurewebsites.net/api/eventLedger?jobId=item-12345&action=state"

# Replay from event #3
curl "https://your-func.azurewebsites.net/api/eventLedger?jobId=item-12345&action=replay&fromSeq=3"

# List all jobs with events
curl "https://your-func.azurewebsites.net/api/eventLedger?action=listJobs"
```

---

## Best Practices

✅ **DO:**
- Use consistent jobId format: `${boardId}-${itemId}`
- Log events immediately after success
- Use descriptive event types (past tense verbs)
- Include error details in failure events
- Use reducer functions to compute state

❌ **DON'T:**
- Log the same event twice
- Store redundant data (the jobId is already known)
- Use generic event names like `error` or `update`
- Forget to catch and log failures
- Assume Monday columns are always up-to-date (use events instead)

---

## Error Handling

```javascript
try {
  await eventSourcing.writeEvent(jobId, 'event', data);
} catch (err) {
  if (err.code === 'BlobAlreadyExists') {
    // Duplicate write attempt — safe to ignore
    logger.info('event-duplicate', { jobId });
  } else {
    // Unexpected failure — log and continue
    logger.warn('event-write-failed', err, { jobId });
  }
}
```

---

## Debugging Workflow

**Problem: "My job failed partway through"**
1. Query the event log: `eventLedger?jobId=...`
2. Find where it stopped (last successful event)
3. Replay from that point: `eventLedger?jobId=...&action=replay&fromSeq=N`
4. Fix the issue
5. Re-run the function manually (events are immutable, so re-run creates new events)

**Problem: "State is wrong in Monday"**
1. Query current state: `eventLedger?jobId=...&action=state`
2. See what the event log thinks the state should be
3. If wrong, check reducer logic
4. If correct, manually sync Monday: `updateMonday(jobId)`

**Problem: "Events look wrong"**
1. Check event log timestamps and sequence numbers
2. Verify event data has the right fields
3. Check if reducer is handling all event types

---

## Storage Details

Events are stored in Azure Blob Storage:
```
events/{jobId}/{ISO_DATE}T{TIME}-{SEQUENCE}-{TYPE}.json
```

Example:
```
events/12345-67890/2026-08-10T10_00_00_000-00000000-job-created.json
events/12345-67890/2026-08-10T10_00_05_123-00000001-pdf-generated.json
events/12345-67890/2026-08-10T10_00_30_456-00000002-signed.json
events/12345-67890/2026-08-10T10_01_00_789-00000003-archived.json
```

This naming ensures:
- Natural chronological ordering
- Easy filtering by jobId prefix
- Immutability (no overwrites)

---

## Performance Facts

| Operation | Time | Notes |
|---|---|---|
| Write event | ~50ms | Includes retry logic |
| Read event | ~20ms | Per event |
| List events | ~100ms | For 100+ events |
| Replay 100 events | ~200ms | Dependent on reducer complexity |
| Full state recovery | ~300ms | Full replay + reduce |

**Storage cost:** ~$0.40 per 1M operations (writes/reads)

---

## Common Patterns

### Pattern 1: Track Step Progress
```javascript
for (const step of steps) {
  try {
    await executeStep(step);
    await eventSourcing.writeEvent(jobId, `step-${step}-complete`, {});
  } catch (err) {
    await eventSourcing.writeEvent(jobId, `step-${step}-failed`, {error: err.message});
    throw err;
  }
}
```

### Pattern 2: Audit Trail for Compliance
```javascript
// Log every user action
await eventSourcing.writeEvent(jobId, 'document-viewed', 
  { viewedBy: userId, viewedAt: timestamp },
  { author: 'audit-system' }
);
```

### Pattern 3: Retry with State Recovery
```javascript
let attempt = 1;
while (attempt <= 3) {
  try {
    await processJob(jobId);
    break;
  } catch (err) {
    await eventSourcing.writeEvent(jobId, `attempt-${attempt}-failed`, {error: err.message});
    attempt++;
    await sleep(1000);
  }
}
```

### Pattern 4: Debugging via Event Replay
```javascript
// "What's the current state of this job?"
const state = await eventSourcing.reduceEvents(jobId, {}, reducer);

// "What happened between 10am and 11am?"
const window = await eventSourcing.replayFrom(jobId, {
  fromTimestamp: '2026-08-10T10:00:00Z',
  toTimestamp: '2026-08-10T11:00:00Z'
});
console.log(window.events);

// "What went wrong at step 5?"
const failing = await eventSourcing.getEvent(jobId, 5);
console.log(failing.data);
```

---

## Related

- [Full API Reference](src/lib/eventSourcing.USAGE.md)
- [Integration Guide](EVENTSOURCING_INTEGRATION.md)
- [Implementation](src/lib/eventSourcing.js)
- [Event Ledger Function](src/functions/eventLedger/index.js)

---

## Support

Check Application Insights for errors:
```kusto
customEvents
| where name startswith 'event-'
| where properties.jobId == "12345-67890"
| order by timestamp desc
```

Or check logs locally:
```bash
npm test
cat local-debug.log
```
