# DocFlow Integration Test Checklist

**Quick Reference — Print & Use During Testing**

---

## ✅ PHASE 1: BUILD (5 min)

### Prerequisites
- [ ] Node.js v18+ installed
- [ ] npm v9+ installed
- [ ] Azure Functions Core Tools v4+ installed
- [ ] Azurite available (`npm install -g azurite` or `dotnet tool install -g Microsoft.Azure.Cosmos.Table.Emulator`)

### Steps
```powershell
cd C:\Users\Franky.Lopez\docflow

# 1.1 Validate environment
node -v
npm -v
func --version

# 1.2 Install dependencies
npm ci

# 1.3 Run unit tests
npm test
```

### Success Criteria
- [ ] `npm test` exits with code 0
- [ ] Output shows: **94 passing** (or all tests pass)
- [ ] Output shows: **0 failing**
- [ ] No API calls made (all mocked)

---

## ✅ PHASE 2: DEPLOY LOCALLY (10 min)

### Terminal 1: Start Azurite
```powershell
# Terminal 1
azurite --silent
# Expected: No output (or minimal startup messages)
```

### Terminal 2: Copy Settings & Start Functions
```powershell
# Terminal 2
cd C:\Users\Franky.Lopez\docflow

# Copy template
Copy-Item local.settings.json.example local.settings.json

# Edit local.settings.json with test credentials:
# - ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET
# - MONDAY_API_TOKEN
# - MONDAY_ONBOARDING_BOARD_ID
# - STORAGE_ACCOUNT_NAME, STORAGE_ACCOUNT_KEY
# - Keep AzureWebJobsStorage = "UseDevelopmentStorage=true"

# Start functions runtime
func start
```

### Success Criteria
- [ ] `func start` outputs: "All workers initialized in X.XXXs"
- [ ] Output lists all 14 functions:
  - [ ] mondayWebhook
  - [ ] adobeWebhook
  - [ ] generatePDF
  - [ ] sendForSign
  - [ ] archiveToBlob
  - [ ] downloadSigned
  - [ ] updateMonday
  - [ ] signPoller
  - [ ] cleanup
  - [ ] health
  - [ ] createADPUser
  - [ ] validateADP
  - [ ] eventLedger
  - [ ] uploadToSharePoint
- [ ] Output shows: "No runtimes were found" (expected for node)
- [ ] No "Error" messages in output

### Terminal 3: Verify Health Endpoint
```powershell
# Terminal 3
curl http://127.0.0.1:7071/api/health -v
# Expected: HTTP 200 OK + JSON response
```

---

## ✅ PHASE 3: TEST ALL FUNCTIONS (10 min)

### Unit Tests (Repeat from Phase 1)
```powershell
# Terminal 3 (while func start is running)
cd C:\Users\Franky.Lopez\docflow
npm test
```

### Success Criteria
- [ ] All 94 tests pass
- [ ] No test timeout errors
- [ ] Execution time < 30 seconds

---

## ✅ PHASE 4: TEST MONDAY WEBHOOK (10 min)

### Setup
- [ ] Test Monday board created (note board ID)
- [ ] Columns verified: Status, Email, Template, Agreement ID, PDF URLs, etc.
- [ ] Test row created with sample employee data
- [ ] `MONDAY_SIGNING_SECRET` documented (from test webhook config)

### Local Webhook Test
```powershell
# Terminal 3
# Generate test payload (simplified, no HMAC for mock testing)
$body = @{
  action = "update_column_value"
  event = @{
    columnId = "checkbox"
    itemId = 12345
    value = @{ checked = "true" }
  }
} | ConvertTo-Json

# Call webhook (no signature required for local testing in development mode)
curl -X POST http://127.0.0.1:7071/api/mondayWebhook `
  -H "Content-Type: application/json" `
  -d $body -v
```

### Success Criteria
- [ ] HTTP 200 OK returned
- [ ] Queue message created in `docflow-generate`
- [ ] No errors in Terminal 2 (func start logs)

---

## ✅ PHASE 5: TEST ADOBE INTEGRATION (15 min)

### PDF Generation (generatePDF)
- [ ] Adobe credentials valid (test account)
- [ ] `npm test` includes `adobe.test.js` — all pass
- [ ] Query Azurite: `docflow-generate` queue has messages
- [ ] Check Terminal 2 logs for PDF generation success
- [ ] Verify blob storage `pdf-temp` container exists

### Adobe Sign (sendForSign)
- [ ] Adobe Sign credentials configured (ADOBE_SIGN_INTEGRATION_KEY or token)
- [ ] `npm test -- --testNamePattern="adobe"` passes
- [ ] Verify serial signer workflow: HR → Manager → Employee
- [ ] Check Monday test board: Agreement ID column populated

### Sign Completion (signPoller/adobeWebhook)
```powershell
# Test Adobe webhook manually
$adobePayload = @{
  webhookId = "test-123"
  agreementId = "actual-agreement-uuid-from-previous-step"
  action = "SIGNED"
} | ConvertTo-Json

curl -X POST http://127.0.0.1:7071/api/adobeWebhook `
  -H "Content-Type: application/json" `
  -d $adobePayload -v
```

### Success Criteria
- [ ] HTTP 200 OK from adobeWebhook
- [ ] Queue message to `docflow-archive` created
- [ ] No errors in Terminal 2 logs
- [ ] Monday board status shows progress: Ready → Generated → Sent for Sign → ...

---

## ✅ PHASE 6: TEST SHAREPOINT (10 min)

### Configuration
- [ ] SharePoint site URL verified (SHAREPOINT_SITE_URL env var)
- [ ] Document library exists (e.g., "Signed Documents")
- [ ] App has MS Graph permissions (read/write library)
- [ ] OAuth or service principal auth configured

### Upload Test
- [ ] Check `npm test -- --testNamePattern="sharepoint"` passes
- [ ] Manually trigger: `curl` to uploadToSharePoint function (if HTTP exposed)
- [ ] Or: Monitor queue `docflow-archive` for successful processing

### Success Criteria
- [ ] [ ] No auth errors in Terminal 2 logs
- [ ] [ ] PDF appears in SharePoint library (if Phase 2 wired)
- [ ] [ ] Metadata populated correctly
- [ ] [ ] File versioning enabled

---

## ✅ PHASE 7: TEST MONDAY UPDATE (10 min)

### Final Verification
```powershell
# Check Monday test board in web UI
# Expected row state:
# - Status: ✅ "Completed"
# - Agreement ID: Adobe UUID (from sendForSign)
# - PDF URL: https://... (SAS, temporary 24h)
# - Signed PDF URL: https://blob.../pdf-archive/agreement-xxx.pdf
# - All links clickable & download PDFs
```

### Audit Trail
```powershell
# Terminal 3
# Query eventLedger (if exposed as blob)
# Expected events in order:
# 1. "Monday webhook triggered"
# 2. "PDF generation started"
# 3. "PDF generated, SAS created"
# 4. "Sign enrollment started"
# 5. "Agreement signed, archive queued"
# 6. "Archive upload complete"
# 7. "Monday status updated to Completed"
```

### Success Criteria
- [ ] Monday row status = "Completed"
- [ ] Signed PDF URL points to real blob (not temp)
- [ ] SAS URL for temp PDF has ~24h expiry
- [ ] Archive board row created (if configured)
- [ ] No poison queue messages: `docflow-generate-poison`, `docflow-sign-poison`, `docflow-archive-poison` all empty

---

## ⚠️ TROUBLESHOOTING

### Azurite Not Starting
```powershell
# Install globally
npm install -g azurite

# Or use Docker
docker run -p 10000:10000 -p 10001:10001 -p 10002:10002 mcr.microsoft.com/azure-storage/azurite
```

### Functions Not Loading
```powershell
# Check function.json files
Get-ChildItem C:\Users\Franky.Lopez\docflow\src\functions -Recurse -Filter "function.json"

# Check for TypeScript compilation errors
func build
```

### Webhook Not Accepting
```powershell
# Verify HMAC signature (if enabled)
# In tests, MONDAY_SIGNING_SECRET is mocked
# For real Monday: sign payload with secret

# Check Content-Type header
# Must be: application/json
```

### Adobe Auth Fails
```powershell
# Verify credentials in local.settings.json
# Test Adobe endpoint manually
curl https://ims-na1.adobelogin.com/ims/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=YOUR_ID&client_secret=YOUR_SECRET&grant_type=client_credentials"
```

### Queue Messages Stuck
```powershell
# Check poison queue for error details
az storage message peek --queue-name docflow-generate-poison --connection-string "UseDevelopmentStorage=true"

# Re-queue from Terminal 2 logs for exact error
```

---

## ✅ FINAL VERIFICATION

| Item | Status | Notes |
|------|--------|-------|
| All unit tests pass | [ ] | `npm test` — 94/94 |
| All 14 functions load | [ ] | `func start` output |
| Health endpoint responds | [ ] | GET /api/health → 200 |
| Monday webhook queues | [ ] | POST /api/mondayWebhook → 200 |
| PDF generated | [ ] | Blob `pdf-temp` has file |
| Sign enrolled | [ ] | Adobe agreement created |
| Archive complete | [ ] | Blob `pdf-archive` has file |
| SharePoint uploaded | [ ] | File in library (if Phase 2) |
| Monday status updated | [ ] | Board row shows "Completed" |
| No errors in logs | [ ] | Terminal 2 has no "ERROR" or "ERROR" |
| No poison queues | [ ] | All `*-poison` queues empty |

---

## 🚀 NEXT STEP: PRODUCTION DEPLOYMENT

Once all checkboxes above are ✅:

```powershell
# Push to main branch
git add .
git commit -m "Integration test passed, ready for production"
git push origin main

# GitHub Actions auto-deploy triggers:
# - Builds, tests, deploys to Azure
# - Webhook URL: https://doc-automation-func.azurewebsites.net/api/mondayWebhook
```

**Estimated total time: 90 minutes**

---

**System Status: READY** ✅  
All code, docs, tests, and scripts complete. Proceed with integration testing.
