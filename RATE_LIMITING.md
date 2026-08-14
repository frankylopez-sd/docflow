# Monday Webhook Rate Limiting Implementation

## Overview

This document describes the Monday webhook rate limiting mechanism for DocFlow. When Monday sends multiple webhooks rapidly, the system can become overwhelmed if the processing queue grows beyond capacity. The rate limiting implementation prevents the queue from exceeding 1,000 pending items by returning HTTP 429 (Too Many Requests) responses.

## Architecture

### Components

1. **Queue Utility Module** (`src/lib/queue.js`)
   - Monitors Azure Storage Queue depth using `@azure/storage-queue` SDK
   - Provides queue depth checking and overload detection
   - Supports both shared-key and managed-identity authentication

2. **Monday Webhook Handler** (`src/functions/mondayWebhook/index.js`)
   - Checks queue depth before enqueuing new requests
   - Returns 429 when queue exceeds threshold
   - Includes `Retry-After` header for Monday to respect backoff

3. **Configuration** (`src/lib/config.js`)
   - Centralized rate limit threshold setting
   - Environment variable: `DOCFLOW_QUEUE_RATE_LIMIT_THRESHOLD` (default: 1000)

## How It Works

### Request Flow

```
Monday Webhook → Signature Validation → Rate Limit Check → Queue Depth Decision
                                             ↓
                                    If Depth < 1000: Enqueue (200)
                                    If Depth ≥ 1000: Reject (429)
```

### Rate Limiting Logic

1. **Signature Validation**: Validate Monday's JWT authorization header
2. **Queue Depth Check**: Query `docflow-generate` queue properties
3. **Decision**:
   - If queue depth < threshold (1000): Accept and enqueue
   - If queue depth ≥ threshold: Reject with 429 status

### Response Examples

#### Success (Queue has capacity)
```json
HTTP 200 OK
{
  "queued": true,
  "itemId": "123456"
}
```

#### Rate Limited (Queue full)
```json
HTTP 429 Too Many Requests
Retry-After: 60

{
  "error": "service temporarily overloaded",
  "queueDepth": 1050,
  "threshold": 1000
}
```

## Configuration

### Environment Variables

Set these in Azure App Settings or local `.env`:

```bash
# Rate limit threshold (items in queue)
DOCFLOW_QUEUE_RATE_LIMIT_THRESHOLD=1000

# Storage account (existing)
STORAGE_ACCOUNT_NAME=myaccount
STORAGE_ACCOUNT_KEY=...

# Monday signing secret (existing)
MONDAY_SIGNING_SECRET=...
```

### Threshold Tuning

Adjust based on processing capacity:

- **Small deployments** (< 10 items/sec): 500-1000
- **Medium deployments** (10-50 items/sec): 1000-2000
- **Large deployments** (> 50 items/sec): 2000-5000

Current default: **1000 items**

## Implementation Details

### Queue Module API

```javascript
// src/lib/queue.js

// Get current queue depth
const depth = await queue.getQueueDepth('docflow-generate');
// Returns: number

// Check if queue is overloaded
const { overloaded, depth } = await queue.isOverloaded('docflow-generate', 1000);
// Returns: { overloaded: boolean, depth: number }

// Get detailed queue statistics
const stats = await queue.getQueueStats('docflow-generate');
// Returns: { name, depth, metadata, createdOn, lastModified, error? }
```

### Webhook Handler Changes

The Monday webhook now:

1. Imports queue module
2. Calls `queue.isOverloaded()` after signature validation
3. Returns 429 response if overloaded
4. Sets `Retry-After: 60` header for Monday's backoff

```javascript
// In mondayWebhook/index.js
const { overloaded, depth } = await queue.isOverloaded(
  'docflow-generate',
  rateLimitThreshold
);

if (overloaded) {
  return {
    status: 429,
    body: { error: 'service temporarily overloaded', queueDepth: depth, threshold },
    queueMessage: null,
    retryAfter: 60,
  };
}
```

## Monitoring & Alerting

### Logged Events

The implementation logs these events:

- `queue-depth-checked`: Normal depth checks
- `queue-overloaded`: Threshold exceeded (WARN level)
- `monday-webhook-rate-limited`: Requests rejected (WARN level)
- `queue-depth-check-failed`: Query failures (graceful degradation)

### Application Insights Queries

Track rate limiting impact:

```kusto
// Rate-limited requests over time
customEvents
| where name == "monday-webhook-rate-limited"
| summarize Count=count() by bin(timestamp, 5m)
| render timechart

// Queue depth trends
customEvents
| where name == "queue-depth-checked"
| extend depth = toreal(customDimensions.depth)
| summarize AvgDepth=avg(depth), MaxDepth=max(depth) by bin(timestamp, 5m)

// Rate limit effectiveness
customEvents
| where name in ("queue-overloaded", "monday-webhook-rate-limited")
| summarize RateLimitEvents=count() by name
```

## Testing

### Unit Tests

Run queue module tests:

```bash
npm test -- src/tests/queue.test.js
```

Tests cover:
- Queue depth retrieval
- Overload detection at/above threshold
- Graceful error handling
- Parameter validation

### Integration Testing

Test with actual Monday webhook:

```bash
# Send test webhook
curl -X POST https://doc-automation-func.azurewebsites.net/api/mondayWebhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(node -e 'console.log(require("./test-jwt-generator").create())')" \
  -d '{
    "event": {
      "type": "update_column_value",
      "boardId": "18422046530",
      "itemId": "555",
      "columnId": "checkbox",
      "value": { "checked": true }
    }
  }'

# Expected: 200 (if queue has capacity) or 429 (if overloaded)
```

## Deployment

### Prerequisites

1. Update `package.json` to include `@azure/storage-queue`:
   ```json
   "@azure/storage-queue": "^12.18.0"
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run tests:
   ```bash
   npm test
   ```

### Deployment Steps

1. **Local Testing**:
   ```bash
   npm test
   npm test -- src/tests/queue.test.js
   ```

2. **Staging Deployment**:
   ```bash
   git add .
   git commit -m "Add webhook rate limiting (queue depth >1000 → 429)"
   git push origin feature/rate-limiting
   # Create and merge PR
   ```

3. **Production Deployment**:
   - Merge to main branch
   - GitHub Actions auto-deploys via Azure Functions
   - Verify with: `curl https://doc-automation-func.azurewebsites.net/api/health`

### Rollback

If issues occur, revert to previous version:

```bash
git revert <commit-hash>
git push
# GitHub Actions auto-redeploys previous version
```

## Failure Modes & Recovery

### Scenario: Queue Depth Check Fails

**Behavior**: Fails open (allows request through)
**Reason**: Better to process and queue than reject valid requests
**Resolution**: Automatic retry on next webhook; check Azure Storage connectivity

### Scenario: Queue Keeps Growing

**Symptoms**: Frequent 429 responses, increasing queue depth
**Root Causes**:
1. Processing too slow (check `generatePDF` function performance)
2. External service outages (Adobe, Monday)
3. Insufficient concurrency

**Resolution**:
1. Increase Azure Function scale-out settings
2. Check Adobe Sign API status
3. Increase `DOCFLOW_QUEUE_RATE_LIMIT_THRESHOLD` temporarily if needed

### Scenario: Monday Stops Retrying

**Symptoms**: Webhooks not arriving after 429 responses
**Cause**: Monday's retry logic may have limits
**Resolution**: Provide adequate `Retry-After` header (60 seconds recommended)

## Performance Considerations

### Queue Depth Check Overhead

- **Cost**: 1-2 ms per webhook (queue metadata query)
- **Storage API calls**: 1 per webhook (covered by Azure Functions plan)
- **Impact**: < 1% latency increase vs. signature validation

### Scaling

At 100 webhooks/sec with 1000 item threshold:
- Max queue items: 1000
- Max processing time before throttling: 10 seconds
- Recommended Azure Function plan: Premium or App Service dedicated

## Future Improvements

1. **Adaptive Thresholds**: Adjust limit based on processing speed
2. **Per-Item Priority Scoring**: Prioritize high-priority items
3. **Circuit Breaker Pattern**: Temporarily halt ingestion on sustained overload
4. **Queue Depth Trending**: Predict overload before threshold is hit
5. **Webhook Batching**: Group multiple items in single queue message

## Support & Troubleshooting

### Common Issues

**Q: Getting 429 errors but queue appears empty**
- A: Check queue name is correct (`docflow-generate`)
- A: Verify storage account authentication (Managed Identity or Key)

**Q: Queue never processes despite accepting items**
- A: Check if `generatePDF` function is running (Azure Portal -> Functions)
- A: Look for errors in Application Insights

**Q: Rate limiting threshold seems wrong**
- A: Restart Azure Function to reload config from App Settings
- A: Verify `DOCFLOW_QUEUE_RATE_LIMIT_THRESHOLD` environment variable

### Debug Logging

Enable detailed logging:

```bash
# In Azure Portal: App Settings
AZURE_LOG_LEVEL=debug
DOCFLOW_DEBUG=true
```

Then check Application Insights for:
- `queue-depth-checked` events with depth values
- `queue-overloaded` warnings
- `queue-depth-check-failed` errors

## Files Modified

- `src/lib/queue.js` - New: Queue rate limiting module
- `src/functions/mondayWebhook/index.js` - Updated: Added rate limit check
- `src/lib/config.js` - Updated: Added rate limit threshold config
- `src/tests/queue.test.js` - New: Queue module tests
- `package.json` - Updated: Added @azure/storage-queue dependency
- `RATE_LIMITING.md` - New: This documentation

## References

- [Azure Storage Queue API Reference](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-queue/)
- [HTTP 429 Too Many Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429)
- [Retry-After Header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After)
- [DocFlow Architecture](./README.md)
