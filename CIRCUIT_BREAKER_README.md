# Circuit Breaker Implementation for DocFlow

## What is a Circuit Breaker?

A **circuit breaker** prevents cascading failures when external services are down. Instead of retrying forever and timing out after 3.5 seconds, it:

1. **Tracks failures** (e.g., 3 in a row)
2. **Opens the circuit** (stops sending requests)
3. **Fails fast** (<100ms instead of 3.5s)
4. **Waits 30-60s** then probes for recovery
5. **Closes** when service is healthy again

## Problem It Solves

### Without Circuit Breaker (Current)
```
Adobe is down
  ↓
Request 1: wait 500ms → fail → retry
Request 2: wait 1s → fail → retry
Request 3: wait 2s → fail → error after 3.5s
  ↓
User sees: "Service error" after 3.5 second wait
Monday.com gets updated with stale data
SharePoint never receives the document
```

### With Circuit Breaker (Proposed)
```
Adobe is down
  ↓
Request 1: fail → failureCount = 1
Request 2: fail → failureCount = 2
Request 3: fail → failureCount = 3 → CIRCUIT OPENS
  ↓
Request 4: fail immediately (<100ms) with "service down" message
  ↓
30 seconds later: probe with 1 test request
  ↓
Service recovered: CIRCUIT CLOSES → normal operation resumes
```

## Documentation Index

### For Quick Integration (5 minutes)
- **[CIRCUIT_BREAKER_QUICK_START.md](./CIRCUIT_BREAKER_QUICK_START.md)** ⚡
  - How to integrate into your code
  - Error handling examples
  - Common scenarios
  - Troubleshooting

### For Developers (30 minutes)
- **[src/lib/integrations/circuitBreakerGuide.md](./src/lib/integrations/circuitBreakerGuide.md)** 📚
  - State transitions explained
  - Per-service configuration guidance
  - Integration patterns (3 options)
  - Monitoring & metrics
  - Testing strategies

### For Architects (1 hour)
- **[CIRCUIT_BREAKER_ARCHITECTURE.md](./CIRCUIT_BREAKER_ARCHITECTURE.md)** 🏗️
  - Complete architecture design
  - Decision matrix (when to fail fast)
  - Per-service thresholds
  - Observability strategy
  - Tuning guidelines
  - Failure scenarios with timelines

### For Operations/Debugging
- **[CIRCUIT_BREAKER_IMPLEMENTATION_SUMMARY.md](./CIRCUIT_BREAKER_IMPLEMENTATION_SUMMARY.md)** 📋
  - All files created (what, where, why)
  - Deployment checklist
  - Monitoring setup
  - Manual recovery procedure
  - Performance impact analysis

## Files Included

### Core Library (2 files)
```
src/lib/
├── circuitBreaker.js              Core state machine + manager
└── apiClient.js                   API wrapper + health endpoint
```

### Service Integrations (3 files)
```
src/lib/integrations/
├── adobeWithBreaker.js            Adobe PDF + Sign wrapper
├── mondayWithBreaker.js           Monday.com wrapper
└── sharepointWithBreaker.js       SharePoint wrapper
```

### Health Monitoring (1 file)
```
src/functions/health/
└── circuitBreakerHealth.js        Health endpoints
```

### Testing (1 file)
```
src/tests/
└── circuitBreaker.test.js         42 comprehensive tests
```

### Documentation (5 files)
```
CIRCUIT_BREAKER_README.md          This file (overview)
CIRCUIT_BREAKER_QUICK_START.md    For developers (TL;DR)
CIRCUIT_BREAKER_ARCHITECTURE.md   For architects (deep dive)
CIRCUIT_BREAKER_IMPLEMENTATION_SUMMARY.md  Deployment guide
src/lib/integrations/circuitBreakerGuide.md  User manual
```

## Quick Start (Copy-Paste Integration)

### Step 1: Update Imports in Your Functions

**Before:**
```javascript
const adobe = require('../lib/adobe');
```

**After:**
```javascript
const adobe = require('../lib/integrations/adobeWithBreaker');
```

That's it. All calls automatically use circuit breaker.

### Step 2: Deploy Files

Copy these directories to your DocFlow repo:
- `src/lib/circuitBreaker.js` (new)
- `src/lib/apiClient.js` (new)
- `src/lib/integrations/` (new folder with 3 files)
- `src/functions/health/circuitBreakerHealth.js` (new)
- `src/tests/circuitBreaker.test.js` (new)

### Step 3: Test

```bash
npm test -- src/tests/circuitBreaker.test.js
# Should pass 42 tests
```

### Step 4: Monitor

Check health endpoint:
```bash
curl https://your-app/api/health
```

Expect response like:
```json
{
  "status": "HEALTHY",
  "apis": [
    {"name": "adobe", "state": "CLOSED", "stats": {...}},
    {"name": "monday", "state": "CLOSED", "stats": {...}}
  ]
}
```

## Per-Service Configuration

| Service | Critical? | Threshold | Timeout | Rationale |
|---------|-----------|-----------|---------|-----------|
| **Adobe** | Yes | 3 failures | 30s | Blocks PDF generation |
| **SharePoint** | Yes | 3 failures | 45s | Auth blocks everything |
| **Monday** | No | 5 failures | 60s | Resilient, webhooks retry |

All configured automatically; adjust only if needed.

## Common Questions

**Q: Will users see more errors?**  
A: No. Same requests that timeout now will fail fast instead. Better UX.

**Q: What if Adobe is genuinely down?**  
A: Circuit opens after 3 failures. Returns error immediately. You get notified. Manual recovery: `POST /api/admin/breaker/adobe/reset`

**Q: Do I need to change my code?**  
A: Just 1 line per file: change the import statement.

**Q: How do I know it's working?**  
A: Check `/api/health`. Watch logs for `circuit-state-change`. All automatic.

**Q: Can I disable it?**  
A: Yes, set `failureThreshold: Infinity`. But recommend tuning instead.

## Monitoring Setup

### Add to Your Alerts
```
ALERT circuit-state-change:adobe → page on-call (critical service down)
ALERT circuit-state-change:monday → log only (can tolerate degradation)
```

### Add to Your Dashboard
```
- Success rate by service (should be >95%)
- Requests rejected by breaker (should be 0 when healthy)
- Open circuits (realtime)
- Time since last state transition
```

### What to Check Daily
```bash
# Should show CLOSED state for all
curl https://your-app/api/health | jq '.apis[].state'

# Should show no open circuits
curl https://your-app/api/health | jq '.open'
```

## Failure Scenario: Adobe PDF Services Outage

```
10:00:00  Adobe goes down (unplanned)
10:00:03  DocFlow fails to generate first PDF
10:00:06  Second PDF request fails
10:00:09  Third PDF request fails → Circuit OPENS
10:00:10  Fourth request → fast-fail error to user (<100ms)
10:00:11  Ops gets alert: "Adobe circuit open"
10:00:15  Ops checks Adobe status → confirmed down
10:00:20  More requests → all fast-fail (good, not hammering)
10:30:00  Adobe recovers
10:30:01  Circuit probes → success → transitions to HALF_OPEN
10:30:02  Circuit closes → back to normal
10:30:05  Next user request → PDF generates successfully
```

**Result**: Users aware of issue within 10 seconds. Automatic recovery within 60 seconds of service restoration.

## Deployment Checklist

- [ ] Understand the pattern (read QUICK_START.md)
- [ ] Copy core library files (circuitBreaker.js, apiClient.js)
- [ ] Copy service wrappers (adobe, monday, sharepoint)
- [ ] Copy health endpoint handler
- [ ] Run tests: `npm test -- circuitBreaker.test.js`
- [ ] Update imports in your functions
- [ ] Deploy to staging
- [ ] Monitor `/api/health` for 24 hours
- [ ] Adjust thresholds if needed
- [ ] Deploy to production
- [ ] Set up alerts
- [ ] Document in runbook

## Performance Impact

| Scenario | Before | After | Impact |
|----------|--------|-------|--------|
| Request when service healthy | 500-3000ms | 500-3000ms | None (retry layer unchanged) |
| Request when service down | 3500ms timeout | 50ms fast-fail | **70x faster** |
| Throughput during outage | 0.3 req/sec | Queue backlog | No blocking |

## Technical Details

### Retry Layer + Circuit Breaker Flow
```
User calls adobe.createPDF()
  ↓
Circuit Breaker (checks state)
  ├─ If OPEN: return error immediately
  ├─ If CLOSED or HALF_OPEN: continue
  ↓
Retry Layer (handles transients)
  ├─ Try request
  ├─ On failure: exponential backoff
  ├─ On success: return result
  ↓
Circuit Breaker (records result)
  ├─ On success: reset failure count
  ├─ On failure: increment count
  ├─ If count ≥ threshold: OPEN
```

### State Transitions

```
CLOSED (normal)
  ↓ (after N failures)
OPEN (down)
  ↓ (after timeout)
HALF_OPEN (testing)
  ├─ (after M successes) → CLOSED
  └─ (after 1 failure) → OPEN
```

### Error Codes

Your code can detect circuit breaker errors:
```javascript
try {
  await adobe.createPDF(...);
} catch (err) {
  if (err.code === 'CIRCUIT_BREAKER_OPEN') {
    // Service is down
    res.status(503).send('Service temporarily unavailable');
  } else {
    // Other error (network, timeout, etc.)
    throw err;
  }
}
```

## Support & Troubleshooting

### Circuit keeps opening/closing (flaky service)
→ Increase thresholds: `failureThreshold: 5`, `successThreshold: 3`

### Circuit never opens (threshold too high)
→ Decrease threshold: `failureThreshold: 2`

### Recovery takes too long
→ Decrease timeout: `timeout: 30000` (instead of 60000)

### Circuit opened but service is fine
→ Manually reset: `curl -X POST /api/admin/breaker/adobe/reset`

See [CIRCUIT_BREAKER_QUICK_START.md](./CIRCUIT_BREAKER_QUICK_START.md#troubleshooting) for more troubleshooting.

## Next Steps

1. **Read** [CIRCUIT_BREAKER_QUICK_START.md](./CIRCUIT_BREAKER_QUICK_START.md) (5 min)
2. **Copy** circuit breaker files to your repo
3. **Update** imports in your functions
4. **Run** tests: `npm test -- circuitBreaker.test.js`
5. **Deploy** to staging
6. **Monitor** `/api/health`
7. **Adjust** thresholds based on your baseline

---

## Files at a Glance

| File | Size | Purpose | Read Time |
|------|------|---------|-----------|
| CIRCUIT_BREAKER_QUICK_START.md | 350 lines | For developers | 5 min |
| src/lib/circuitBreaker.js | 395 lines | Core implementation | 20 min |
| src/lib/apiClient.js | 120 lines | Integration wrapper | 10 min |
| src/lib/integrations/adobeWithBreaker.js | 140 lines | Adobe wrapper | 5 min |
| circuitBreakerGuide.md | 400 lines | User manual | 20 min |
| CIRCUIT_BREAKER_ARCHITECTURE.md | 500 lines | Architecture deep dive | 30 min |
| src/tests/circuitBreaker.test.js | 450 lines | Test suite | 20 min |

**Total implementation**: ~2825 lines of code + documentation

---

## Summary

✅ Fail fast when services are down (<100ms instead of 3.5s)  
✅ Automatic recovery every 30-60 seconds  
✅ Prevents cascading failures  
✅ Observable via `/api/health`  
✅ Tunable per service  
✅ Thoroughly tested (42 tests)  
✅ Production-ready  
✅ Minimal code changes (just update imports)

**Status**: Ready for deployment 🚀
