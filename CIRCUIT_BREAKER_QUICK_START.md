# Circuit Breaker Quick Start Guide

## TL;DR - What You Need to Know

1. **Circuit breaker prevents cascading failures** - when Adobe is down, you get fast errors instead of timeouts
2. **Zero code changes needed** - just import from `adobeWithBreaker` instead of `adobe`
3. **Health endpoint shows status** - `GET /api/health` tells you which services are down
4. **Manual recovery exists** - `POST /api/admin/breaker/adobe/reset` if needed

## Installation

Copy these files to your DocFlow repo:

```
src/lib/
  ├── circuitBreaker.js              (new)
  ├── apiClient.js                   (new)
  └── integrations/
      ├── circuitBreakerGuide.md     (new)
      ├── adobeWithBreaker.js        (new)
      ├── mondayWithBreaker.js       (new)
      └── sharepointWithBreaker.js   (new)

src/functions/health/
  └── circuitBreakerHealth.js        (new)

src/tests/
  └── circuitBreaker.test.js         (new)
```

## Option 1: Use Service Wrappers (Recommended)

### Before
```javascript
const adobe = require('../lib/adobe');
const monday = require('../lib/monday');
const sharepoint = require('../lib/sharepoint');

async function generateDocument(templateId, data) {
  const pdf = await adobe.createPDF(templateId, data);
  // ...
}
```

### After
```javascript
// Just change the import!
const adobe = require('../lib/integrations/adobeWithBreaker');
const monday = require('../lib/integrations/mondayWithBreaker');
const sharepoint = require('../lib/integrations/sharepointWithBreaker');

// Exact same code - calls now use circuit breaker automatically
async function generateDocument(templateId, data) {
  const pdf = await adobe.createPDF(templateId, data);
  // ...
}
```

**That's it.** All calls automatically:
- Check circuit breaker state (CLOSED/OPEN/HALF_OPEN)
- Fail fast if OPEN
- Use existing retry logic if CLOSED
- Update circuit breaker metrics

## Option 2: Use callApi() Wrapper for Custom Control

For finer control over individual calls:

```javascript
const { callApi } = require('../lib/apiClient');

async function generateDocument(templateId, data) {
  try {
    const pdf = await callApi('adobe', async () => {
      return adobe.createPDF(templateId, data);
    }, {
      label: 'pdf-generation',
      breakerOpts: {
        failureThreshold: 3,  // Strict: fail after 3 errors
        timeout: 30000,       // 30s before retrying
      },
    });
    return { success: true, pdf };
  } catch (err) {
    if (err.code === 'CIRCUIT_BREAKER_OPEN') {
      // Service is down - return user-friendly error
      const retryIn = Math.ceil((err.nextRetryTime - Date.now()) / 1000);
      return { 
        success: false, 
        error: `Service temporarily unavailable. Try again in ${retryIn}s` 
      };
    }
    throw err; // Other errors
  }
}
```

## Handling Circuit Breaker Errors

### In Functions

```javascript
async function sendDocument(docId) {
  try {
    await adobe.createEnvelope(pdf, signers);
  } catch (err) {
    if (err.code === 'CIRCUIT_BREAKER_OPEN') {
      // Circuit is OPEN - service is down
      // Option 1: Queue for later retry
      await queueForLater({ docId, retryAt: err.nextRetryTime });
      return { status: 'queued' };
      
      // Option 2: Fail immediately (user can retry)
      return { status: 'error', message: 'Adobe service temporarily unavailable' };
    }
    
    if (err.code === 'CIRCUIT_BREAKER_HALF_OPEN') {
      // Circuit is testing recovery - capacity exceeded
      return { status: 'error', message: 'Service recovering, please retry' };
    }
    
    // Regular error (timeout, network, etc.)
    throw err;
  }
}
```

### Return Appropriate HTTP Status Codes

```javascript
const { sendDocument } = require('./functions');

app.post('/documents/:id/send', async (req, res) => {
  try {
    const result = await sendDocument(req.params.id);
    
    if (result.code === 'CIRCUIT_BREAKER_OPEN') {
      // Service down - client can retry later
      res.status(503).json({ error: 'Service temporarily unavailable' });
    } else if (result.code === 'CIRCUIT_BREAKER_HALF_OPEN') {
      // Service recovering
      res.status(503).json({ error: 'Service recovering, try again in 5s' });
    } else if (result.success) {
      res.status(200).json({ message: 'Document sent' });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

## Monitoring & Observability

### Health Check Endpoint

Your existing `/health` endpoint can now include circuit breaker status:

```javascript
app.get('/health', async (req, res) => {
  const { getHealthStatus } = require('./lib/apiClient');
  const health = getHealthStatus();
  
  const statusCode = health.status === 'CRITICAL' ? 503 : 200;
  res.status(statusCode).json(health);
});
```

### Check Status Manually

```bash
# Get overall health
curl https://your-app/api/health

# Response:
{
  "status": "HEALTHY",
  "apis": [
    {
      "name": "adobe",
      "state": "CLOSED",
      "stats": { "totalCalls": 1000, "totalFailures": 5, "totalSuccesses": 995 }
    },
    {
      "name": "monday",
      "state": "CLOSED",
      "stats": { "totalCalls": 500, "totalFailures": 1, "totalSuccesses": 499 }
    }
  ]
}
```

### Monitor Logs for State Changes

Circuit breaker logs whenever state changes:

```
[INFO] circuit-state-change:adobe from CLOSED to OPEN
[WARN] circuit-open:adobe-pdf-create service=adobe
[INFO] circuit-state-change:adobe from OPEN to HALF_OPEN
[INFO] circuit-state-change:adobe from HALF_OPEN to CLOSED
```

Set up alerts on these patterns:
- `circuit-state-change.*OPEN` → page on-call
- `circuit-state-change.*:adobe` → high priority
- `circuit-state-change.*:monday` → normal priority

### Dashboard Metrics

Create dashboards tracking:

```
Success Rate (%) = (totalSuccesses / totalCalls) * 100
Rejection Rate   = rejectedByBreaker / totalCalls
State Histogram  = count of time in CLOSED vs OPEN vs HALF_OPEN
Recovery Time    = lastFailureTime → stateChange to CLOSED
```

## Testing

### Unit Test Your Circuit Breaker Integration

```javascript
test('handles circuit breaker open error', async () => {
  const { circuitBreakerManager } = require('../lib/apiClient');
  
  // Force circuit open
  const breaker = circuitBreakerManager.getBreaker('adobe');
  breaker.state = 'OPEN';
  breaker.nextRetryTime = Date.now() + 60000;
  
  // Should reject fast
  const start = Date.now();
  await expect(adobe.createPDF(...)).rejects.toThrow('CIRCUIT_BREAKER_OPEN');
  const duration = Date.now() - start;
  expect(duration).toBeLessThan(100); // < 100ms, not 3000ms
});
```

### Integration Test: Simulate Service Outage

```javascript
test('recovers when adobe service comes back online', async () => {
  const { circuitBreakerManager } = require('../lib/apiClient');
  
  // Simulate failures
  for (let i = 0; i < 5; i++) {
    await adobe.createPDF(...).catch(() => {});
  }
  
  // Circuit should be OPEN
  let breaker = circuitBreakerManager.getBreaker('adobe');
  expect(breaker.state).toBe('OPEN');
  
  // Wait for timeout
  await sleep(breaker.timeout + 100);
  
  // Service recovers - mock success
  mockAdobeService.success = true;
  
  // Circuit probes and recovers
  await adobe.createPDF(...); // Succeeds
  await adobe.createPDF(...); // Succeeds
  
  breaker = circuitBreakerManager.getBreaker('adobe');
  expect(breaker.state).toBe('CLOSED');
});
```

## Configuration Reference

### Default Thresholds by Service

| Service | Threshold | Timeout | Half-Open Capacity |
|---------|-----------|---------|-------------------|
| adobe | 3 | 30s | 1 |
| monday | 5 | 60s | 2 |
| sharepoint | 3 | 45s | 1 |

### Override Default Thresholds

```javascript
// For a specific call
await callApi('adobe', fn, {
  breakerOpts: {
    failureThreshold: 5,    // More lenient
    timeout: 60000,         // Longer wait
    halfOpenRequests: 2,
  },
});

// Permanently for service (only first use sets it)
circuitBreakerManager.getBreaker('adobe', {
  failureThreshold: 5,
  timeout: 60000,
});
```

## Common Scenarios

### Scenario 1: User Requests PDF, Adobe is Down

```
T=0:00   User clicks "Generate PDF"
T=0:03   3 failures accumulated
T=0:04   Circuit opens (state = OPEN)
T=0:05   User's browser: "Service temporarily unavailable"
         (instead of waiting 30 seconds)
T=0:30   Adobe service recovers
T=0:31   Circuit probes with 1 test request → succeeds
T=0:32   User retries → PDF generates successfully
```

### Scenario 2: Background Job Retries

```javascript
async function processDocumentQueue() {
  for (const doc of queue) {
    try {
      await adobe.createPDF(doc.templateId, doc.data);
    } catch (err) {
      if (err.code === 'CIRCUIT_BREAKER_OPEN') {
        // Put back in queue for later
        queue.push(doc);
        logger.info('queued-for-later', { docId: doc.id });
      } else {
        queue.fail(doc.id);
      }
    }
  }
}
```

### Scenario 3: Graceful Degradation

```javascript
async function getDocumentStatus(agreementId) {
  try {
    // Try to get live status
    return await adobe.getAgreementStatus(agreementId);
  } catch (err) {
    if (err.code === 'CIRCUIT_BREAKER_OPEN') {
      // Service down - return cached status
      return await cache.get(`status:${agreementId}`);
    }
    throw err;
  }
}
```

## Troubleshooting

### Circuit is OPEN but service is healthy

**Problem**: Circuit opened, but service is actually fine now.

**Solution**: Manually reset the circuit.
```bash
curl -X POST https://your-app/api/admin/breaker/adobe/reset
```

**Better solution**: Wait for automatic recovery (30-60s).

### Circuit keeps opening and closing (flaky service)

**Problem**: Service is intermittently failing; circuit opens, probe succeeds, but then fails again immediately.

**Solution**: Increase `failureThreshold` and `successThreshold`.
```javascript
circuitBreakerManager.getBreaker('adobe', {
  failureThreshold: 8,      // More tolerant
  successThreshold: 4,      // Need more proofs
  timeout: 120000,          // Longer wait
});
```

### Circuit never opens (service is bad)

**Problem**: You know the service is down, but circuit stays closed.

**Solution**: Decrease `failureThreshold`.
```javascript
circuitBreakerManager.getBreaker('adobe', {
  failureThreshold: 2,      // Fail faster
  timeout: 30000,
});
```

### Performance is slow

**Problem**: Requests are timing out even with circuit breaker.

**Diagnosis**: 
```bash
curl https://your-app/api/health
# Check if circuit is HALF_OPEN - means service is flaky
# Check if rejectedByBreaker > 0 - means you're getting fast failures
```

**Solution**: This might not be circuit breaker issue. Check:
- Is the external service actually slow?
- Is your retry timeout too long?
- Are you rate limited?

## Next Steps

1. **Deploy** the circuit breaker code
2. **Run tests**: `npm test -- circuitBreaker.test.js`
3. **Update imports** in your functions to use `adobeWithBreaker`, etc.
4. **Monitor** `/api/health` endpoint
5. **Tune thresholds** based on your actual failure patterns
6. **Document** in your runbook

---

**Questions?** See `CIRCUIT_BREAKER_ARCHITECTURE.md` for deep dive.
**Metrics reference?** See `circuitBreakerGuide.md` in integrations folder.
