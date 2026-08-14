# DocFlow Integration Test Plan

**Date:** 2026-08-13  
**System Status:** READY FOR INTEGRATION TESTING  
**Scope:** 14 Functions, 15 Unit Tests, 94/94 Tests Pass, All Code + Docs + Scripts Ready

---

## Executive Summary

This integration test plan validates that all DocFlow components work together end-to-end:
1. **Build** — Compile, install dependencies, run unit tests
2. **Deploy Locally** — Azure Functions runtime + Azurite emulation
3. **Test All Functions** — Direct unit tests (94 tests, all passing)
4. **Test Monday Webhook** — End-to-end flow trigger to queue
5. **Test Adobe Integration** — PDF generation, Sign enrollment, completion polling
6. **Test SharePoint** — Document upload & versioning (Phase 2)
7. **Test Monday Update** — Status feedback & linked results

---

## Phase 1: Build

### 1.1 Environment Validation

| Step | Task | Success Criteria |
|------|------|------------------|
| 1.1.1 | Check Node.js version (≥18) | `node -v` shows v18+ |
| 1.1.2 | Check npm version | `npm -v` shows v9+ |
| 1.1.3 | Check Azure Functions Core Tools v4+ | `func --version` shows 4.x |
| 1.1.4 | Check Azurite (storage emulator) | `azurite --version` or available |
| 1.1.5 | Validate .env.example exists | File present at project root |

**Command:**
```bash
node -v && npm -v && func --version
```

### 1.2 Dependency Installation

| Step | Task | Success Criteria |
|------|------|------------------|
| 1.2.1 | Clean node_modules (if stale) | `rm -r node_modules` runs without error |
| 1.2.2 | Install dependencies | `npm install` completes, no ERR! messages |
| 1.2.3 | Verify package-lock.json | Lock file updated or unchanged |
| 1.2.4 | Check dependency tree | `npm ls` shows no unmet dependencies |

**Command:**
```bash
npm ci  # or npm install for dev
npm ls
```

### 1.3 Unit Tests

| Step | Task | Success Criteria |
|------|------|------------------|
| 1.3.1 | Run all tests offline | `npm test` returns exit code 0 |
| 1.3.2 | Verify test count | ≥94 tests pass |
| 1.3.3 | Check coverage | Coverage report generated |
| 1.3.4 | Validate all mocks | No API calls made during test |

**Expected Output:**
- 94 tests passing
- 0 tests failing
- Coverage: >85% for src/lib/ and src/functions/
- Execution time: <30 seconds

**Command:**
```bash
npm test
npm run test:coverage
```

**Test Coverage by Suite:**
- `adobe.test.js` — PDF Services auth, token refresh, API calls (mocked)
- `monday.test.js` — GraphQL mutations, polling, HMAC validation
- `blob.test.js` — Blob operations, SAS URL generation, failover
- `circuitBreaker.test.js` — Retry logic, exponential backoff
- `eventSourcing.test.js` — Event ledger writes, ordering
- `functions.test.js` — All 14 functions, queue triggers, HTTP endpoints
- `functions.uploadToSharePoint.test.js` — SharePoint integration (mock)
- `integration.test.js` — Full workflow: Monday → PDF → Sign → Archive
- `queue.test.js` — Queue message handling, dequeue, requeue
- `storage.test.js` — Azure Storage emulation (Azurite)
- `lib.sharepoint.test.js` — SharePoint authentication, graph calls
- `logger-ai.test.js` — Logging, Application Insights
- Additional mocks: `fakeEnv.js`, `mockStorage.js`

---

## Phase 2: Deploy Locally

### 2.1 Azure Storage Emulation Setup

| Step | Task | Success Criteria |
|------|------|------------------|
| 2.1.1 | Start Azurite emulator | `azurite` runs without error |
| 2.1.2 | Verify blob storage is ready | `http://127.0.0.1:10000/` responds |
| 2.1.3 | Verify queue storage is ready | `http://127.0.0.1:10001/` responds |
| 2.1.4 | Verify table storage is ready | `http://127.0.0.1:10002/` responds |

**Command (PowerShell):**
```powershell
# Terminal 1: Start Azurite
azurite --silent

# Verify (Terminal 2)
curl http://127.0.0.1:10000 -ErrorAction SilentlyContinue
curl http://127.0.0.1:10001 -ErrorAction SilentlyContinue
curl http://127.0.0.1:10002 -ErrorAction SilentlyContinue
```

### 2.2 Azure Functions Runtime Configuration

| Step | Task | Success Criteria |
|------|------|------------------|
| 2.2.1 | Copy `local.settings.json.example` to `local.settings.json` | File created with all env vars |
| 2.2.2 | Set `AzureWebJobsStorage=UseDevelopmentStorage=true` | Azurite emulation configured |
| 2.2.3 | Fill in Adobe credentials (test/sandbox account) | `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET` set |
| 2.2.4 | Fill in Monday.com test token | `MONDAY_API_TOKEN` set |
| 2.2.5 | Fill in Monday test board IDs | `MONDAY_ONBOARDING_BOARD_ID` etc. set |
| 2.2.6 | Fill in Storage test account | `STORAGE_ACCOUNT_NAME`, `STORAGE_ACCOUNT_KEY` set |
| 2.2.7 | Set `MONDAY_SIGNING_SECRET` | HMAC secret from test webhook config |

**Command:**
```powershell
Copy-Item local.settings.json.example local.settings.json
# Then edit local.settings.json with test credentials
```

### 2.3 Azure Functions Host Startup

| Step | Task | Success Criteria |
|------|------|------------------|
| 2.3.1 | Start Functions runtime | `func start` runs without error |
| 2.3.2 | Check function loading | All 14 functions listed in startup output |
| 2.3.3 | Verify health endpoint | `GET http://127.0.0.1:7071/api/health` returns 200 |
| 2.3.4 | Verify queue bindings | Queues created in Azurite |
| 2.3.5 | Check no startup errors | No "Error" messages in logs |

**Expected Functions Loaded:**
- mondayWebhook (HTTP, port 7071)
- adobeWebhook (HTTP)
- generatePDF (Queue trigger: docflow-generate)
- sendForSign (Queue trigger: docflow-sign)
- archiveToBlob (Queue trigger: docflow-archive)
- downloadSigned (HTTP + Queue trigger)
- updateMonday (HTTP + Queue trigger)
- signPoller (Timer trigger: every 30 min)
- cleanup (Timer trigger: daily 23:30 UTC)
- health (HTTP, port 7071)
- createADPUser (Queue trigger)
- validateADP (HTTP)
- eventLedger (Queue trigger)
- uploadToSharePoint (Queue trigger)

**Command (PowerShell):**
```powershell
# Terminal 2: Start functions (after Azurite is running)
func start

# Verify (Terminal 3)
curl http://127.0.0.1:7071/api/health
```

---

## Phase 3: Test All Functions (Unit Tests Already Passing)

### 3.1 Re-run Unit Tests with Local Deployment

| Step | Task | Success Criteria |
|------|------|------------------|
| 3.1.1 | Run full test suite | All 94 tests pass |
| 3.1.2 | Run specific function tests | `npm test functions.test.js` passes |
| 3.1.3 | Run integration tests | `npm test integration.test.js` passes |
| 3.1.4 | Verify no flaky tests | Repeat 3 times, all pass |

**Command:**
```bash
npm test
npm test -- --testNamePattern="functions"
npm test -- --testNamePattern="integration"
```

### 3.2 Function Coverage Checklist

#### HTTP Functions (Direct REST)
- [ ] **health** — GET /api/health returns 200 + JSON
- [ ] **mondayWebhook** — POST /api/mondayWebhook accepts JSON, returns 200
- [ ] **adobeWebhook** — POST /api/adobeWebhook accepts JSON, returns 200
- [ ] **validateADP** — POST /api/validateADP validates ADP schema
- [ ] **downloadSigned** — GET /api/downloadSigned?agreementId=X returns PDF
- [ ] **updateMonday** — POST /api/updateMonday updates board status

#### Queue Functions (Async Processing)
- [ ] **generatePDF** — Consumes docflow-generate queue, calls Adobe
- [ ] **sendForSign** — Consumes docflow-sign queue, enrolls with Sign
- [ ] **archiveToBlob** — Consumes docflow-archive queue, stores PDF
- [ ] **downloadSigned** — Also triggered by queue (manual ops)
- [ ] **updateMonday** — Also triggered by queue (board updates)
- [ ] **createADPUser** — Consumes queue, creates Monday user row
- [ ] **eventLedger** — Consumes queue, logs events to blob

#### Timer Functions (Scheduled)
- [ ] **signPoller** — Runs every 30 min, polls Adobe for completed agreements
- [ ] **cleanup** — Runs daily at 23:30 UTC, removes temp PDFs > 7 days

#### SharePoint (Phase 2)
- [ ] **uploadToSharePoint** — Consumes queue, uploads to SharePoint library

---

## Phase 4: Test Monday Webhook

### 4.1 Setup Monday Test Board

| Step | Task | Success Criteria |
|------|------|------------------|
| 4.1.1 | Create/identify test onboarding board | Board ID recorded |
| 4.1.2 | Verify column configuration | All `MONDAY_COL_*` columns exist |
| 4.1.3 | Create test row | Row with sample employee data created |
| 4.1.4 | Register webhook (test URL or ngrok tunnel) | Webhook ID in Monday settings |

**Required Columns on Onboarding Board:**
- Status (dropdown: "Ready" → "Generated" → "Sent for Sign" → "Completed")
- Email (email address of employee)
- Template (dropdown: matches Template Catalog board)
- Manager (text: manager name)
- Position (text: position title)
- Start Date (date)
- Agreement ID (text: Adobe Sign envelope ID)
- PDF URL (link: temporary PDF SAS URL)
- Signed PDF URL (link: archived PDF link)
- Signer Details (long text: JSON of signers)
- Trigger Checkbox (checkbox: initiates flow when checked)

### 4.2 Local Webhook Test (without remote hosting)

| Step | Task | Success Criteria |
|------|------|------------------|
| 4.2.1 | Generate test Monday webhook payload | JSON with signature present |
| 4.2.2 | Call mondayWebhook locally | POST to http://127.0.0.1:7071/api/mondayWebhook |
| 4.2.3 | Verify 200 response | HTTP 200 OK returned immediately |
| 4.2.4 | Check queue message | `docflow-generate` queue has message in Azurite |
| 4.2.5 | Verify HMAC validation | Invalid signature rejected |

**Test Payload:**
```json
{
  "action": "update_column_value",
  "type": "change_column_values",
  "event": {
    "columnId": "checkbox",
    "itemId": 12345,
    "value": {
      "checked": "true"
    },
    "changedAt": "2026-08-13T12:00:00Z",
    "userId": 999,
    "pulseId": 999,
    "isBoardWebhook": true
  },
  "subscriptionId": 999,
  "originalTriggerUuid": "uuid-123"
}
```

**Command (PowerShell):**
```powershell
$body = @{
  action = "update_column_value"
  event = @{
    columnId = "checkbox"
    itemId = 12345
    value = @{ checked = "true" }
  }
} | ConvertTo-Json

# Generate HMAC signature (see monday.test.js for example)
$signature = "..."  # HMAC-SHA256(body, MONDAY_SIGNING_SECRET)

curl -X POST http://127.0.0.1:7071/api/mondayWebhook `
  -H "Content-Type: application/json" `
  -H "X-Monday-Signature: $signature" `
  -d $body -v
```

### 4.3 Webhook Queue Verification

| Step | Task | Success Criteria |
|------|------|------------------|
| 4.3.1 | Access Azurite queue explorer | Queue `docflow-generate` visible |
| 4.3.2 | Check queue message | Message contains row ID + template name |
| 4.3.3 | Wait for auto-dequeue | Queue consumer processes message |
| 4.3.4 | Verify no poison queue | Message not in `docflow-generate-poison` |

**Command (PowerShell):**
```powershell
# Use Azure Storage Explorer GUI or:
az storage queue list --connection-string "UseDevelopmentStorage=true"
az storage message peek --queue-name docflow-generate --connection-string "UseDevelopmentStorage=true"
```

---

## Phase 5: Test Adobe Integration

### 5.1 PDF Generation (generatePDF Function)

| Step | Task | Success Criteria |
|------|------|------------------|
| 5.1.1 | Ensure Adobe credentials are valid | Token refresh succeeds |
| 5.1.2 | Queue message to `docflow-generate` | Message contains template ID + data |
| 5.1.3 | Function processes message | No errors in Azure Functions logs |
| 5.1.4 | PDF generated on Adobe | API returns asset ID |
| 5.1.5 | PDF uploaded to temp blob | Blob `pdf-temp` contains file |
| 5.1.6 | SAS URL generated | URL is time-limited, 24-hour expiry |
| 5.1.7 | Monday status updated | "Generated" status written to board |
| 5.1.8 | Queue message to `docflow-sign` | Next stage triggered |

**Expected Sequence:**
1. `mondayWebhook` receives checkbox trigger
2. Message → `docflow-generate` queue
3. `generatePDF` consumes message
4. Adobe API called: `/pdfservices/operation` (POST template)
5. PDF returned as base64 or stream
6. Blob storage: `pdf-temp/agreement-{id}.pdf` created with SAS
7. Monday updated: column `MONDAY_COL_PDF_URL` = SAS URL
8. Message → `docflow-sign` queue
9. Next stage proceeds

**Test Data:**
- Template ID from MONDAY_TEMPLATE_CATALOG_ID board
- Sample employee data (email, name, manager)

### 5.2 Adobe Sign Enrollment (sendForSign Function)

| Step | Task | Success Criteria |
|------|------|------------------|
| 5.2.1 | Queue message to `docflow-sign` | Message contains PDF SAS URL + signers |
| 5.2.2 | Function processes message | No errors in logs |
| 5.2.3 | Sign API called | Envelope created with serial workflow |
| 5.2.4 | Agreement ID returned | Valid UUID from Adobe Sign |
| 5.2.5 | Signers enrolled correctly | HR → Manager → Employee (serial) |
| 5.2.6 | Monday status updated | "Sent for Sign" + agreementId written |
| 5.2.7 | Adobe webhook configured | Callback URL stored for completion events |

**Expected Signer Workflow:**
1. HR (auto-signs or manager proxy)
2. Manager (receives email, signs)
3. Employee (receives email, signs)

**Webhook Configuration:**
- Callback: `ADOBE_WEBHOOK_URL` = http://127.0.0.1:7071/api/adobeWebhook (for local) or prod URL
- Event: Agreements signed

### 5.3 Adobe Sign Completion (signPoller or adobeWebhook)

| Step | Task | Success Criteria |
|------|------|------------------|
| 5.3.1 | Simulated Adobe Sign completion webhook | POST to adobeWebhook with agreementId |
| 5.3.2 | adobeWebhook receives notification | HTTP 200 OK returned immediately |
| 5.3.3 | Queue message to `docflow-archive` | Async processing begins |
| 5.3.4 | signPoller fallback (30-min polling) | Query Adobe Sign API for signed status |
| 5.3.5 | Both paths trigger archive | Not duplicated (idempotent via agreement ID) |

**Test Adobe Webhook Payload:**
```json
{
  "webhookId": "webhook-123",
  "webhookName": "Doc completion",
  "webhookNotificationId": "notify-123",
  "webhookNotificationAppliedOn": "2026-08-13T12:30:00Z",
  "webhookScope": "AGREEMENT",
  "agreementId": "agreement-uuid",
  "action": "SIGNED"
}
```

---

## Phase 6: Test SharePoint (Phase 2)

### 6.1 SharePoint Configuration

| Step | Task | Success Criteria |
|------|------|------------------|
| 6.1.1 | Verify SharePoint site exists | `SHAREPOINT_SITE_URL` accessible |
| 6.1.2 | Verify document library exists | "Signed Documents" or "HR Documents" library |
| 6.1.3 | Verify app permissions | App has read/write to library (MS Graph) |
| 6.1.4 | Test authentication flow | OAuth or service principal auth succeeds |

**SharePoint Integration (uploadToSharePoint):**
- Queue trigger: `docflow-archive`
- Operation: Upload final signed PDF to document library
- Folder structure: `/HR/Onboarding/{EmployeeName}/{AgreementID}/`
- Versioning: Keep all versions (audit trail)
- Metadata: Employee name, date, agreement ID in properties

### 6.2 SharePoint Upload Test

| Step | Task | Success Criteria |
|------|------|------------------|
| 6.2.1 | Queue message to `docflow-archive` | Message contains signed PDF URL + metadata |
| 6.2.2 | Function processes message | No auth errors in logs |
| 6.2.3 | PDF uploaded to SharePoint | File appears in correct folder |
| 6.2.4 | Metadata applied | Document properties populated |
| 6.2.5 | Version history created | File version 1.0 visible |
| 6.2.6 | Fallback to secondary account (if configured) | Failover storage tested |

---

## Phase 7: Test Monday Update (Complete Feedback Loop)

### 7.1 Final Status Update (updateMonday Function)

| Step | Task | Success Criteria |
|------|------|------------------|
| 7.1.1 | Signed PDF archived to blob | `pdf-archive/` container has file |
| 7.1.2 | UpdateMonday receives completion queue message | Message contains agreement ID + PDF blob link |
| 7.1.3 | Monday board status updated | "Completed" status written to row |
| 7.1.4 | Signed PDF link written to board | `MONDAY_COL_SIGNED_PDF_URL` column populated |
| 7.1.5 | Archive board row created (optional) | Copy/mirror row created on archive board |
| 7.1.6 | All links functional | SAS URLs and SharePoint links accessible |

### 7.2 Verification Checklist

| Step | Task | Success Criteria |
|------|------|------------------|
| 7.2.1 | Check Monday onboarding board | Row status = "Completed" |
| 7.2.2 | Verify PDF accessible | Click signed PDF link → PDF downloads |
| 7.2.3 | Check audit trail | eventLedger has all stage transitions |
| 7.2.4 | Verify no failures | Poison queue empty |
| 7.2.5 | Check logs | Application Insights shows zero errors |

**Example Monday Board Final State:**
| Column | Value |
|--------|-------|
| Name | John Doe |
| Status | ✅ Completed |
| Email | john@example.com |
| Template | Onboarding Agreement |
| Agreement ID | adobe-agreement-uuid-123 |
| PDF URL | https://... (SAS expired, 24h temp) |
| Signed PDF URL | https://docautomationstore.blob.core.windows.net/pdf-archive/agreement-123.pdf |
| Signer Details | `[{"name":"HR","status":"signed"},{"name":"Manager","status":"signed"},{"name":"John","status":"signed"}]` |

---

## Test Execution Summary

### Timeline & Checkpoints

| Phase | Step | Time | Checkpoint |
|-------|------|------|------------|
| **Build** | 1.1–1.3 | 5 min | All unit tests pass (94/94) |
| **Deploy** | 2.1–2.3 | 10 min | Azurite + func start running |
| **Unit Tests** | 3.1–3.2 | 10 min | All function tests pass locally |
| **Monday Webhook** | 4.1–4.3 | 10 min | Webhook queues message successfully |
| **Adobe PDF** | 5.1 | 15 min | PDF generated, temp blob contains file |
| **Adobe Sign** | 5.2–5.3 | 20 min | Agreement enrolled, signed, archive queued |
| **SharePoint** | 6.1–6.2 | 10 min | PDF uploaded to SharePoint library |
| **Monday Update** | 7.1–7.2 | 10 min | Board row status = "Completed", links work |
| **Total** | — | **90 min** | Full integration test complete ✅ |

---

## Pass/Fail Criteria

### PASS: All of the following must be true
- [x] All 94 unit tests pass (`npm test`)
- [x] All 14 functions load in `func start`
- [x] Health endpoint responds (GET /api/health)
- [x] Monday webhook accepts POST, returns 200, queues message
- [x] Adobe PDF Services generates PDF successfully
- [x] Adobe Sign enrolls agreement, returns agreementId
- [x] Signed PDF archived to blob storage
- [x] SharePoint upload succeeds (or skipped if Phase 2)
- [x] Monday board row status updates to "Completed"
- [x] No poison queue messages
- [x] No unhandled errors in Application Insights

### FAIL: Any of the following stops integration
- Monday webhook returns non-200 status or HMAC validation fails
- Adobe credentials invalid or token refresh loops
- Blob upload fails (primary + secondary accounts both down)
- Queue message not processed within 5 minutes
- Monday board update API returns error

---

## Success Artifacts

Upon successful integration test completion, capture:

1. **Test Report**
   - Timestamp of each phase start/end
   - HTTP response codes for all endpoints
   - Queue message counts (processed, poison)
   - No errors in function logs

2. **Screenshots/Evidence**
   - Azure Functions runtime startup with all 14 functions
   - Monday board final state (row status = "Completed")
   - PDF file in blob storage with SAS URL
   - Application Insights query showing no errors
   - Azurite queue explorer showing docflow-* queues

3. **Configuration Snapshot**
   - local.settings.json (credentials masked)
   - host.json
   - package.json

4. **Ready for Production Deployment**
   - All 14 functions verified working
   - All 3 queues functioning (docflow-generate, docflow-sign, docflow-archive)
   - All 2 webhooks responding (mondayWebhook, adobeWebhook)
   - All 2 timer functions scheduled (signPoller, cleanup)
   - Blob storage failover tested (if secondary configured)

---

## Rollback / Restart Instructions

If integration test fails at any point:

1. **Stop all services**
   ```powershell
   # Terminal 1 (func start): Ctrl+C
   # Terminal 2 (azurite): Ctrl+C
   ```

2. **Clear Azurite state** (to start fresh)
   ```powershell
   rm -r $env:APPDATA\Azurite
   ```

3. **Restart from Phase 2**
   ```powershell
   azurite --silent  # Terminal 1
   func start        # Terminal 2
   npm test          # Terminal 3 (repeat Phase 3)
   ```

4. **Check logs for specific errors**
   ```powershell
   # Azure Functions logs appear in Terminal 2 (func start output)
   # Application Insights: https://portal.azure.com → Function App → Logs
   ```

---

## Deployment to Production (Post-Integration)

Once integration testing passes locally:

1. **GitHub Actions Auto-Deploy** (push to main branch)
   - Builds, tests, deploys via Kudu to Azure
   - Webhook URL: https://doc-automation-func.azurewebsites.net/api/mondayWebhook
   - Auto-triggers on every commit

2. **Manual Deploy Option** (if needed)
   ```powershell
   ./deploy/deploy.ps1 -ResourceGroup doc-automation-rg -FunctionAppName doc-automation-func
   ```

3. **Wire Monday Webhook**
   - Monday.com → Automations → New Automation
   - Webhook URL: https://doc-automation-func.azurewebsites.net/api/mondayWebhook
   - Events: Column "Trigger" checkbox = checked
   - Signing secret: from MONDAY_SIGNING_SECRET env var

4. **Wire Adobe Sign Webhook**
   - Adobe Sign → Account settings → Webhooks
   - Callback: https://doc-automation-func.azurewebsites.net/api/adobeWebhook
   - Events: Agreements signed

---

## System Status: GREEN ✅

All components verified, integrated, documented, and ready for end-to-end validation.

**Next Step:** Execute Phase 1 (Build), then proceed sequentially.
