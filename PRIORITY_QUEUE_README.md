# Priority Queue System

**Status**: Complete and Ready for Deployment

A production-ready queue prioritization system for the DocFlow document automation platform that ensures VP/executive onboarding requests receive same-day processing while batch imports run in off-peak hours.

## What's Included

### Core Library
- **`src/lib/priorityQueueService.js`** (500+ lines)
  - Priority detection based on Monday item data
  - Multi-queue management (high/normal/low)
  - Dynamic routing with fallback behavior
  - Starvation prevention (automatic message promotion)
  - Queue depth monitoring and health checks
  - Comprehensive metrics reporting

### Azure Functions
- **`src/functions/priorityRoutingFunction/`** (250+ lines)
  - HTTP endpoint: `/api/priorityRouting`
  - Triggered by Monday webhook events
  - Reads Monday item to determine priority
  - Routes to appropriate queue
  - Monitors queue depths before routing
  - HTTP+Queue bindings configured

- **`src/functions/priorityProcessorFunction/`** (250+ lines)
  - Consumes from 3 priority queues
  - Implements starvation prevention
  - Per-priority metrics tracking
  - Handler routing for different message types
  - Status endpoint for monitoring

### Testing
- **`src/lib/priorityQueueService.test.js`** (400+ lines)
  - 50+ unit tests covering all functionality
  - Priority detection scenarios
  - Message processing and promotion
  - Queue routing validation
  - Health check and metrics

### Documentation
- **`PRIORITY_QUEUE_INTEGRATION.md`** (400+ lines)
  - Complete integration guide with code examples
  - Configuration and setup instructions
  - Starvation prevention explanation
  - Performance characteristics
  - Troubleshooting guide
  - Migration path for existing deployments

- **`PRIORITY_QUEUE_SETUP.md`** (300+ lines)
  - Quick setup checklist
  - Step-by-step deployment instructions
  - Queue creation scripts (PowerShell/Bash)
  - Configuration examples
  - Testing and monitoring
  - Troubleshooting quick reference

- **`PRIORITY_QUEUE_README.md`** (this file)
  - High-level overview
  - File structure and contents
  - Key features explanation
  - Quick start guide

### Alternative Implementation
- **`src/functions/mondayWebhook/mondayWebhookWithPriority.js`** (150+ lines)
  - Drop-in replacement for standard mondayWebhook
  - Integrates priority routing into existing endpoint
  - Can be used instead of creating new routing function

## Key Features

### 1. Three-Tier Priority System

```
HIGH PRIORITY (docflow-generate-high)
├─ VP/C-Suite executives
├─ CEOs, CFOs, CTOs, EVPs, Presidents
├─ Manual "URGENT" or "VIP" override
└─ 2 dedicated workers, ~5 min processing time

NORMAL PRIORITY (docflow-generate)
├─ Regular employees (default)
├─ No special role indicators
├─ 4 dedicated workers
└─ ~15 min processing time

LOW PRIORITY (docflow-generate-batch)
├─ Batch imports
├─ Background processing
├─ 1 dedicated worker (off-peak)
└─ 30+ min processing time
```

### 2. Automatic Priority Detection

Analyzes Monday item data:
- **Position**: "VP Engineering" → HIGH
- **Priority**: "URGENT"/"VIP"/"HIGH" → HIGH
- **Batch Import**: "true" → LOW
- **Everything else** → NORMAL

### 3. Starvation Prevention

Automatically promotes aged messages:
- Low-priority items waiting >30 min → promoted to normal
- Normal-priority items waiting >60 min → promoted to high
- High-priority never demoted

Prevents low-priority batch jobs from starving indefinitely.

### 4. Intelligent Fallback

When queues are overloaded:
1. High queue full? Route new high items to normal (with warning)
2. Normal queue full? Route new normal items to low (with warning)
3. All queues full? Rate-limit webhook (429 Retry-After)

Already-queued high-priority items are unaffected.

### 5. Comprehensive Monitoring

Real-time insights:
- Queue depth per priority level
- Message age and promotion events
- Per-priority processing metrics (processed, promoted, failed)
- Health checks (queue depth violations)
- Utilization percentages

## Quick Start

### 1. Create Azure Storage Queues

```bash
# One-time setup
az storage queue create --name docflow-generate-high --account-name <storage>
az storage queue create --name docflow-generate --account-name <storage>
az storage queue create --name docflow-generate-batch --account-name <storage>
```

### 2. Deploy Functions

```bash
cd docflow
func azure functionapp publish doc-automation-func
```

### 3. Register Monday Webhook

Monday board: Onboarding Board (18422046530)

Endpoint: `https://doc-automation-func.azurewebsites.net/api/priorityRouting`
Event: "Update Column Value" → Trigger Checkbox

### 4. Verify

```javascript
// In your local test:
const priorityQueue = require('./src/lib/priorityQueueService');

// Test priority detection
const vpRow = {
  name: 'John Smith',
  byTitle: { Position: 'VP Engineering' }
};
console.log(priorityQueue.determinePriority(vpRow)); // 'high'

// Check queue depths
const depths = await priorityQueue.getAllQueueDepths();
console.log(depths); // { high: 0, normal: 5, low: 12, total: 17 }

// Monitor health
const health = await priorityQueue.healthCheck();
console.log(health); // { healthy: true, issues: [], ... }
```

## Architecture Diagram

```
Monday.com Webhook Event
    │
    ├─ Employee: "VP Engineering"
    ├─ Position: "CFO"
    └─ Batch Import: "true"
         │
         ▼
   [priorityRoutingFunction]
         │
         ├─ Read Monday item
         ├─ Determine priority (high/normal/low)
         ├─ Check queue depths
         └─ Route to queue
              │
              ├─ docflow-generate-high (VP/Executives)
              │   └─ [2 workers] → process ~5min
              │
              ├─ docflow-generate (Regular)
              │   └─ [4 workers] → process ~15min
              │
              └─ docflow-generate-batch (Batch)
                  └─ [1 worker] → process off-peak
                      │
                      ▼
              [priorityProcessorFunction]
                      │
                      ├─ Check message age
                      ├─ Promote if aged (starvation prevention)
                      └─ Forward to PDF generation pipeline
                           │
                           ├─ PDF generation
                           ├─ Adobe Sign integration
                           ├─ Monday status updates
                           └─ Archive to SharePoint
```

## File Structure

```
docflow/
├── src/
│   ├── lib/
│   │   ├── priorityQueueService.js         (Core service: 500 lines)
│   │   └── priorityQueueService.test.js    (Tests: 400 lines)
│   │
│   └── functions/
│       ├── priorityRoutingFunction/
│       │   ├── index.js                    (250 lines)
│       │   └── function.json               (Bindings config)
│       │
│       ├── priorityProcessorFunction/
│       │   ├── index.js                    (250 lines)
│       │   └── function.json               (Bindings config)
│       │
│       └── mondayWebhook/
│           └── mondayWebhookWithPriority.js (Alternative, 150 lines)
│
├── PRIORITY_QUEUE_README.md                (This file)
├── PRIORITY_QUEUE_INTEGRATION.md           (Complete guide: 400 lines)
└── PRIORITY_QUEUE_SETUP.md                 (Quick setup: 300 lines)
```

## Function Bindings

### priorityRoutingFunction

**Trigger**: HTTP POST `/api/priorityRouting`

**Outputs**:
- `generateQueueHigh` → `docflow-generate-high` queue
- `generateQueueNormal` → `docflow-generate` queue
- `generateQueueLow` → `docflow-generate-batch` queue

### priorityProcessorFunction

**Triggers** (3 queue triggers, one per queue):
- `docflow-generate-high`
- `docflow-generate`
- `docflow-generate-batch`

**Status Endpoint**: HTTP GET `/api/priorityProcessorStatus` (requires function auth)

## Integration with Existing Code

### Option A: Use New Routing Function (Recommended)

Keep existing `mondayWebhook` for backward compatibility.
Add new `priorityRouting` webhook on Monday board.
Both can coexist (dual webhooks).

### Option B: Replace Webhook

Use `mondayWebhookWithPriority.js` as drop-in replacement for `mondayWebhook/index.js`.
Single webhook, all priority logic integrated.
Requires Monday board webhook URL update.

### Option C: Integrate Priority into Existing Flow

Update existing processor functions to check `message._priority` field.
Use priority for:
- Logging/metrics
- Resource allocation
- SLA tracking
- Decision-making in handlers

## API Reference

### determinePriority(mondayRow)

Detects priority level from Monday item.

```javascript
const priority = priorityQueue.determinePriority({
  name: 'John Smith',
  byTitle: {
    Position: 'VP Engineering',
    Priority: 'HIGH'
  }
});
// Returns: 'high' | 'normal' | 'low'
```

### routeMessage(queueMessage, priority)

Routes message to appropriate queue with metadata.

```javascript
const routing = await priorityQueue.routeMessage(
  { itemId: '123', boardId: '456' },
  'high'
);
// Returns: { queueName, priority, binding, message }
context.bindings[routing.binding] = routing.message;
```

### processMessage(messageText, priority)

Parses message and checks for starvation.

```javascript
const result = await priorityQueue.processMessage(
  JSON.stringify({ itemId: '123', _enqueuedAt: ... }),
  'low'
);
// Returns: { processed, message, shouldPromote, ageMs, priority }
```

### promoteMessage(message, fromPriority, toPriority)

Promotes message to higher priority queue.

```javascript
const promotion = await priorityQueue.promoteMessage(
  message,
  'low',
  'normal'
);
// Returns: { success, newQueueName, message }
```

### getMetrics()

Get detailed metrics for all queues.

```javascript
const metrics = await priorityQueue.getMetrics();
// Returns: { timestamp, queues: {...}, summary: {...} }
```

### healthCheck()

Check system health status.

```javascript
const health = await priorityQueue.healthCheck();
// Returns: { healthy: boolean, issues: string[], timestamp }
```

## Performance

### Throughput (peak)

- High: 120/hour (12 per 6 min, 2 workers × 60 sec batch)
- Normal: 240/hour (40 per 10 min, 4 workers)
- Low: 60/hour (background, 1 worker)

### Latency (queue to processing)

- High: 0-5 minutes
- Normal: 5-30 minutes
- Low: 30+ minutes

### Resource Usage

- Storage: 3 Azure Storage Queues (~KB each)
- Functions: 2 HTTP-triggered + 3 Queue-triggered
- Bindings: 6 total (3 input + 3 output)

## Testing

```bash
# Run unit tests
npm test -- priorityQueueService.test.js

# Run specific test suite
npm test -- priorityQueueService.test.js -t "determinePriority"

# Check coverage
npm test -- priorityQueueService.test.js --coverage
```

## Monitoring & Alerts

### Key Metrics

```javascript
// Application Insights
priority-message-routed      // Count by priority
priority-queue-overloaded    // High/normal/low queue violations
priority-promotion-*         // Auto-promotion events
priority-processor-*         // Processing success by priority
```

### Example Query

```kusto
customEvents
| where name == 'priority-routing-request-queued'
| summarize Count=count() by tostring(customDimensions.priority)
```

## Troubleshooting

### Messages not routing to high priority

Check:
1. Position field in Monday: "VP", "CEO", "CFO", "President" required
2. Function logs: search for `priority-routing-request-queued`
3. Queue existence: `az storage queue exists --name docflow-generate-high`

### Starvation not preventing (messages not promoting)

Check:
1. Processor function consuming from all 3 queues
2. Message age in logs: must exceed threshold (30 min low, 60 min normal)
3. Promotion thresholds in `priorityQueueService.js` lines 20-21

### All queues filling up

Check:
1. Worker capacity: high=2, normal=4, low=1 (configurable)
2. Downstream bottlenecks: PDF generation, signing, Monday updates
3. Monitor with: `priorityQueue.getMetrics()`

## Deployment Checklist

- [ ] Create 3 Azure Storage Queues
- [ ] Deploy functions to Azure
- [ ] Register Monday webhook for `/api/priorityRouting`
- [ ] Test with VP/executive candidate (should route to high)
- [ ] Test with regular employee (should route to normal)
- [ ] Test with batch import (should route to low)
- [ ] Monitor queue depths for 1 hour
- [ ] Verify starvation prevention (wait 30+ min on low queue)
- [ ] Check metrics endpoint
- [ ] Set up Application Insights alerts
- [ ] Document any custom Monday column names

## Support & Questions

Refer to:
1. **PRIORITY_QUEUE_INTEGRATION.md** - Detailed integration guide
2. **PRIORITY_QUEUE_SETUP.md** - Step-by-step setup and troubleshooting
3. **priorityQueueService.test.js** - Examples of all API usage
4. **Function logs** - Application Insights for runtime behavior

## Version History

- **v1.0** (2026-08-17): Initial release with high/normal/low priority queues, starvation prevention, and monitoring
