# Priority Queue System Integration Guide

## Overview

The priority queue system provides tiered processing for onboarding requests based on employee type and business criticality:

- **HIGH**: VP/executive hires (same-day processing, 2 dedicated workers)
- **NORMAL**: Regular employees (standard timeline, 4 dedicated workers)
- **LOW**: Batch imports (background processing, 1 dedicated worker)

## Architecture

```
Monday.com Event
    ↓
[priorityRoutingFunction]
    ├─→ Read Monday item
    ├─→ Determine priority level
    ├─→ Check queue depths
    └─→ Route to appropriate queue
         ├─→ docflow-generate-high (VP/executives)
         ├─→ docflow-generate (regular)
         └─→ docflow-generate-batch (batch imports)
            ↓
    [priorityProcessorFunction] (per-priority workers)
         ├─→ Process high-priority (2 workers, ~5min TtP)
         ├─→ Process normal-priority (4 workers, ~15min TtP)
         └─→ Process low-priority (1 worker, off-peak)
            ├─→ Check for starvation (auto-promote old items)
            └─→ Forward to PDF generation pipeline
```

## Configuration

### Environment Variables

No new required env vars, but these optional values control behavior:

```bash
# Priority queue configuration (optional)
PRIORITY_QUEUE_ENABLED=true                    # Enable priority routing (default: true)
PRIORITY_AUTO_PROMOTE_LOW_MINUTES=30           # Promote low→normal after 30 min (default: 30)
PRIORITY_AUTO_PROMOTE_NORMAL_MINUTES=60        # Promote normal→high after 60 min (default: 60)
PRIORITY_QUEUE_DEPTH_THRESHOLD_HIGH=50         # Alert if high queue > 50 (default: 50)
PRIORITY_QUEUE_DEPTH_THRESHOLD_NORMAL=500      # Alert if normal queue > 500 (default: 500)
PRIORITY_QUEUE_DEPTH_THRESHOLD_LOW=1000        # Alert if low queue > 1000 (default: 1000)
```

### Monday Column Configuration

The system uses existing Monday columns to determine priority:

```javascript
// In your Monday onboarding board:
"Position"              // Values like "VP Engineering", "CEO", etc. trigger HIGH priority
"Priority" (optional)   // If set to "HIGH", "URGENT", or "VIP" → HIGH priority
"Batch Import" (opt)    // If "true" → LOW priority
```

## Integration with Existing Code

### 1. Add Queue Infrastructure

Azure Storage queues must be created (one-time setup):

```bash
# Create priority queues
az storage queue create --name docflow-generate-high --account-name <storage-account>
az storage queue create --name docflow-generate --account-name <storage-account>
az storage queue create --name docflow-generate-batch --account-name <storage-account>

# These are used alongside existing docflow-generate queue
```

### 2. Register New Functions in Azure

Add the new functions to your `host.json` or function app configuration:

```json
{
  "version": "2.0",
  "logging": {
    "applicationInsights": {
      "samplingSettings": {
        "isEnabled": true,
        "maxTelemetryItemsPerSecond": 20
      }
    }
  },
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
```

### 3. Update Monday Webhook Registration

Register the new routing endpoint:

```javascript
// Replace or supplement existing webhook with:
// Endpoint: https://doc-automation-func.azurewebsites.net/api/priorityRouting
// Event: Update Column Value → Trigger Checkbox
```

Alternatively, keep both endpoints:
- `mondayWebhook`: Direct to docflow-generate (fallback/compatibility)
- `priorityRouting`: Routes to priority queues (recommended)

### 4. Update Downstream Processors

Existing PDF generation functions can remain unchanged. They'll receive messages from all three queues:

```javascript
// In functions like generatePDF/index.js:
// The message will include: { ..., _priority: "high|normal|low" }
// Use this for logging/metrics but process the same way

async function processPdfGeneration(context, queueItem) {
  const priority = queueItem._priority || 'normal';
  logger.event('pdf-generation-started', { priority, itemId: queueItem.itemId });
  // ... existing PDF generation code ...
}
```

## Usage Examples

### Determining Priority

The system automatically detects priority based on Monday data:

```javascript
const priorityQueue = require('./lib/priorityQueueService');

// Read Monday item
const mondayRow = await monday.readRow(boardId, itemId);

// Determine priority
const priority = priorityQueue.determinePriority(mondayRow);
// Returns: 'high', 'normal', or 'low'

// Examples:
mondayRow.byTitle.Position = 'VP Engineering'      → 'high'
mondayRow.byTitle.Position = 'CEO'                  → 'high'
mondayRow.byTitle.Position = 'Software Engineer'    → 'normal'
mondayRow.byTitle['Batch Import'] = 'true'         → 'low'
mondayRow.byTitle.Priority = 'URGENT'              → 'high'
```

### Routing Messages

```javascript
const priorityQueue = require('./lib/priorityQueueService');

// Route a message to the appropriate queue
const message = {
  boardId: '18422046530',
  itemId: '123456789',
  employee: 'John Smith',
  eventType: 'update_column_value',
  receivedAt: new Date().toISOString()
};

const routing = await priorityQueue.routeMessage(message, 'high');
// Returns:
// {
//   queueName: 'docflow-generate-high',
//   priority: 'high',
//   binding: 'generateQueueHigh',
//   message: JSON.stringified message with metadata
// }

// In Azure Function:
context.bindings[routing.binding] = routing.message;
```

### Processing with Priority Awareness

```javascript
const priorityQueue = require('./lib/priorityQueueService');

// In a processor function
async function processQueueItem(context, queueItem) {
  const priority = queueItem._priority || 'normal';
  const ageMs = Date.now() - new Date(queueItem._enqueuedAt).getTime();

  // Check if should be promoted (starvation prevention)
  if (priority === 'low' && ageMs > 30 * 60 * 1000) {
    // Promote to normal queue
    const promotion = await priorityQueue.promoteMessage(
      queueItem,
      'low',
      'normal'
    );
    context.bindings.generateQueueNormal = promotion.message;
    return; // Don't process yet, let higher queue handle it
  }

  // Process the item normally
  // ... existing PDF generation, signing, etc ...
}
```

### Monitoring Queue Health

```javascript
const priorityQueue = require('./lib/priorityQueueService');

// Get all queue depths
const depths = await priorityQueue.getAllQueueDepths();
// {
//   high: 5,
//   normal: 120,
//   low: 340,
//   total: 465
// }

// Get detailed metrics
const metrics = await priorityQueue.getMetrics();
// Returns queue utilization, TTL info, worker counts, etc.

// Check health
const health = await priorityQueue.healthCheck();
// {
//   healthy: true,
//   issues: [],
//   timestamp: '2026-08-17T20:30:00.000Z'
// }

// Check if a specific queue is overloaded
const { overloaded, depth } = await priorityQueue.isPriorityOverloaded('normal', 500);
if (overloaded) {
  logger.warn('Normal queue overloaded', { depth });
}
```

## Starvation Prevention

The system automatically promotes aged messages to prevent starvation:

- **Low → Normal**: After 30 minutes in low queue
- **Normal → High**: After 60 minutes in normal queue

When a message is promoted:
1. Logged with promotion event
2. Re-enqueued to higher priority queue
3. Original queue message expires/discarded
4. Metadata tracks promotion history

```javascript
// Message promoted from low to normal might look like:
{
  boardId: '18422046530',
  itemId: '987654',
  employee: 'Jane Doe',
  _priority: 'normal',           // New priority
  _enqueuedAt: '2026-08-17T19:00:00.000Z',  // Original enqueue time
  _promotedAt: '2026-08-17T19:30:00.000Z',  // Promotion timestamp
  _promotedFrom: 'low',          // Where it came from
}
```

## Performance Characteristics

### Throughput (messages/min by priority)

- **High**: ~6/min (30sec TTaP × 2 workers)
- **Normal**: ~16/min (15sec TTaP × 4 workers)
- **Low**: ~2/min (background, 1 worker)

### Latency (time to first processing)

- **High**: 0-5 minutes (immediate when workers available)
- **Normal**: 5-30 minutes (standard processing window)
- **Low**: 30+ minutes (background/off-peak)

### Queue Limits & Alerts

Queue depths trigger warnings at:

```javascript
const LIMITS = {
  high: 50,    // VP queue shouldn't exceed 50 pending
  normal: 500, // Normal processing capacity is ~500
  low: 1000,   // Batch queue can hold 1000+
};
```

## Fallback Behavior

If a queue becomes overloaded:

1. **High queue full** → Route new high-priority to normal queue (with fallback warning)
2. **Normal queue full** → Route new normal-priority to low queue (with warning)
3. **Low queue full** → Rate limit webhook response (429 Retry-After)

This ensures system stability while maintaining priority ordering for already-queued items.

## Monitoring & Alerts

### Key Metrics to Track

```javascript
// In Application Insights or logging:
- priority-message-routed: How many by each priority
- priority-queue-overloaded: Queue depth violations
- priority-promotion-*: Messages being auto-promoted
- priority-processor-*: Processing success rate by priority
```

### Sample Logging

Every routing decision logs:

```
{
  event: 'priority-routing-request-queued',
  itemId: '123456',
  priority: 'high',
  employee: 'John Smith',
  position: 'VP Engineering',
  queueDepths: {
    high: 3,
    normal: 120,
    low: 450,
    total: 573
  }
}
```

## Testing

### Unit Tests (Jest)

```javascript
const priorityQueue = require('./lib/priorityQueueService');

describe('priorityQueueService', () => {
  test('detects VP as high priority', () => {
    const row = {
      name: 'John Smith',
      byTitle: { Position: 'VP Engineering' }
    };
    expect(priorityQueue.determinePriority(row)).toBe('high');
  });

  test('detects batch imports as low priority', () => {
    const row = {
      name: 'Batch Import',
      byTitle: { 'Batch Import': 'true' }
    };
    expect(priorityQueue.determinePriority(row)).toBe('low');
  });

  test('defaults to normal priority', () => {
    const row = {
      name: 'Jane Doe',
      byTitle: { Position: 'Software Engineer' }
    };
    expect(priorityQueue.determinePriority(row)).toBe('normal');
  });

  test('promotes low messages after timeout', async () => {
    const oldMessage = {
      itemId: '123',
      _enqueuedAt: new Date(Date.now() - 40 * 60000).toISOString()
    };
    const result = await priorityQueue.processMessage(JSON.stringify(oldMessage), 'low');
    expect(result.shouldPromote).toBe(true);
  });
});
```

### Integration Test

```javascript
async function testPriorityFlow() {
  // 1. Test high-priority routing
  const vpRow = {
    name: 'VP Candidate',
    byTitle: { Position: 'VP Sales' }
  };
  const vpPriority = priorityQueue.determinePriority(vpRow);
  assert.equal(vpPriority, 'high');

  // 2. Test routing
  const message = { boardId: '123', itemId: '456', employee: 'VP Candidate' };
  const routing = await priorityQueue.routeMessage(message, vpPriority);
  assert.equal(routing.queueName, 'docflow-generate-high');

  // 3. Test queue depth
  const depth = await priorityQueue.getQueueDepth('high');
  assert.ok(typeof depth === 'number');

  // 4. Test health check
  const health = await priorityQueue.healthCheck();
  assert.ok('healthy' in health);
}
```

## Migration Path

### For Existing Deployments

1. **Deploy new functions first** (non-breaking):
   ```bash
   func azure functionapp publish doc-automation-func
   ```

2. **Create new queues**:
   ```bash
   az storage queue create --name docflow-generate-high --account-name <storage>
   az storage queue create --name docflow-generate-batch --account-name <storage>
   ```

3. **Keep existing webhook active** (backward compatible):
   - `mondayWebhook` → docflow-generate (normal priority)
   - New: `priorityRouting` → routed by priority

4. **Test in parallel** (optional, gradual):
   - Register new webhook on test board first
   - Verify routing works as expected
   - Gradually roll out to production board

5. **Switch webhook registration** (when ready):
   - Update Monday.com board webhook to new endpoint
   - Monitor for issues
   - Remove old webhook

### Zero-Downtime Deployment

The system supports running both webhooks simultaneously:

```
mondayWebhook     → docflow-generate (backward compat, always normal)
priorityRouting   → routed by priority (new feature)
```

This allows gradual rollout with no impact to existing onboarding.

## Troubleshooting

### High queue not being processed

Check:
1. Function app has high-priority queue trigger enabled
2. `docflow-generate-high` queue exists in storage
3. Messages routing to high queue (`priorityQueueHigh` binding)
4. Worker function has enough capacity (2 dedicated)

### Messages not being promoted

Check:
1. Promotion timestamps in messages (`_enqueuedAt`)
2. Promotion threshold config (30 min for low→normal)
3. Processor function checking `shouldPromote` flag
4. Re-enqueue binding to higher priority queue

### Queue overload despite prioritization

Check:
1. Worker capacity matches expected throughput
2. Add more workers or increase concurrency
3. Implement rate limiting at webhook level
4. Check downstream bottlenecks (PDF generation, signing)

## Future Enhancements

- [ ] Dynamic priority adjustment based on queue depth
- [ ] Machine learning-based ETA prediction
- [ ] SLA tracking (VP hires should complete within X hours)
- [ ] Priority override capability (HR can manually bump priority)
- [ ] Dashboard widget showing queue depths by priority
- [ ] Alerts when queue SLA at risk (e.g., 45 min old)
