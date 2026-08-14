# Monday Webhook Error Handling Guide

## Overview

The webhook handler implements a **layered error strategy** that returns appropriate HTTP status codes based on the type of failure:

| Status | Scenario | Retryable | Example |
|--------|----------|-----------|---------|
| **200** | Success | N/A | Webhook accepted and queued |
| **200** | Ignored | N/A | Event doesn't match trigger criteria |
| **401** | Security failure | ❌ No | Invalid signature, expired JWT, missing auth |
| **422** | Data warning | ❌ No | Incomplete hire data (but still queued) |
| **429** | Rate limited | ⚠️ Yes | Queue depth exceeds threshold |
| **500** | Internal error | ⚠️ Yes | Unexpected exceptions |
| **503** | Queue unavailable | ✅ **Yes** | Storage service down, connection failed |

## Error Handling Architecture

### Layer 1: Signature Validation (401)

**File**: `src/lib/webhookErrors.js` → `validateSignature()`

Throws `WebhookError` with type `SIGNATURE_INVALID` if:
- Authorization header is missing
- JWT has malformed structure
- HMAC signature doesn't match
- Token has expired

**Response**: `401 Unauthorized` — **non-retryable** (Monday won't retry)

```javascript
try {
  const result = validateSignature(authHeader, secret);
  // throws WebhookError if invalid
} catch (err) {
  if (err instanceof WebhookError) {
    // 401 response
    return {
      status: 401,
      body: { error: 'invalid signature' },
      queueMessage: null,
    };
  }
}
```

### Layer 2: Event Filtering (200 Ignored)

**File**: `src/functions/mondayWebhook/index.js` → `handleWebhook()`

Silently ignores (returns 200) if:
- No `itemId` in event
- Event is not a checkbox column update
- Checkbox is unchecked (only respond to checks)
- Wrong column ID

```javascript
if (isColumnEvent && (!isTriggerColumn || !checked)) {
  return {
    status: 200,
    body: { ignored: true, reason: 'not trigger checkbox checked' },
    queueMessage: null,
  };
}
```

### Layer 3: Data Validation (422 but Queued Anyway)

**File**: `src/lib/webhookErrors.js` → `validateHireData()`

If hire data is missing fields but webhook is otherwise valid:
- Returns **422 Unprocessable Entity** with warnings
- **Still queues the message** (PDF generation handles full validation)
- Non-retryable

```javascript
const dataValidation = validateHireData(row, cols);
if (!dataValidation.allValid) {
  warnings.push(...dataValidation.warnings);
  
  return {
    status: 422,
    body: {
      queued: true,
      itemId: itemId,
      warning: 'incomplete hire data',
      note: 'Message queued; PDF generation will validate fully',
    },
    queueMessage: { /* still included */ },
    warnings: dataValidation.warnings,
  };
}
```

**Why queue anyway?** The PDF generation step (`generatePDF/index.js`) validates data more comprehensively and can handle minor missing fields gracefully.

### Layer 4: Queue Submission (503, Retryable)

**File**: `src/functions/mondayWebhook/index.js` → context bindings error

When Azure Queue Storage binding fails:

```javascript
try {
  context.bindings.generateQueue = JSON.stringify(result.queueMessage);
} catch (err) {
  // Convert to WebhookError with 503
  handleError = queueErrorToWebhookError(err);
  // Returns 503 Service Unavailable, retryable: true
}
```

**Response**: `503 Service Unavailable` — **retryable** (Monday or Azure will retry)

Common causes:
- Storage account connection error
- Network timeout
- Queue service maintenance

### Layer 5: Unexpected Errors (500, Retryable)

Any exception that escapes the handler:

```javascript
} catch (err) {
  if (err instanceof WebhookError) {
    // Already handled above
  } else {
    // Completely unexpected
    logger.error('monday-webhook-unexpected-error', err);
    
    // Best effort: notify HR by updating the Monday row
    try {
      await monday.updateStatus(boardId, itemId, { status: 'Webhook Error' });
    } catch (inner) {
      logger.error('monday-webhook-error-status-write-failed', inner);
    }
    
    context.res = {
      status: 500,
      body: { error: 'internal server error' },
    };
  }
}
```

**Response**: `500 Internal Server Error` — **retryable** (Azure will retry)

## Decision Tree

```
Webhook request arrives
│
├─ Has challenge?
│  └─→ Echo challenge (200)
│
├─ Valid signature?
│  ├─→ No  → 401 Unauthorized (non-retryable)
│  └─→ Yes
│
├─ Matches trigger criteria (checkbox checked)?
│  ├─→ No  → 200 OK (ignored)
│  └─→ Yes
│
├─ Hire data complete?
│  ├─→ No  → 422 Unprocessable Entity (warnings)
│  │         BUT still queue the message
│  └─→ Yes
│
├─ Can submit to queue?
│  ├─→ No  → 503 Service Unavailable (retryable)
│  └─→ Yes → 200 OK (queued)
│
└─ Unexpected error?
   └─→ 500 Internal Server Error (retryable)
      Attempt to update Monday status for visibility
```

## Implementation Details

### WebhookError Class

```javascript
class WebhookError extends Error {
  constructor(type, message, details = {}) {
    super(message);
    this.type = type;                // ErrorTypes.SIGNATURE_INVALID, etc.
    this.details = details;          // Context for logging
    this.response = ErrorResponses[type];
  }

  getResponse() {
    return {
      status: this.response.status,
      body: this.response.body,
    };
  }

  isRetryable() {
    return this.response.retryable;
  }

  log(context = {}) {
    // Structured logging with error type
  }
}
```

### Error Type Enum

```javascript
const ErrorTypes = {
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',           // 401
  SIGNATURE_MISSING: 'SIGNATURE_MISSING',           // 401
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',                   // 401
  TOKEN_MALFORMED: 'TOKEN_MALFORMED',               // 401
  HIRE_DATA_INCOMPLETE: 'HIRE_DATA_INCOMPLETE',     // 422
  QUEUE_SUBMISSION_FAILED: 'QUEUE_SUBMISSION_FAILED', // 503
  QUEUE_SERVICE_UNAVAILABLE: 'QUEUE_SERVICE_UNAVAILABLE', // 503
  EVENT_PAYLOAD_INVALID: 'EVENT_PAYLOAD_INVALID',   // 400
  INTERNAL_ERROR: 'INTERNAL_ERROR',                 // 500
};
```

### Response Mapping

Each error type maps to a response:

```javascript
const ErrorResponses = {
  SIGNATURE_INVALID: {
    status: 401,
    body: { error: 'invalid signature' },
    retryable: false,
    reason: 'Webhook signature validation failed',
  },
  HIRE_DATA_INCOMPLETE: {
    status: 422,
    body: { warning: 'incomplete hire data', queued: true, note: '...' },
    retryable: false,
    reason: 'Hire data missing optional fields; queued anyway for PDF gen to handle',
  },
  QUEUE_SERVICE_UNAVAILABLE: {
    status: 503,
    body: { error: 'queue service unavailable', retry: true },
    retryable: true,
    reason: 'Queue storage service is temporarily unavailable',
  },
  // ... etc
};
```

## Testing Strategy

### Unit Tests: `webhookErrors.test.js`

Tests error module in isolation:
- JWT signature validation (all failure modes)
- Data validation warnings
- Queue error mapping
- Status code guarantees

```bash
npm test -- webhookErrors.test.js
```

### Integration Tests: `mondayWebhook.integration.test.js`

Tests full webhook handler flow:
- Challenge handshake
- Signature validation (401)
- Data warnings (422)
- Queue failures (503)
- Event filtering
- Queue message structure

```bash
npm test -- mondayWebhook.integration.test.js
```

### Manual Testing

**Test 401 (Bad Signature)**:
```bash
curl -X POST https://doc-automation-func.azurewebsites.net/api/mondayWebhook \
  -H "Authorization: Bearer invalid.jwt.signature" \
  -H "Content-Type: application/json" \
  -d '{"event":{"itemId":"123","boardId":"456","columnId":"trigger","value":{"checked":true}}}'

# Expected: 401 Unauthorized
```

**Test 422 (Incomplete Data)**:
```bash
# Webhook with incomplete hire data (missing email, start date, etc.)
# Expected: 422 Unprocessable Entity (but message still queued)
```

**Test 503 (Queue Failure)**:
```bash
# Disable storage account or stop Queue service, then send valid webhook
# Expected: 503 Service Unavailable (will retry)
```

## Logging

All errors are logged with structured context:

```javascript
err.log({ 
  requestPath: '/api/mondayWebhook',
  itemId: 'item123',
  phase: 'signature-validation',
});

// Output:
// {
//   ts: "2026-08-13T...",
//   level: "error",
//   message: "webhook-signature-invalid",
//   props: {
//     errorType: "SIGNATURE_INVALID",
//     reason: "JWT signature verification failed",
//     httpStatus: 401,
//     retryable: false,
//     requestPath: "/api/mondayWebhook",
//     itemId: "item123",
//     expectedLen: 32,
//     providedLen: 30,
//   }
// }
```

Logs go to:
- **Application Insights** (if configured)
- **stdout/stderr** (captured by Azure Functions runtime)
- **Both** (structured JSON)

## Azure Retry Behavior

### Monday → Webhook

Monday automatically retries **non-delivery** (connection errors, timeouts). Our error codes tell Monday whether **to retry** the logical request:

- **401, 422**: Don't retry — it's a client error
- **503, 500**: Retry — it's a server error

### Azure Queue → Downstream

Messages in `docflow-generate` queue are processed by the `generatePDF` function, which has its own retry/dead-letter policy:

- Function fails → enqueue to `docflow-generate-poison` queue
- Max retries → move to poison queue for ops investigation

## Configuration

Add to `.env` or `local.settings.json`:

```json
{
  "DOCFLOW_VALIDATE_DATA_BEFORE_QUEUE": "true",
  "DOCFLOW_QUEUE_RATE_LIMIT_THRESHOLD": "1000",
  "DOCFLOW_LOG_LEVEL": "info"
}
```

## Deployment Checklist

- [ ] Deploy `webhookErrors.js` to prod
- [ ] Update `mondayWebhook/index.js` with new error handling
- [ ] Verify Application Insights captures structured error logs
- [ ] Monitor Monday webhook success rate (should be 100% for valid requests)
- [ ] Test error paths with synthetic webhooks
- [ ] Set up alerts for 503 rate > 5% (queue issues)
- [ ] Document runbooks for common errors

## Troubleshooting

### "401 Unauthorized" for Valid Webhooks

Check:
1. Webhook signing secret matches Monday app settings
2. JWT timestamp is recent (< 5 minutes old)
3. HMAC algorithm is SHA256

### "422 Unprocessable Entity" Repeatedly

Expected for incomplete data. Either:
1. HR fills in missing fields in Monday
2. PDF generation handles missing fields gracefully
3. Ops investigates if data is systematically incomplete

### "503 Service Unavailable" on Valid Webhooks

1. Check Azure Queue Storage status
2. Verify connection string in app settings
3. Check if account is firewalled
4. Review storage account logs for throttling

### Messages Queued but PDF Never Generated

Check:
1. `docflow-generate` queue has messages (not empty)
2. `generatePDF` function is running
3. Function app has permission to read Monday
4. Check function app logs for PDF generation errors
