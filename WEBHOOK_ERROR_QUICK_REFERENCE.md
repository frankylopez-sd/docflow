# Monday Webhook Error Handling - Quick Reference

## HTTP Status Codes & Actions

### 200 OK ✅
**Meaning**: Webhook accepted and queued (or ignored gracefully)
- **Action**: Normal operation, no intervention needed
- **Examples**:
  - `{"queued": true, "itemId": "123"}` — Message queued for PDF gen
  - `{"ignored": true, "reason": "not trigger checkbox checked"}` — Event doesn't match criteria

### 401 Unauthorized 🔒
**Meaning**: Security issue — invalid signature or JWT
- **Action**: STOP, check Monday webhook config
- **Retryable**: ❌ No (Monday won't retry)
- **Errors**:
  - `"missing authorization"` — Authorization header not sent
  - `"invalid signature"` — HMAC mismatch
  - `"token expired"` — JWT is older than 5 minutes
  - `"malformed token"` — JWT structure invalid

**Fix**:
1. Verify Monday app signing secret matches `MONDAY_WEBHOOK_SIGNING_SECRET` in Function app
2. Check Monday webhook settings (re-register if needed)
3. Review Application Insights logs for `webhook-signature-invalid`

### 422 Unprocessable Entity ⚠️
**Meaning**: Data incomplete, but still queued
- **Action**: OK for now, PDF gen will validate further
- **Retryable**: ❌ No
- **Errors**:
  - `"warning": "incomplete hire data"` — Missing optional/required fields

**Fix**:
1. HR fills in missing fields (email, start date, position, etc.)
2. PDF generation will attempt to create document anyway
3. If PDF gen also fails, status updates to "PDF Gen Failed"

### 429 Too Many Requests ⏱️
**Meaning**: Queue is overloaded, back off
- **Action**: Client should retry after header `Retry-After` seconds
- **Retryable**: ⚠️ Yes (after delay)
- **Cause**: `docflow-generate` queue has >1000 pending messages

**Fix**:
1. Check queue depth: `az storage queue show-metadata --name docflow-generate`
2. Investigate why `generatePDF` is slow
3. Scale up Function app if needed
4. Check for poison messages in dead-letter queue

### 503 Service Unavailable 🔴
**Meaning**: Infrastructure issue — queue or storage unavailable
- **Action**: Service will retry automatically (5-7 times over 24h)
- **Retryable**: ✅ Yes (Azure will keep retrying)
- **Causes**:
  - Azure Storage down or throttled
  - Network connectivity issue
  - Queue service maintenance

**Fix**:
1. Check Azure Storage status page
2. Verify Function app can reach storage account
3. Check for firewall/NSG rules blocking access
4. Review storage account diagnostics

### 500 Internal Server Error 💥
**Meaning**: Unexpected error in webhook handler
- **Action**: Check logs immediately
- **Retryable**: ✅ Yes (Azure will retry)
- **Causes**: Unhandled exception in code

**Fix**:
1. Check Application Insights → `monday-webhook-unexpected-error`
2. Review error stack trace
3. Typically indicates missing Monday API token or connection issue
4. Restart Function app if needed

---

## End-to-End Message Flow

```
Monday checkbox checked
     ↓
Webhook hits endpoint
     ↓
401? → STOP (auth issue)
✗
402? → Ignored event (not trigger)
✓
✓ → Validate signature → 401 if fails
     ↓
✓ → Check event type/column → 200 (ignored)
     ↓
✓ → Validate hire data → 422 if incomplete (but still queue)
     ↓
✓ → Queue message → 503 if queue unavailable
     ↓
200 OK (queued)
     ↓
docflow-generate queue processes
     ↓
generatePDF function executes
     ↓
Creates PDF → Updates Monday → Queues signing
```

---

## Common Scenarios

### Scenario 1: All Webhooks Return 401
**Diagnosis**: Authentication failure
**Steps**:
1. Check Monday app is registered in Azure
2. Verify signing secret in app settings
3. Check webhook URL is correct
4. Review Application Insights: search `SIGNATURE_INVALID`

### Scenario 2: Webhooks Return 422, PDF Generation Fails
**Diagnosis**: Data is incomplete; PDF gen needs it
**Steps**:
1. Review Monday board columns for required fields
2. Update row with email, start date, position
3. Manually trigger webhook by unchecking/rechecking box
4. If still fails, check PDF generation logs

### Scenario 3: Sometimes 503, Sometimes 200
**Diagnosis**: Intermittent queue issues
**Steps**:
1. Monitor queue depth over time
2. Check if certain hours have spikes
3. Scale Function app or optimize PDF generation speed
4. Set up alerts: 503 rate > 5%

### Scenario 4: Message Queued (200) but No PDF Generated
**Diagnosis**: Queue message stuck or function crashed
**Steps**:
1. Check `docflow-generate` queue count
2. Check `docflow-generate-poison` queue for dead letters
3. Review `generatePDF` function logs
4. Restart Function app or redeploy

---

## Monitoring & Alerts

### Application Insights Queries

**401 Rate (Auth Issues)**:
```kusto
customEvents
| where name startswith "webhook-signature"
| where tostring(customDimensions.httpStatus) == "401"
| summarize count() by bin(timestamp, 5m)
```

**422 Rate (Data Issues)**:
```kusto
customEvents
| where name == "monday-webhook-incomplete-data"
| summarize count() by bin(timestamp, 5m)
```

**503 Rate (Infra Issues)**:
```kusto
customEvents
| where name startswith "webhook-queue"
| where tostring(customDimensions.httpStatus) == "503"
| summarize count() by bin(timestamp, 5m)
```

**Error Summary**:
```kusto
customEvents
| where name startswith "webhook-"
| summarize total = count(), 
  auth_401 = sumif(1, tostring(customDimensions.httpStatus) == "401"),
  data_422 = sumif(1, tostring(customDimensions.httpStatus) == "422"),
  queue_503 = sumif(1, tostring(customDimensions.httpStatus) == "503"),
  error_500 = sumif(1, tostring(customDimensions.httpStatus) == "500")
  by bin(timestamp, 1h)
```

### Alert Rules

| Condition | Threshold | Action |
|-----------|-----------|--------|
| 401 rate > 10% | 5m window | Page on-call (auth broken) |
| 503 rate > 5% | 5m window | Alert ops (infrastructure) |
| 422 rate > 20% | 5m window | Alert HR lead (data issues) |
| Queue depth > 1000 | Real-time | Scale up Function app |
| Poison queue grows | 1h window | Investigate & investigate |

---

## Testing Errors Locally

### Test 401 (Bad Signature)
```bash
curl -X POST http://localhost:7071/api/mondayWebhook \
  -H "Authorization: Bearer badtoken.invalid.signature" \
  -H "Content-Type: application/json" \
  -d '{"event":{"itemId":"123","boardId":"456","columnId":"trigger","value":{"checked":true}}}'

# Expected: 401
# {"error":"invalid signature"}
```

### Test 422 (Incomplete Data)
```bash
# Create Monday webhook with JWT, but missing hire data fields
# Expected: 422
# {"queued":true,"warning":"incomplete hire data","note":"Message queued; PDF generation will validate fully"}
```

### Test 503 (Queue Down)
```bash
# Stop azurite or disconnect storage
# Send valid webhook
# Expected: 503
# {"error":"queue service unavailable","retry":true}
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/webhookErrors.js` | Error handling module, types, responses |
| `src/functions/mondayWebhook/index.js` | Webhook entry point, error handler |
| `src/functions/generatePDF/index.js` | PDF generation (full data validation) |
| Tests: `webhookErrors.test.js` | Unit tests for error module |
| Tests: `mondayWebhook.integration.test.js` | Integration tests for webhook flow |
| Docs: `WEBHOOK_ERROR_HANDLING.md` | Full architectural guide |

---

## Policy: When Do We Queue vs. Reject?

| Failure | Webhook Response | Queue? | Reason |
|---------|------------------|--------|--------|
| Bad signature | 401 Unauthorized | ❌ No | Security — don't process |
| Expired JWT | 401 Unauthorized | ❌ No | Security — don't process |
| Wrong column | 200 OK | ❌ No | Not relevant event |
| Checkbox unchecked | 200 OK | ❌ No | Not a trigger action |
| Incomplete data | 422 Unprocessable | ✅ **Yes** | PDF gen validates fully |
| Queue unavailable | 503 Service Error | ❌ No | Will retry webhook |
| Unexpected error | 500 Internal | ❌ No | Error in handler |

**Philosophy**: Be conservative with 401 (reject), permissive with data 422 (queue anyway), resilient with infrastructure 503 (retry).

---

## Deployment Checklist

- [ ] `webhookErrors.js` deployed to production
- [ ] `mondayWebhook/index.js` updated with new error handling
- [ ] Tests passing: `npm test`
- [ ] Application Insights collecting structured logs
- [ ] Alerts configured for 401/503 rates
- [ ] Team aware of new status codes (422, 429)
- [ ] Runbook created for common errors
- [ ] Monday webhook URL verified in app settings
- [ ] Signing secret matches both Monday and Azure
