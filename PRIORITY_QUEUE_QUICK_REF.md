# Priority Queue Quick Reference Card

## Priority Levels

| Priority | Queue Name | Workers | TTL | When | Worker Speed |
|----------|-----------|---------|-----|------|--------------|
| **HIGH** | docflow-generate-high | 2 | 60m | VP/CEO/executives | ~5 min/item |
| **NORMAL** | docflow-generate | 4 | 8h | Regular employees | ~15 min/item |
| **LOW** | docflow-generate-batch | 1 | 24h | Batch imports | 30+ min/item |

## Priority Detection Rules

```javascript
Priority = HIGH if:
  - Position contains: "VP", "CEO", "CFO", "CTO", "CIO", "EVP", "President"
  - OR Priority column = "HIGH" | "URGENT" | "VIP"

Priority = LOW if:
  - Batch Import column = "true"

Priority = NORMAL (default)
  - Everything else
```

## Starvation Prevention

| From | To | After | Auto-Action |
|------|-----|-------|------------|
| LOW | NORMAL | 30 min | Promote if still pending |
| NORMAL | HIGH | 60 min | Promote if still pending |
| HIGH | — | ∞ | Never demote |

## File Locations

```
Core Library
  src/lib/priorityQueueService.js          (500 lines, all logic)

Functions
  src/functions/priorityRoutingFunction/   (Routes messages)
  src/functions/priorityProcessorFunction/ (Processes by priority)

Tests
  src/lib/priorityQueueService.test.js     (50+ tests)

Docs
  PRIORITY_QUEUE_README.md                 (Overview)
  PRIORITY_QUEUE_INTEGRATION.md            (Complete guide)
  PRIORITY_QUEUE_SETUP.md                  (Setup steps)
  PRIORITY_QUEUE_QUICK_REF.md             (This file)
```

## Setup Checklist

```bash
# 1. Create queues
az storage queue create --name docflow-generate-high --account-name <storage>
az storage queue create --name docflow-generate --account-name <storage>
az storage queue create --name docflow-generate-batch --account-name <storage>

# 2. Deploy
func azure functionapp publish doc-automation-func

# 3. Register webhook in Monday
URL: https://doc-automation-func.azurewebsites.net/api/priorityRouting
Event: Update Column Value → Trigger Checkbox

# 4. Test
curl -X POST https://doc-automation-func.azurewebsites.net/api/priorityRouting \
  -H "Content-Type: application/json" \
  -d '{"challenge":"test123"}'
```

## Code Examples

### Detect Priority

```javascript
const priorityQueue = require('./lib/priorityQueueService');
const priority = priorityQueue.determinePriority(mondayRow);
// 'high' | 'normal' | 'low'
```

### Route Message

```javascript
const routing = await priorityQueue.routeMessage(queueMessage, 'high');
context.bindings[routing.binding] = routing.message;
// binding: "generateQueueHigh"
// queueName: "docflow-generate-high"
```

### Check Promotion

```javascript
const result = await priorityQueue.processMessage(messageText, 'low');
if (result.shouldPromote) {
  const promotion = await priorityQueue.promoteMessage(
    result.message,
    'low',
    'normal'
  );
  context.bindings.generateQueueNormal = promotion.message;
}
```

### Monitor

```javascript
const metrics = await priorityQueue.getMetrics();
// metrics.summary: { total, highPriority, normalPriority, lowPriority }

const health = await priorityQueue.healthCheck();
// health: { healthy: boolean, issues: [] }

const depths = await priorityQueue.getAllQueueDepths();
// depths: { high: 5, normal: 120, low: 340, total: 465 }
```

## Queue Names

```javascript
const QUEUE_CONFIG = {
  high: {
    name: 'docflow-generate-high',
    binding: 'generateQueueHigh'
  },
  normal: {
    name: 'docflow-generate',
    binding: 'generateQueueNormal'
  },
  low: {
    name: 'docflow-generate-batch',
    binding: 'generateQueueLow'
  }
};
```

## API Surface

### Service Functions

| Function | Parameters | Returns |
|----------|-----------|---------|
| `determinePriority(row)` | Monday row | 'high'\|'normal'\|'low' |
| `routeMessage(msg, priority)` | message, priority | routing info |
| `processMessage(text, priority)` | JSON, priority | parsed + promotion check |
| `promoteMessage(msg, from, to)` | message, priorities | promoted message |
| `getAllQueueDepths()` | — | {high, normal, low, total} |
| `getMetrics()` | — | detailed metrics |
| `healthCheck()` | — | {healthy, issues, timestamp} |

### Function Endpoints

| Endpoint | Method | Purpose | Returns |
|----------|--------|---------|---------|
| `/api/priorityRouting` | POST | Receive Monday webhook | 200 queued |
| `/api/priorityProcessorStatus` | GET | Get processor metrics | Status + metrics |

## Monitoring

### Application Insights Events

```
priority-routing-request-queued        (Every request)
  - itemId, boardId, priority, employee, position, eventType

priority-queue-overloaded              (When queue full)
  - priority, depth, threshold, utilization%

priority-promotion-low-to-normal       (Starvation prevention)
priority-promotion-normal-to-high      (Starvation prevention)
  - itemId, ageMinutes

priority-processor-message-processed   (Success)
  - itemId, priority, handler, processingTimeMs
```

### Key Metrics

```javascript
// Per-priority metrics
processorMetrics = {
  high: { processed: 0, promoted: 0, failed: 0 },
  normal: { processed: 0, promoted: 0, failed: 0 },
  low: { processed: 0, promoted: 0, failed: 0 }
};

// Queue depths
depths = {
  high: 5,      // Should be <50
  normal: 120,  // Should be <500
  low: 340,     // Should be <1000
  total: 465
};
```

## Troubleshooting

| Problem | Diagnosis | Solution |
|---------|-----------|----------|
| Not routing to HIGH | Position not "VP"/"CEO" | Add position to Monday item |
| Queue filling up | Slow downstream | Add workers or fix bottleneck |
| Messages not promoting | Age not exceeding threshold | Wait 30min (low) or 60min (normal) |
| Overload warnings | Too many messages | Rate-limit at webhook level |
| Wrong queue created | Name mismatch | Delete and recreate with correct name |

## Performance Targets

```
HIGH PRIORITY:
  - Time to processing: 0-5 minutes
  - Throughput: 12+ per 6 minutes
  - Queue limit: <50 before alert

NORMAL PRIORITY:
  - Time to processing: 5-30 minutes
  - Throughput: 40+ per 10 minutes
  - Queue limit: <500 before alert

LOW PRIORITY:
  - Time to processing: 30+ minutes
  - Throughput: 10+ per hour
  - Queue limit: <1000 before alert
```

## Configuration

### Priority Detection Keywords

```javascript
// In priorityQueueService.js, line 95-103:
/^(vp|vice president|ceo|cfo|cto|coo|evp|executive vice|president|chief)/i

// Add more keywords to detect additional roles:
"CEO", "CFO", "CTO", "VP", "EVP", "President", "Chief"
```

### Promotion Thresholds

```javascript
// In priorityQueueService.js, lines 20-21:
lowToNormal: 30 * 60 * 1000,    // 30 minutes
normalToHigh: 60 * 60 * 1000,   // 60 minutes
```

### Queue Limits

```javascript
// isPriorityOverloaded checks these thresholds:
high: 50     // Alert if >50 pending
normal: 500  // Alert if >500 pending
low: 1000    // Alert if >1000 pending
```

## Testing Commands

```bash
# Unit tests
npm test -- priorityQueueService.test.js

# Check specific test
npm test -- priorityQueueService.test.js -t "detects VP as high priority"

# Integration test (local)
node -e "
const pq = require('./src/lib/priorityQueueService');
console.log(pq.determinePriority({
  name: 'John',
  byTitle: { Position: 'VP' }
}));
"

# Check queue in Azure
az storage queue exists --name docflow-generate-high --account-name <storage>
```

## Monday Column Names

These columns are read from Monday (case-sensitive):

```
- Position              (Text field, e.g., "VP Engineering")
- Priority             (Dropdown, e.g., "HIGH", "URGENT", "VIP")
- Batch Import        (Checkbox, any value = low priority)
- Trigger             (Checkbox, checked = process)
```

If your columns have different names, update `determinePriority()` function.

## Related Docs

- Full integration guide: `PRIORITY_QUEUE_INTEGRATION.md`
- Step-by-step setup: `PRIORITY_QUEUE_SETUP.md`
- Architecture overview: `PRIORITY_QUEUE_README.md`
- Test examples: `src/lib/priorityQueueService.test.js`

---

**Last Updated**: 2026-08-17  
**Version**: 1.0  
**Status**: Production Ready
