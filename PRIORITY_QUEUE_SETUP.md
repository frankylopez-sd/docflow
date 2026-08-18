# Priority Queue System - Quick Setup

## Files Created

1. **Library Service** (`src/lib/priorityQueueService.js`)
   - Core queue prioritization logic
   - Priority detection based on Monday data
   - Queue management (depth, health, promotion)
   - Starvation prevention

2. **Routing Function** (`src/functions/priorityRoutingFunction/index.js`)
   - HTTP endpoint: `/api/priorityRouting`
   - Triggered by Monday webhook
   - Reads item from Monday
   - Routes to appropriate priority queue
   - Monitors queue depths

3. **Processor Function** (`src/functions/priorityProcessorFunction/index.js`)
   - Consumes from 3 priority queues
   - Processes high-priority first (VP/executives)
   - Normal priority (standard)
   - Low priority (batch/background)
   - Implements starvation prevention

4. **Azure Bindings** (function.json files)
   - Routing function: 3 output bindings (high/normal/low queues)
   - Processor function: 3 input triggers (one per queue)

5. **Integration Documentation** (PRIORITY_QUEUE_INTEGRATION.md)
   - Complete usage guide
   - Examples and code snippets
   - Monitoring and troubleshooting
   - Migration path for existing deployments

## Step-by-Step Setup

### 1. Create Azure Storage Queues

```powershell
# Set variables
$storageAccount = "yourstorageaccount"
$resourceGroup = "your-resource-group"

# Get storage account key
$key = (Get-AzStorageAccountKey -ResourceGroupName $resourceGroup -Name $storageAccount)[0].Value

# Create context
$ctx = New-AzStorageContext -StorageAccountName $storageAccount -StorageAccountKey $key

# Create priority queues
New-AzStorageQueue -Name "docflow-generate-high" -Context $ctx
New-AzStorageQueue -Name "docflow-generate" -Context $ctx
New-AzStorageQueue -Name "docflow-generate-batch" -Context $ctx

# Verify
Get-AzStorageQueue -Context $ctx | Select-Object Name
```

Or via Azure CLI:

```bash
# Set variables
STORAGE_ACCOUNT="yourstorageaccount"
RESOURCE_GROUP="your-resource-group"

# Create queues
az storage queue create --name docflow-generate-high --account-name $STORAGE_ACCOUNT --resource-group $RESOURCE_GROUP
az storage queue create --name docflow-generate --account-name $STORAGE_ACCOUNT --resource-group $RESOURCE_GROUP
az storage queue create --name docflow-generate-batch --account-name $STORAGE_ACCOUNT --resource-group $RESOURCE_GROUP

# Verify
az storage queue list --account-name $STORAGE_ACCOUNT
```

### 2. Deploy Functions to Azure

```bash
# From the docflow project root
cd src/functions

# Deploy using Azure Functions Core Tools
func azure functionapp publish doc-automation-func

# Or use GitHub Actions (recommended for CI/CD)
git push origin main  # Triggers CI/CD pipeline
```

### 3. Register New Webhook in Monday.com

Monday board: Onboarding Board (ID: 18422046530)

**Option A: Replace existing webhook** (breaking change)
- Remove old webhook registration for `mondayWebhook`
- Add new webhook for `priorityRouting`
- Endpoint: `https://doc-automation-func.azurewebsites.net/api/priorityRouting`

**Option B: Add alongside existing** (recommended for gradual rollout)
- Keep `mondayWebhook` for backward compatibility
- Add new `priorityRouting` webhook
- Both can coexist (one sends to default queue, other routes by priority)

Steps in Monday.com:
1. Go to Workspace Settings → Integrations → Webhooks
2. Click "Create Webhook"
3. Name: "DocFlow Priority Routing"
4. Event: "Update Column Value" or "Change Column Value"
5. Column: "Trigger" (your checkbox column)
6. URL: `https://doc-automation-func.azurewebsites.net/api/priorityRouting`
7. Save

### 4. Configure Monday Columns

Ensure your Monday onboarding board has these columns (used for priority detection):

```
- Position (text): Job title/role
- Priority (optional dropdown): "HIGH", "NORMAL", "LOW", "URGENT", "VIP"
- Batch Import (optional checkbox): Mark items for low-priority processing
```

### 5. Verify Setup

```bash
# Check queue creation
az storage queue list --account-name $STORAGE_ACCOUNT \
  | grep -E "docflow-generate"

# Test priority routing (HTTP POST)
curl -X POST https://doc-automation-func.azurewebsites.net/api/health

# Check function logs
func azure functionapp logstream doc-automation-func

# Monitor queue depths
az storage queue metadata show \
  --name docflow-generate-high \
  --account-name $STORAGE_ACCOUNT
```

## Configuration Examples

### Environment Variables (optional)

Add these to your Azure Function App Settings (or .env locally):

```bash
PRIORITY_QUEUE_ENABLED=true
PRIORITY_AUTO_PROMOTE_LOW_MINUTES=30
PRIORITY_AUTO_PROMOTE_NORMAL_MINUTES=60
```

### Monday Board Column Mapping

If your columns have different names, update priorityQueueService.js line 95-103:

```javascript
function determinePriority(mondayRow = {}) {
  const { byTitle = {} } = mondayRow;

  // Customize these field names to match your board:
  const position = (byTitle['Your Position Column'] || '').toLowerCase();
  const priorityOverride = (byTitle['Your Priority Column'] || '').toLowerCase();
  const isBatch = (byTitle['Your Batch Column'] || '').toLowerCase() === 'true';

  // ... rest of logic
}
```

## Testing Priority Detection

Test priority logic locally:

```javascript
// test-priority.js
const priorityQueue = require('./src/lib/priorityQueueService');

// Test cases
const testCases = [
  {
    name: 'VP Detection',
    row: {
      name: 'John Smith',
      byTitle: { Position: 'VP Engineering' }
    },
    expected: 'high'
  },
  {
    name: 'CEO Detection',
    row: {
      name: 'Jane Doe',
      byTitle: { Position: 'Chief Executive Officer' }
    },
    expected: 'high'
  },
  {
    name: 'Regular Employee',
    row: {
      name: 'Bob Jones',
      byTitle: { Position: 'Software Engineer' }
    },
    expected: 'normal'
  },
  {
    name: 'Batch Import',
    row: {
      name: 'Batch',
      byTitle: { 'Batch Import': 'true' }
    },
    expected: 'low'
  },
  {
    name: 'Priority Override',
    row: {
      name: 'Special Case',
      byTitle: { Priority: 'URGENT' }
    },
    expected: 'high'
  }
];

console.log('Testing Priority Detection:\n');
testCases.forEach(test => {
  const result = priorityQueue.determinePriority(test.row);
  const pass = result === test.expected;
  console.log(`${pass ? '✓' : '✗'} ${test.name}`);
  if (!pass) console.log(`  Expected: ${test.expected}, Got: ${result}`);
});
```

Run it:
```bash
node test-priority.js
```

## Monitoring Dashboard

Create an Application Insights query to monitor priority queues:

```kusto
customEvents
| where name in ('priority-message-routed', 'priority-queue-overloaded', 'priority-promotion-low-to-normal')
| summarize Count=count() by tostring(customDimensions.priority)
| project Priority=Priority, MessageCount=Count
| union (
    customEvents
    | where name == 'priority-routing-request-queued'
    | summarize Total=count()
    | project Priority='TOTAL', MessageCount=Total
  )
```

## Troubleshooting

### Queue not created

```bash
# Verify storage account
az storage account list --query "[].name"

# Check if queue exists
az storage queue exists --name docflow-generate-high --account-name $STORAGE_ACCOUNT

# If missing, create it
az storage queue create --name docflow-generate-high --account-name $STORAGE_ACCOUNT
```

### Messages not routing to correct queue

Check:
1. Monday webhook is hitting correct endpoint (`/api/priorityRouting`)
2. Monday board has "Position" or "Priority" column populated
3. Function logs show priority detection: search for `priority-routing-request-queued`
4. Message format is valid JSON

### Priority detection not working

Check position values in Monday:
- Must contain keywords like "VP", "CEO", "EVP", "President"
- Case-insensitive matching (e.g., "vp" works)
- Full title required (e.g., "Vice President")

```javascript
// These trigger HIGH priority:
'VP Engineering'
'Chief Financial Officer'
'Executive Vice President'
'Vice President of Sales'
'CEO'
'President'

// These do NOT (case/keyword must match):
'Senior Vice President' // ✓ matches
'Vice President' // ✓ matches
'VP of Operations' // ✓ matches
'Senior Engineer' // ✗ no match
'Manager' // ✗ no match
```

### Messages not being promoted

Check processor function logs for:
- `priority-promotion-low-to-normal`
- `priority-promotion-normal-to-high`

If not appearing:
1. Verify `PROMOTION_THRESHOLDS` in priorityQueueService.js
2. Check message age: must exceed 30min (low) or 60min (normal)
3. Ensure processor is consuming from all 3 queues

## Next Steps

1. ✓ Create Azure storage queues
2. ✓ Deploy functions to Azure
3. ✓ Register Monday webhook
4. ✓ Test with a sample hire
5. Monitor queue depths and processing times
6. Adjust worker counts if needed (high: 2, normal: 4, low: 1)
7. Create dashboard for queue health

## Performance Targets

Once configured, you should see:

- **High priority**: 0-5 min to processing (immediate)
- **Normal priority**: 5-30 min to processing (standard)
- **Low priority**: 30+ min to processing (background)
- **Queue depths**: High <50, Normal <500, Low <1000

If not meeting targets, check function app scaling and worker allocation.

## Support

For issues:
1. Check function logs: `func azure functionapp logstream doc-automation-func`
2. Check Application Insights for errors
3. Review PRIORITY_QUEUE_INTEGRATION.md troubleshooting section
4. Verify Monday webhook events are arriving
