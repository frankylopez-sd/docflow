# Circuit Breaker Pattern Guide for DocFlow

## Overview

A **circuit breaker** prevents cascading failures by stopping requests to services that are repeatedly failing. Instead of hammering a downed service with retries, it:

1. **Counts failures** (e.g., 5 failures in a row)
2. **Opens the circuit** (stops sending requests, fails fast)
3. **Waits a timeout** (60s by default)
4. **Tests recovery** (enters HALF_OPEN, allows limited requests)
5. **Closes or reopens** based on recovery success

## States

```
CLOSED (normal)
   ↓ (failures accumulate)
OPEN (failing, reject all)
   ↓ (after timeout)
HALF_OPEN (testing recovery)
   ↓ (success)
CLOSED (recovered!)
```

## When to Fail Fast vs. Retry

### Fail Fast (Strict Threshold)
- **Adobe token refresh**: Auth service down → fail immediately
- **SharePoint token acquisition**: Token server down → everything fails
- **Critical path operations**: User is waiting (generatePDF, createEnvelope)

**Settings**: `failureThreshold: 3`, `timeout: 30000`

### Tolerate Longer Retry Window (Relaxed Threshold)
- **Status polling**: Non-blocking, can wait longer
- **Batch updates**: Low priority, scheduled tasks
- **Monday.com operations**: Resilient API, generous rate limits

**Settings**: `failureThreshold: 5`, `timeout: 60000`

## Per-Service Guidance

### Adobe (PDF Services + Sign)

| Operation | Threshold | Timeout | Why |
|-----------|-----------|---------|-----|
| Token refresh | 3 | 30s | Auth service down → fail fast |
| PDF generation submit | 3 | 30s | Queueing failures indicate outage |
| PDF poll | 5 | 60s | Transient, non-blocking |
| PDF download | 3 | 45s | Pre-signed URL, real failure if down |
| Envelope creation | 3 | 30s | Immediate failure → service down |
| Status check | 5 | 60s | Polling, can retry longer |
| Signed PDF download | 3 | 45s | User requested, fail fast |

**Circuit Breaker Config:**
```javascript
{
  failureThreshold: 3,      // Strict for critical ops
  successThreshold: 2,      // Need 2 successes to recover
  timeout: 30000,           // 30s before retrying
  halfOpenRequests: 1       // Only 1 test request at a time
}
```

### Monday.com

| Operation | Threshold | Timeout | Why |
|-----------|-----------|---------|-----|
| Read templates | 5 | 60s | Non-blocking, Monday is resilient |
| Read row | 5 | 60s | Idempotent, can retry |
| Update status | 5 | 60s | Webhook can retry on failure |
| Generic GraphQL | 5 | 60s | Rate limits are generous |

**Circuit Breaker Config:**
```javascript
{
  failureThreshold: 5,      // Relaxed, Monday is resilient
  successThreshold: 2,
  timeout: 60000,           // 60s before retrying
  halfOpenRequests: 2       // Allow 2 test requests
}
```

### SharePoint

| Operation | Threshold | Timeout | Why |
|-----------|-----------|---------|-----|
| Token acquisition | 3 | 30s | Auth failure blocks everything |
| Graph request | 3 | 45s | Graph API respects rate limits |
| Folder creation | 3 | 45s | Idempotent, can retry |
| File upload | 3 | 60s | Larger payload, longer timeout |
| Metadata update | 3 | 45s | Post-upload, less critical |

**Circuit Breaker Config:**
```javascript
{
  failureThreshold: 3,      // Strict, auth-critical
  successThreshold: 2,
  timeout: 45000,           // 45s before retrying
  halfOpenRequests: 1
}
```

## Integration Patterns

### Pattern 1: Wrap Existing API Call

```javascript
const { callApi } = require('./apiClient');

async function generateDocument(templateId, data) {
  return callApi('adobe', async () => {
    return adobe.createPDF(templateId, data);
  }, {
    label: 'adobe-pdf-create',
    breakerOpts: {
      failureThreshold: 3,
      timeout: 30000,
    },
  });
}
```

### Pattern 2: Use Service-Specific Wrapper

Instead of modifying `adobe.js` directly, use `adobeWithBreaker.js`:

```javascript
// OLD: const adobe = require('./adobe');
const adobe = require('./integrations/adobeWithBreaker');

// Now all calls automatically use circuit breaker
const pdf = await adobe.createPDF(templateId, data);
```

### Pattern 3: Get Health Status

```javascript
const { getHealthStatus } = require('./apiClient');

app.get('/api/health', (req, res) => {
  const health = getHealthStatus();
  res.json(health);
});

// Response:
{
  "status": "degraded",
  "timestamp": "2026-08-14T10:30:00Z",
  "apis": [
    {
      "name": "adobe",
      "state": "OPEN",
      "failureCount": 5,
      "nextRetryTime": 1692021030000,
      "stats": {
        "totalCalls": 142,
        "totalFailures": 5,
        "totalSuccesses": 137,
        "rejectedByBreaker": 2
      }
    }
  ],
  "open": [
    {
      "service": "adobe",
      "retryAt": 1692021030000
    }
  ]
}
```

## Error Handling

### Circuit Breaker Errors

When the circuit is OPEN:
```javascript
try {
  const pdf = await adobe.createPDF(templateId, data);
} catch (err) {
  if (err.code === 'CIRCUIT_BREAKER_OPEN') {
    console.log(`Adobe is down, retry after ${new Date(err.nextRetryTime)}`);
    // Queue for later, or fail to user with "service temporarily unavailable"
  }
}
```

### Transient vs. Permanent Errors

The circuit breaker distinguishes:

| Error | Transient | Circuit Action | Recommendation |
|-------|-----------|----------------|-----------------|
| Network timeout | Yes | Counts toward threshold | Retry |
| 429 Too Many Requests | Yes | Counts toward threshold | Rate limit, then retry |
| 5xx Server Error | Yes | Counts toward threshold | Retry |
| 401 Unauthorized | No | Does NOT count | Fix auth, don't retry |
| 404 Not Found | No | Does NOT count | Fix client, don't retry |
| Circuit open | No | Reject fast | Queue for later retry |

## Monitoring & Observability

### Logs

Circuit breaker state changes are logged:
```
[INFO] circuit-state-change:adobe from CLOSED to OPEN
[WARN] circuit-open:adobe-pdf-create-template123 service=adobe
[INFO] circuit-state-change:adobe from OPEN to HALF_OPEN
[INFO] circuit-state-change:adobe from HALF_OPEN to CLOSED
```

### Metrics

Each breaker tracks:
- `totalCalls`: All requests (blocked + allowed)
- `totalFailures`: Operations that failed
- `totalSuccesses`: Operations that succeeded
- `rejectedByBreaker`: Requests rejected by circuit breaker (fast-fail)
- `stateTransitions`: [{ from, to, time }]

### Dashboard Queries

**How many requests were fast-failed?**
```
breaker.stats.rejectedByBreaker
```

**When did Adobe last fail?**
```
new Date(breaker.lastFailureTime)
```

**How many retries until the circuit opens?**
```
breaker.failureThreshold - breaker.failureCount
```

## Testing

### Unit Test: Circuit Breaker State Transitions

```javascript
const { CircuitBreaker } = require('./circuitBreaker');

test('opens after failure threshold', async () => {
  const breaker = new CircuitBreaker('test', {
    failureThreshold: 2,
    timeout: 100,
  });

  // Record 2 failures
  await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
  await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});

  // Circuit should now be OPEN
  expect(breaker.state).toBe('OPEN');
  expect(breaker.nextRetryTime).toBeGreaterThan(Date.now());
});

test('recovers after timeout', async () => {
  const breaker = new CircuitBreaker('test', {
    failureThreshold: 2,
    timeout: 50,
  });

  // Open the circuit
  await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
  await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
  expect(breaker.state).toBe('OPEN');

  // Wait for timeout
  await sleep(60);

  // Next call should transition to HALF_OPEN
  await breaker.execute(async () => 'success').catch(() => {});
  expect(breaker.state).toBe('CLOSED');
});
```

### Integration Test: API Failure Scenario

```javascript
test('fast-fails when Adobe token service is down', async () => {
  const tokenAcquireFailures = 10; // Simulate many failures
  
  for (let i = 0; i < tokenAcquireFailures; i++) {
    await adobe.getToken('pdf').catch(() => {});
  }

  // Circuit should be open
  const breaker = circuitBreakerManager.getBreaker('adobe');
  expect(breaker.state).toBe('OPEN');

  // Next call should be rejected immediately
  const start = Date.now();
  await adobe.createPDF(templateId, data).catch(err => {
    expect(err.code).toBe('CIRCUIT_BREAKER_OPEN');
  });
  const duration = Date.now() - start;
  expect(duration).toBeLessThan(100); // Should be instant, not timeout
});
```

## Deployment & Operations

### Initial Deployment

1. Deploy circuit breaker code
2. All circuit breakers start in CLOSED state
3. No immediate behavior change
4. Monitor `/api/health` for baseline failure rates

### Tuning Thresholds

After 1-2 weeks of monitoring:
- If circuit opens frequently → increase `failureThreshold`
- If service outages aren't detected → decrease `failureThreshold`
- If recovery is slow → decrease `timeout`

### Manual Recovery

If Adobe service is fixed but circuit still OPEN:
```javascript
const { resetBreaker } = require('./apiClient');
resetBreaker('adobe');
```

### Alerting

Alert on:
- **Any circuit opens**: PagerDuty alert (service degradation)
- **Circuit stays open > 5 min**: Escalate
- **Frequent transitions**: Indicates flaky service

## FAQ

**Q: Why not just exponential backoff retry?**
A: Exponential backoff still sends requests to a downed service for several minutes. Circuit breaker fails fast and protects the entire system.

**Q: What if the service recovers during HALF_OPEN?**
A: Circuit transitions to CLOSED after `successThreshold` successes (default 2). Should take < 5s.

**Q: How do I know if circuit breaker is cause of my error?**
A: Check error code: `err.code === 'CIRCUIT_BREAKER_OPEN'` means breaker rejected it.

**Q: Can I disable circuit breaker for testing?**
A: Yes, set `breakerOpts.failureThreshold: Infinity` to never open.

**Q: What if multiple services are down?**
A: Each service has its own breaker. You'll see all of them in OPEN state in `/api/health`.

---

**See also:** `circuitBreaker.js`, `apiClient.js`, `adobeWithBreaker.js`, `mondayWithBreaker.js`, `sharepointWithBreaker.js`
