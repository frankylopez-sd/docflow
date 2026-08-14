# Circuit Breaker Architecture for DocFlow

## Executive Summary

This document defines the circuit breaker pattern implementation for DocFlow's external API calls. The pattern prevents cascading failures by stopping requests to services that are down, then periodically testing for recovery.

**Key Decision:** When Adobe API is down, DocFlow should:
1. **Fail fast** after 3 consecutive failures (not timeout after 9)
2. **Stop sending requests** for 30 seconds
3. **Test recovery** with a single probe request
4. **Resume normal operation** when service recovers

## Problem Statement

### Current Behavior (Without Circuit Breaker)
- Request to Adobe fails
- Retry 3x with exponential backoff (500ms → 1s → 2s) = ~3.5s delay
- User sees long timeout before error
- If Adobe is down for 5 minutes:
  - Every request waits 3.5s then fails
  - Multiple parallel requests = thundering herd
  - Monday.com gets updated with stale data
  - SharePoint never receives final document

### Desired Behavior (With Circuit Breaker)
- Request to Adobe fails
- After 3 failures, **stop trying immediately**
- Return error in <100ms
- Wait 30s, then probe with 1 test request
- If probe succeeds, resume normal operation
- User gets fast feedback: "Service temporarily unavailable"

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Application Code (functions/generatePDF, etc.)              │
└──────────────────────┬──────────────────────────────────────┘
                       │ await adobe.createPDF(...)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Circuit Breaker Wrapper (integrations/adobeWithBreaker.js)  │
│  - Checks breaker state (CLOSED/OPEN/HALF_OPEN)            │
│  - Fails fast if OPEN                                        │
│  - Tracks successes/failures                                │
└──────────────────────┬──────────────────────────────────────┘
                       │ if CLOSED or HALF_OPEN, continue
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Retry Layer (retry.js)                                      │
│  - Exponential backoff (500ms → 1s → 2s → fail)            │
│  - Handles network errors + transient failures              │
│  - Logs each retry attempt                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │ if success or permanent error
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ External API (Adobe, Monday, SharePoint, etc.)              │
└─────────────────────────────────────────────────────────────┘
```

## State Machine

```
                    CLOSED (healthy)
                        ▲     ▼
                        │   (3 failures)
                        │     │
                        │     ▼
                   [30s]│  OPEN (down)
                        │     │
                        │   (timeout)
                        │     ▼
                        └─ HALF_OPEN (testing)
                            │     │
                    (success │     │ (failure)
                     2x)     │     │
                            ▼     ▼
                          CLOSED  OPEN
```

## Per-Service Configuration

### Adobe (Critical Path)
- **failureThreshold**: 3 (strict, fail fast)
- **timeout**: 30s (quick probe)
- **halfOpenRequests**: 1 (single test)
- **Rationale**: PDF generation blocks document workflow

### Monday.com (Resilient)
- **failureThreshold**: 5 (relaxed)
- **timeout**: 60s (longer probe window)
- **halfOpenRequests**: 2 (allow more testing)
- **Rationale**: Monday API is resilient; webhooks can retry

### SharePoint (Auth-Critical)
- **failureThreshold**: 3 (strict)
- **timeout**: 45s (medium)
- **halfOpenRequests**: 1 (single test)
- **Rationale**: Token failure blocks all operations

## Implementation Files

### Core Library
```
src/lib/circuitBreaker.js          - CircuitBreaker + Manager classes
src/lib/apiClient.js                - callApi() wrapper + health endpoint
```

### Service-Specific Integrations
```
src/lib/integrations/adobeWithBreaker.js       - Adobe wrapper
src/lib/integrations/mondayWithBreaker.js      - Monday wrapper
src/lib/integrations/sharepointWithBreaker.js  - SharePoint wrapper
```

### Health & Monitoring
```
src/functions/health/circuitBreakerHealth.js   - Health endpoints
src/tests/circuitBreaker.test.js               - Unit tests
```

### Documentation
```
src/lib/integrations/circuitBreakerGuide.md    - User guide
CIRCUIT_BREAKER_ARCHITECTURE.md                - This file
```

## Integration Guide

### Option 1: Minimal Change (Recommended for Now)

Replace imports in existing functions:

```javascript
// Before
const adobe = require('../lib/adobe');
const monday = require('../lib/monday');

// After
const adobe = require('../lib/integrations/adobeWithBreaker');
const monday = require('../lib/integrations/mondayWithBreaker');
```

All calls automatically use circuit breaker. Zero code changes.

### Option 2: Gradual Migration

Wrap individual calls:

```javascript
const { callApi } = require('../lib/apiClient');

async function generatePDF(templateId, data) {
  return callApi('adobe', async () => {
    return adobe.createPDF(templateId, data);
  }, {
    label: 'pdf-generation',
    breakerOpts: { failureThreshold: 3, timeout: 30000 },
  });
}
```

### Option 3: Custom Per-Operation Thresholds

Different thresholds for different scenarios:

```javascript
// Critical path: fail fast
await callApi('adobe', fn, {
  breakerOpts: { failureThreshold: 2, timeout: 20000 },
});

// Background task: tolerate longer
await callApi('adobe', fn, {
  breakerOpts: { failureThreshold: 8, timeout: 120000 },
});
```

## Error Handling

### Detect Circuit Breaker Rejection

```javascript
try {
  const pdf = await adobe.createPDF(templateId, data);
} catch (err) {
  if (err.code === 'CIRCUIT_BREAKER_OPEN') {
    // Service is down, retry after: err.nextRetryTime
    const retryIn = Math.ceil((err.nextRetryTime - Date.now()) / 1000);
    return { status: 503, error: `Service temporarily unavailable. Retry in ${retryIn}s` };
  }
  if (err.code === 'CIRCUIT_BREAKER_HALF_OPEN') {
    // Currently testing recovery, capacity exceeded
    return { status: 503, error: 'Service recovering, please retry in 5s' };
  }
  // Other errors: network, timeout, etc.
  throw err;
}
```

### Log Circuit State Changes

Circuit breaker logs all state transitions:
```
[INFO] circuit-state-change:adobe from CLOSED to OPEN
[WARN] circuit-open:adobe-pdf-create service=adobe
[INFO] circuit-state-change:adobe from OPEN to HALF_OPEN
[INFO] circuit-state-change:adobe from HALF_OPEN to CLOSED
```

Monitor these logs for alerts.

## Observability

### Health Endpoint

```bash
GET /api/health
```

Response:
```json
{
  "status": "DEGRADED",
  "timestamp": "2026-08-14T10:30:00Z",
  "summary": {
    "totalApis": 3,
    "healthyApis": 2,
    "openCircuits": 1
  },
  "apis": [
    {
      "name": "adobe",
      "state": "OPEN",
      "stats": {
        "totalCalls": 142,
        "successRate": "95.8%",
        "rejectedByBreaker": 5
      },
      "nextRetryAt": "2026-08-14T10:30:30Z",
      "retryInSeconds": 30
    }
  ]
}
```

### Metrics to Track

| Metric | Meaning | Alert Threshold |
|--------|---------|-----------------|
| `totalCalls` | All requests (allowed + rejected) | N/A |
| `successRate` | % of allowed requests that succeeded | < 80% = warning |
| `rejectedByBreaker` | Requests rejected by open circuit | > 0 = investigate |
| `failureCount` | Consecutive failures in CLOSED state | > threshold = opening |
| `stateTransitions` | Circuit state changes | > 5 in 5min = flaky |

### Dashboard Queries

```
// Success rate by service
sum(api.stats.totalSuccesses) / sum(api.stats.totalCalls) by service

// Requests rejected by breaker (fast-failures)
sum(api.stats.rejectedByBreaker) by service

// Time spent in OPEN state (unavailability)
sum(time_in_open_state) by service

// How many breaker transitions per hour
count(stateTransitions) by service, hour
```

## Tuning & Operations

### Initial Deployment

1. Deploy with default thresholds
2. Monitor `/api/health` for 24 hours
3. Measure baseline failure rates
4. No changes needed if healthy

### Adjustment Matrix

| Observation | Adjustment | Reason |
|-------------|-----------|--------|
| Circuit opens every hour | ↑ failureThreshold | Service is flaky, not down |
| Outage takes 5 min to detect | ↓ failureThreshold | Need faster detection |
| Recovery test takes too long | ↓ timeout | Probe earlier |
| HALF_OPEN requests failing | ↑ halfOpenRequests | More time to find success |

### Manual Recovery

After confirming a service is healthy:

```bash
POST /api/admin/breaker/adobe/reset
```

Response:
```json
{
  "message": "Circuit breaker reset for adobe",
  "state": {
    "name": "adobe",
    "state": "CLOSED",
    "failureCount": 0
  }
}
```

## Testing

### Unit Tests

Run the circuit breaker test suite:
```bash
npm test -- src/tests/circuitBreaker.test.js
```

Tests cover:
- State transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
- Failure threshold triggering
- Fast-fail when OPEN
- Timeout-based recovery
- Success threshold for closing
- Metrics tracking
- Manager coordination

### Integration Test: Service Failure Scenario

```javascript
// Simulate Adobe being down
for (let i = 0; i < 10; i++) {
  await adobe.createPDF(...).catch(() => {});
}

// Circuit should now be OPEN
const breaker = circuitBreakerManager.getBreaker('adobe');
assert(breaker.state === 'OPEN');
assert(breaker.stats.rejectedByBreaker > 0);

// Health endpoint shows degraded status
const health = await fetch('/api/health');
assert(health.status === 503 || health.status === 200);
assert(health.body.open.length > 0);
```

### Load Test: Verify Fast-Fail

```javascript
// Measure latency with circuit OPEN
const breaker = new CircuitBreaker('test', { failureThreshold: 1 });
breaker.state = 'OPEN'; // Force open

const start = Date.now();
try {
  await breaker.execute(() => 'success');
} catch (err) {
  const duration = Date.now() - start;
  assert(duration < 50); // Should be <50ms, not 3500ms
}
```

## Failure Scenarios & Recovery

### Scenario 1: Adobe PDF Services Outage

```
T=0:00   Request 1 fails         → failureCount = 1 (state: CLOSED)
T=0:03   Request 2 fails         → failureCount = 2
T=0:06   Request 3 fails         → failureCount = 3 ⚠️ OPEN
T=0:09   Request 4 rejected      → fast-fail (<100ms) ✓
T=0:30   Service recovers        → but circuit still OPEN
T=0:31   Probe request sent      → state: HALF_OPEN
T=0:32   Probe succeeds          → successCount = 1
T=0:33   Request 5 sent          → succeeds ✓ successCount = 2
T=0:34   State: CLOSED           ✓ Service restored
```

**Outcome**: 5 fast-failures + monitoring alert within 30s. Automatic recovery within 60s.

### Scenario 2: Flaky Monday API (intermittent 5xx errors)

```
T=0:00   Request 1 fails (5xx)   → failureCount = 1
T=0:05   Request 2 succeeds      → failureCount = 0 (reset)
T=0:10   Request 3 fails (5xx)   → failureCount = 1
T=0:15   Request 4 succeeds      → failureCount = 0
...
```

**Outcome**: Never opens (failures don't accumulate). Retries absorb transient errors. ✓

### Scenario 3: SharePoint Token Service Down

```
T=0:00   Read token cache        → expired
T=0:01   Call token endpoint     → fails
T=0:02   Retry 1 fails           → failureCount = 1
T=0:04   Retry 2 fails           → failureCount = 2
T=0:06   Retry 3 fails           → failureCount = 3 ⚠️ OPEN
T=0:07   Next call fast-fails    → <100ms response to user
T=0:08   Generate PDF fails      → Adobe doesn't get called
T=0:09   Monday updated with error status → webhook gets immediate feedback
T=0:37   Token endpoint recovery → circuit probes
T=0:38   Probe succeeds          → successCount = 1
T=0:39   Normal calls resume     ✓
```

**Outcome**: Cascading failures prevented. Users get fast feedback. Services update cleanly.

## Comparison: Retry vs. Circuit Breaker

| Aspect | Retry Only | + Circuit Breaker |
|--------|-----------|-------------------|
| **Adobe down 1 minute** | Wait 3.5s per request | Wait 3.5s once, then <100ms |
| **Fast feedback** | No (always retry) | Yes (after threshold) |
| **Downstream impact** | High (stale Monday data) | Low (fast failure) |
| **Recovery** | Automatic after timeout | Automatic + manual override |
| **Observability** | Logs only | Logs + metrics + health |
| **Configuration** | Basic (retries count) | Advanced (threshold + timeout) |

## Migration Checklist

- [ ] Review and understand `circuitBreaker.js`
- [ ] Review `apiClient.js` and `callApi()` wrapper
- [ ] Test `circuitBreaker.test.js` passes: `npm test -- circuitBreaker.test.js`
- [ ] Deploy `src/lib/circuitBreaker.js` and `src/lib/apiClient.js`
- [ ] Deploy service-specific wrappers (adobe, monday, sharepoint)
- [ ] Deploy health endpoint: `src/functions/health/circuitBreakerHealth.js`
- [ ] Update `/health` to use new endpoint
- [ ] Monitor dashboard for 24 hours
- [ ] Adjust thresholds based on baseline data
- [ ] Document in runbook: "If circuit is OPEN, check service status + run `POST /api/admin/breaker/{service}/reset`"
- [ ] Set up alerts: "Circuit OPEN for X service"

## FAQ

**Q: Will this cause more errors?**
A: No. Circuit breaker returns errors faster, but the same requests would have eventually failed anyway. Users get feedback in <100ms instead of 3.5s.

**Q: Can I disable circuit breaker?**
A: Set `failureThreshold: Infinity` to never open. But recommended to tune thresholds instead.

**Q: What if I manually reset and service is still down?**
A: Requests will fail again (same as before breaker). Circuit reopens after 3 failures.

**Q: Do I need to change app code?**
A: Minimal. Just replace imports to use `adobeWithBreaker` instead of `adobe`.

**Q: How do I know if it's working?**
A: Check `/api/health`. See breaker states + rejection counts. Monitor logs for "circuit-state-change".

---

**Maintained by**: DocFlow architecture team
**Last updated**: 2026-08-14
**Status**: Ready for deployment
