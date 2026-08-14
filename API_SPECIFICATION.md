# DocFlow API Specification

**Version:** 1.0  
**Base URL:** `https://doc-automation-func.azurewebsites.net/api`  
**Deployment:** Azure Functions (Runtime: Node.js 18)  
**Global Function Timeout:** 10 minutes  
**Queue Configuration:** maxDequeueCount=3, visibilityTimeout=1 min, batchSize=4

---

## Summary

DocFlow comprises 12 Azure Functions implementing a document automation pipeline for employee onboarding:

| # | Function | Type | Auth | Purpose |
|---|----------|------|------|---------|
| 1 | `mondayWebhook` | HTTP (POST) | JWT signed | Trigger point: Monday checkbox → generate documents |
| 2 | `generatePDF` | Queue | N/A | Generate PDF from template + merge data |
| 3 | `sendForSign` | Queue | N/A | Create Adobe Sign envelope with serial signers |
| 4 | `adobeWebhook` | HTTP (GET/POST) | Header-based | Adobe Sign completion callback |
| 5 | `signPoller` | Timer (30 min) | N/A | Fallback: poll Adobe for completed signatures |
| 6 | `archiveToBlob` | Queue | N/A | Download signed PDF, store permanently |
| 7 | `downloadSigned` | HTTP (GET) | Function key | Download signed PDF (ops manual re-fetch) |
| 8 | `updateMonday` | HTTP (POST) | Function key | Manual Monday status write + verification |
| 9 | `validateADP` | HTTP (POST) | JWT signed | Validate 23 ADP fields on hire record |
| 10 | `createADPUser` | HTTP (POST) | Function key | Create worker in ADP system |
| 11 | `health` | HTTP (GET) | Anonymous | Deployment verification + uptime monitoring |
| 12 | `cleanup` | Timer (daily 23:30) | N/A | Delete aged temp PDFs (>7 days) |

---

## Queue Architecture

Three primary queues orchestrate the pipeline:

- **`docflow-generate`** (from mondayWebhook) → generatePDF
- **`docflow-sign`** (from generatePDF) → sendForSign
- **`docflow-archive`** (from adobeWebhook + signPoller) → archiveToBlob

---

# HTTP Endpoints

## 1. POST /api/mondayWebhook

**Purpose:** Receive Monday webhook when onboarding trigger checkbox is checked. Validates JWT signature and enqueues document generation.

**Authentication:** JWT (Bearer token in `Authorization` header)  
**Auth Level:** Anonymous (but validated via signature)

### Request

```
POST /api/mondayWebhook HTTP/1.1
Host: doc-automation-func.azurewebsites.net
Authorization: Bearer <JWT token signed with Monday app secret>
Content-Type: application/json

{
  "challenge": "optional_challenge_string_for_handshake",
  "event": {
    "type": "update_column_value|change_column_value|...",
    "boardId": 18422046530,
    "pulseId": "12345678",      // Monday item ID (also called itemId)
    "columnId": "trigger_col_id",
    "value": {
      "checked": true|false
    }
  }
}
```

### Response

**Success (200)** — Queued for processing:
```json
{
  "queued": true,
  "itemId": "12345678"
}
```

**Success (200)** — Verification ping (challenge handshake):
```json
{
  "challenge": "echo_back_the_challenge"
}
```

**Success (200)** — Ignored (not trigger column or not checked):
```json
{
  "ignored": true,
  "reason": "not trigger checkbox checked"
}
```

**Unauthorized (401)** — Invalid JWT signature:
```json
{
  "error": "invalid signature"
}
```

**Internal Error (500):**
```json
{
  "error": "internal error"
}
```

### Behavior

- **Challenge handshake:** If `body.challenge` is present, echo it back immediately (no signature check).
- **Signature validation:** Verifies `Authorization` header contains valid HS256 JWT signed with Monday app signing secret.
- **Trigger detection:** Only queues if:
  - Column is the configured trigger column (or no columnId specified)
  - Value indicates checkbox is **checked** (`true` or `"true"`)
- **Queue message:** If validated, pushes to `docflow-generate` queue with `{boardId, itemId, eventType, receivedAt}`.
- **Error recovery:** If an exception occurs after signature check, attempts to write `"Webhook Error"` status to the Monday item, then returns 500.

### Errors

| Reason | Status | Response |
|--------|--------|----------|
| Missing/invalid Authorization header | 401 | `{error: "invalid signature"}` |
| JWT malformed (not 3 dot-separated parts) | 401 | Same |
| JWT signature mismatch | 401 | Same |
| JWT token expired (exp < now) | 401 | Same |
| No itemId in event | 200 | `{ignored: true}` |
| Not the trigger column or checkbox not checked | 200 | `{ignored: true}` |
| Unhandled exception | 500 | `{error: "internal error"}` |

---

## 2. GET|POST /api/adobeWebhook

**Purpose:** Receive Adobe Sign webhook when document is completed or all signers have acted. Validates Adobe client ID and enqueues archival.

**Authentication:** Header-based (X-AdobeSign-ClientId)  
**Auth Level:** Anonymous (header validation only)

### Request

**Webhook verification ping (GET or POST with no event body):**
```
GET /api/adobeWebhook HTTP/1.1
Host: doc-automation-func.azurewebsites.net
X-AdobeSign-ClientId: <Adobe client ID>
```

**Webhook payload (POST with event):**
```
POST /api/adobeWebhook HTTP/1.1
Host: doc-automation-func.azurewebsites.net
X-AdobeSign-ClientId: <Adobe client ID>
Content-Type: application/json

{
  "event": "AGREEMENT_WORKFLOW_COMPLETED|AGREEMENT_ACTION_COMPLETED_ALL|...",
  "agreement": {
    "id": "agreement_uuid_from_adobe",
    "status": "SIGNED|APPROVAL_REQUESTED|...",
    "participantSetsInfo": [
      {
        "order": 1,
        "status": "SIGNED|PENDING|...",
        "memberInfos": [
          { "email": "signer@example.com" }
        ]
      }
    ]
  },
  "agreementId": "agreement_uuid_from_adobe"  // alternative location
}
```

### Response

**Success (200)** — Queued for archival:
```json
{
  "xAdobeSignClientId": "<echo_back_the_header>",
  "received": true
}
```

**Success (200)** — Webhook ping response (verification):
```json
{
  "xAdobeSignClientId": "<echo_back_the_header>"
}
```

**Success (200)** — Ignored (no agreementId):
```json
{
  "xAdobeSignClientId": "<echo_back_the_header>",
  "ignored": true
}
```

**Unauthorized (401)** — Client ID mismatch:
```json
{
  "error": "unknown client id"
}
```

**Internal Error (500):**
```json
{
  "error": "internal error"
}
```

### Behavior

- **Header validation:** Echoes back `X-AdobeSign-ClientId` header; if it doesn't match the configured Adobe client ID, rejects with 401.
- **Ping vs. payload:** GET requests or POST with no `body.event` are treated as webhook registration verification pings (return immediately with 200).
- **Event filtering:** Only queues if event is in `{AGREEMENT_WORKFLOW_COMPLETED, AGREEMENT_ACTION_COMPLETED_ALL}` OR agreement status is `SIGNED`.
- **Queue message:** Pushes to `docflow-archive` queue with `{agreementId, eventType, agreementStatus, signers, receivedAt}`.
- **Always returns 200:** Failures are logged but never cause an error response (Adobe requires 2xx to mark delivery successful).

### Errors

| Reason | Status | Response |
|--------|--------|----------|
| Missing X-AdobeSign-ClientId header | 401 | `{error: "unknown client id"}` |
| Header value doesn't match config | 401 | Same |
| No agreementId in payload | 200 | `{ignored: true}` |
| Event type not in completion set | 200 | Processed silently (no queue) |
| Unhandled exception | 500 | `{error: "internal error"}` |

---

## 3. GET /api/downloadSigned/{agreementId}

**Purpose:** Download the fully-signed PDF from Adobe Sign. Used internally by the archive pipeline and as an ops endpoint for manual re-fetch.

**Authentication:** Function key (x-functions-key header or query param)  
**Auth Level:** Function

### Request

```
GET /api/downloadSigned/agreement-uuid-12345 HTTP/1.1
Host: doc-automation-func.azurewebsites.net
x-functions-key: <function-key>

// Alternative: query param
GET /api/downloadSigned?agreementId=agreement-uuid-12345&code=<function-key>
```

### Response

**Success (200)** — PDF bytes:
```
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="agreement-uuid-12345.pdf"

[PDF binary data]
```

**Bad Gateway (502)** — Adobe fetch failed or retries exhausted:
```json
{
  "error": "Signature page request failed|read timeout|..."
}
```

### Behavior

- **Retry logic:** Retries up to 2x internally via `adobe.getSignedPDF()` before failing.
- **Agreement ID source:** From URL path `{agreementId}` or query param `agreementId`.
- **Fallback:** If agreement ID is missing from both sources, returns 400.
- **Content type:** Always `application/pdf`; browser will treat as attachment.
- **No signature verification:** Endpoint is function-key protected, not JWT.

### Errors

| Reason | Status | Response |
|--------|--------|----------|
| No agreementId provided | 400 | N/A (handled before HTTP) |
| Adobe returns 404 (agreement not found) | 502 | `{error: "..."}` |
| Adobe returns 401/403 (token expired) | 502 | Same |
| Network timeout after 2 retries | 502 | Same |
| Unhandled exception | 502 | Same |

---

## 4. POST /api/updateMonday

**Purpose:** Manually write status/tracking columns to a Monday item with verification. Used by pipeline and ops.

**Authentication:** Function key  
**Auth Level:** Function

### Request

```
POST /api/updateMonday HTTP/1.1
Host: doc-automation-func.azurewebsites.net
x-functions-key: <function-key>
Content-Type: application/json

{
  "boardId": "18422046530",
  "itemId": "12345678",
  "values": {
    "status": "Completed",
    "agreementId": "agreement-uuid-12345",
    "pdfUrl": "https://blob.azure.com/.../file.pdf",
    "signedPdfUrl": "https://blob.azure.com/.../file_signed.pdf",
    "signerDetails": [
      { "email": "hr@example.com", "status": "SIGNED" },
      { "email": "manager@example.com", "status": "SIGNED" },
      { "email": "employee@example.com", "status": "SIGNED" }
    ]
  }
}
```

### Response

**Success (200):**
```json
{
  "updated": true,
  "itemId": "12345678",
  "verifiedStatus": "Completed"
}
```

**Bad Request (400)** — Missing required fields:
```json
{
  "error": "boardId, itemId and values are required"
}
```

**Bad Gateway (502)** — Monday API failure:
```json
{
  "error": "write timeout|404 not found|..."
}
```

### Behavior

- **Validation:** Requires `boardId`, `itemId`, and `values` object in request body.
- **Values object:** Accepts any column values (status, agreementId, pdfUrl, signedPdfUrl, signerDetails, etc.); passes through to Monday API.
- **Verification:** Internally reads back the written value to confirm (3 retries).
- **Non-fatal:** If Monday write fails, pipeline continues but logs alert.
- **Idempotent:** Multiple calls with same values are safe.

### Errors

| Reason | Status | Response |
|--------|--------|----------|
| Missing boardId/itemId/values | 400 | `{error: "..."}` |
| Monday returns 404 (item not found) | 502 | `{error: "..."}` |
| Monday returns 401/403 (token expired) | 502 | Same |
| Verification reads back wrong value | 502 | Same |
| Network timeout | 502 | Same |

---

## 5. POST /api/validateADP

**Purpose:** Validate all 23 required ADP fields on a hire record. Updates status column to "Create New Hire" or "Missing Required Fields".

**Authentication:** JWT (Bearer token in `Authorization` header)  
**Auth Level:** Anonymous (but validated via signature)

### Request

```
POST /api/validateADP HTTP/1.1
Host: doc-automation-func.azurewebsites.net
Authorization: Bearer <JWT token signed with Monday app secret>
Content-Type: application/json

{
  "challenge": "optional_challenge_string",
  "event": {
    "type": "update_column_value|...",
    "boardId": 18422046530,
    "pulseId": "12345678",
    "columnId": "...",
    "value": { ... }
  }
}
```

### Response

**Success (200)** — Validation complete:
```json
{
  "validated": true,
  "isComplete": true|false,
  "newStatus": "Create New Hire|Missing Required Fields"
}
```

**Success (200)** — Challenge handshake:
```json
{
  "challenge": "echo_back_the_challenge"
}
```

**Success (200)** — Validation error (non-fatal):
```json
{
  "error": "validation failed",
  "details": "Column ID not found|..."
}
```

**Unauthorized (401)** — Invalid JWT:
```json
{
  "error": "invalid signature"
}
```

**Internal Error (500):**
```json
{
  "error": "internal error"
}
```

### Required ADP Fields (23 total)

**Personal:**
- Work Email (`text_mm65hxkh`)
- Badge Number (`text_mm65ktsr`)

**Employment:**
- ADP Job Title (`dropdown_mm65yf4s`)
- ADP Department (`dropdown_mm65xbge`)
- ADP Work Location (`dropdown_mm65fa2g`)
- Worker Type (`dropdown_mm65jpby`)
- Supervisor (`board_relation_mm65qm64`)
- Reason for Hire (`dropdown_mm66d04`)

**Payroll:**
- Pay Type (`dropdown_mm65v43b`)
- Pay Rate (`numeric_mm65mx3m`)
- Pay Frequency (`dropdown_mm658n1t`)
- Company Code (`dropdown_mm6566ff`)
- Pay Class (`dropdown_mm65aswt`)

**Tax:**
- FLSA Status (`dropdown_mm6576ra`)
- SUI/SDI Tax Code (`dropdown_mm651ram`)

**Time & Attendance:**
- Workers Comp Status (`dropdown_mm65r639`)
- Workers Comp Job Class Code (`dropdown_mm65e9dz`)
- Worked-In State (`dropdown_mm66y9tg`)
- Lived-In State (`dropdown_mm669dw4`)
- Time Zone (`dropdown_mm66x62b`)
- Benefits Eligibility (`color_mm651h50`)
- Benefits Eligibility Class (`dropdown_mm66xmr6`)
- Onboarding Experience (`dropdown_mm66tnrh`)

### Behavior

- **Challenge handshake:** If `body.challenge` present, echo back (no sig check).
- **Signature validation:** Verifies JWT in Authorization header.
- **Field validation:** Checks all 23 ADP columns for empty/null/blank values.
- **Status update:** Writes back "Create New Hire" (all 23 complete) or "Missing Required Fields" (incomplete).
- **Error handling:** If validation fails, writes "Validation Error" to status and returns 200 with error details.
- **Logging:** Emits event with field counts and missing field names for audit.

### Errors

| Reason | Status | Response |
|--------|--------|----------|
| Missing/invalid Authorization | 401 | `{error: "invalid signature"}` |
| JWT malformed or expired | 401 | Same |
| No itemId in event | 200 | `{ignored: true}` |
| Monday API failure during validation | 200 | `{error: "validation failed"}` |
| Unhandled exception | 500 | `{error: "internal error"}` |

---

## 6. POST /api/createADPUser

**Purpose:** Create a new worker record in the ADP system with hire details.

**Authentication:** Function key  
**Auth Level:** Function

### Request

```
POST /api/createADPUser HTTP/1.1
Host: doc-automation-func.azurewebsites.net
x-functions-key: <function-key>
Content-Type: application/json

{
  "firstName": "John",
  "lastName": "Doe",
  "hireDate": "2026-09-01",
  "jobTitle": "PHARMA|CLERK|Pharmacist|Pharmacy Clerk",
  "department": "MEDREV|CLERKS",
  "workLocation": "location_code",
  "residenceState": "UT|CA|TX|...",
  "managerName": "Jane Smith",
  "payRate": 45000,
  "compensationType": "Hourly|Salary|Daily",
  "timeZone": "PST|MST|HST|EST|...",
  "workState": "UT|CA|TX|...",
  "preferredName": "Johnny",
  "personalEmail": "john.doe@personal.com"
}
```

### Response

**Created (201)** — Worker created in ADP:
```json
{
  "success": true,
  "adpWorkerId": "worker-uuid-12345",
  "employee": "John Doe",
  "message": "ADP user created successfully"
}
```

**Internal Error (500)** — ADP API failure or token error:
```json
{
  "success": false,
  "error": "OAuth token request failed|Invalid credentials|..."
}
```

### Behavior

- **OAuth flow:** Obtains access token from ADP using `ADP_CLIENT_ID` and `ADP_CLIENT_SECRET` (env vars).
- **Payload construction:** Maps Monday fields to ADP employee/employment/payroll schemas.
- **Pay class mapping:** Resolves job title to ADP pay class (e.g., "PHARMA" → "PHARMACIST PAY CLASS").
- **Tax code mapping:** Resolves state code to ADP SUI/SDI tax code (e.g., "UT" → "UT-28").
- **Employment status:** Hardcoded as "A" (Active).
- **Workers comp:** Hardcoded as "S" (Subject to PBP).
- **Email generation:** Work email auto-generated from first/last name: `firstname.lastname@medwatchers.com`.
- **Return value:** ADP worker ID from the creation response.

### Errors

| Reason | Status | Response |
|--------|--------|----------|
| Missing ADP_CLIENT_ID or ADP_CLIENT_SECRET env var | 500 | `{error: "OAuth token request failed"}` |
| ADP OAuth endpoint unreachable | 500 | Same |
| ADP 401/403 (bad credentials) | 500 | Same |
| Required field missing in request | 500 | `{error: "Cannot read property..."}` |
| ADP worker creation returns error | 500 | `{error: "ADP error message"}` |
| Network timeout | 500 | `{error: "..."}` |

---

## 7. GET /api/health

**Purpose:** Health check for deployment verification and uptime monitoring.

**Authentication:** None  
**Auth Level:** Anonymous

### Request

```
GET /api/health HTTP/1.1
Host: doc-automation-func.azurewebsites.net
```

### Response

**Success (200):**
```json
{
  "status": "ok",
  "configLoaded": true|false,
  "environment": "production|staging|development|unknown",
  "timestamp": "2026-08-13T14:32:10.123Z"
}
```

### Behavior

- **Always returns 200:** Even if config fails to load, the endpoint responds 200 with `configLoaded: false`.
- **Config validation:** Attempts to load config; if successful, reports `configLoaded: true`.
- **Environment:** Reports value of `ENVIRONMENT` env var or "unknown".
- **Timestamp:** ISO 8601 timestamp of check time (UTC).
- **No external calls:** Pure function, no dependencies.

### Errors

| Reason | Status | Response |
|--------|--------|----------|
| Config load fails | 200 | `{status: "ok", configLoaded: false, ...}` |
| Unhandled exception | 500 | N/A (extremely rare) |

---

# Queue-Triggered Functions

## 8. generatePDF (Queue: docflow-generate)

**Purpose:** Generate PDF from Monday row + template catalog using Adobe PDF Services. Stages PDF in temp blob storage (24h SAS URL), updates Monday, enqueues for signing.

**Trigger:** Queue message from `mondayWebhook`  
**Input Format:** `{boardId, itemId, eventType, receivedAt}`

### Queue Message (Input)

```json
{
  "boardId": "18422046530",
  "itemId": "12345678",
  "eventType": "update_column_value",
  "receivedAt": "2026-08-13T14:30:00.000Z"
}
```

### Processing

1. **Fetch row + templates:** Reads Monday item and template catalog in parallel.
2. **Template resolution:** Matches row's `template` column value to catalog; defaults to first template if none specified.
3. **Merge data extraction:** Builds merge object from row (name, firstName, lastName, email, startDate, position, manager, etc.).
4. **Validation:** Verifies all required merge fields are non-empty before calling Adobe.
5. **Adobe PDF generation:** Calls Adobe PDF Services with template ID and merge data.
6. **Staging upload:** Uploads PDF bytes to `pdf-temp` blob container with 24h SAS URL.
7. **Monday update:** Writes status "Generated", PDF URL, PDF ID.
8. **Queue next stage:** Pushes to `docflow-sign` queue for signing.

### Output (Queue: docflow-sign)

```json
{
  "boardId": "18422046530",
  "itemId": "12345678",
  "pdfKey": "12345678_document-name_1691858400000.pdf",
  "pdfUrl": "https://blob.azure.com/pdf-temp/...?sv=2024-08-04&...",
  "templateName": "Employee Onboarding",
  "signers": [
    { "email": "hr@example.com" },
    { "email": "manager@example.com" },
    { "email": "{employee}" }
  ],
  "employeeEmail": "john.doe@company.com",
  "employeeName": "John Doe"
}
```

### Error Handling

- **Missing template:** Throws "Template not found in catalog" → Monday status = "Generate Failed" → exception logged.
- **Missing merge fields:** Throws "Required field X is missing" → same handling.
- **Adobe call fails:** Throws Adobe error → same.
- **Blob upload fails:** Throws storage error → same.
- **Monday write fails:** Logged, pipeline continues (non-fatal).

### Timeout

**10 minutes** (global Azure Functions timeout)

---

## 9. sendForSign (Queue: docflow-sign)

**Purpose:** Create Adobe Sign envelope with serial signing order (HR → Manager → Employee). Writes agreementId back to Monday.

**Trigger:** Queue message from `generatePDF`  
**Input Format:** (see generatePDF output above)

### Queue Message (Input)

```json
{
  "boardId": "18422046530",
  "itemId": "12345678",
  "pdfUrl": "https://blob.azure.com/...",
  "pdfKey": "12345678_doc_1691858400000.pdf",
  "templateName": "Employee Onboarding",
  "signers": [
    { "email": "hr@example.com" },
    { "email": "manager@example.com" },
    { "email": "{employee}" }
  ],
  "employeeEmail": "john.doe@company.com",
  "employeeName": "John Doe"
}
```

### Processing

1. **Signer resolution:** Resolves `{employee}` placeholder to the employee's email; validates all signers have email addresses.
2. **Envelope creation:** Calls Adobe Sign API to create agreement with:
   - PDF from staged blob URL
   - Serial signing order (recipientGroupId maps order)
   - Name: "{templateName} — {employeeName}"
   - Filename from msg.pdfKey
3. **Monday update:** Writes status "Sent for Sign", agreementId, signer details.
4. **Logging:** Emits event with agreementId for audit.

### Output

No queue output; success is indicated by Monday status change.

### Error Handling

- **Signer missing email:** Throws error → status = "Sign Failed" → exception logged.
- **Adobe envelope creation fails:** Same handling.
- **Monday write fails:** Logged, error rethrown (non-fatal).

### Timeout

**10 minutes**

---

## 10. archiveToBlob (Queue: docflow-archive)

**Purpose:** Final stage. Downloads signed PDF from Adobe, stores permanently in blob archive, updates Monday with signed PDF URL, creates Archive board record.

**Trigger:** Queue messages from `adobeWebhook` or `signPoller`  
**Input Format:** `{agreementId, itemId?, boardId?, signers?, employeeName?, docType?, source?, receivedAt?}`

### Queue Message (Input)

**From adobeWebhook:**
```json
{
  "agreementId": "agreement-uuid-12345",
  "eventType": "AGREEMENT_WORKFLOW_COMPLETED",
  "agreementStatus": "SIGNED",
  "signers": [
    { "order": 1, "status": "SIGNED", "emails": ["hr@example.com"] },
    { "order": 2, "status": "SIGNED", "emails": ["manager@example.com"] },
    { "order": 3, "status": "SIGNED", "emails": ["john.doe@company.com"] }
  ],
  "receivedAt": "2026-08-13T14:35:00.000Z"
}
```

**From signPoller:**
```json
{
  "agreementId": "agreement-uuid-12345",
  "itemId": "12345678",
  "boardId": "18422046530",
  "employeeName": "John Doe",
  "signers": [...],
  "source": "signPoller",
  "receivedAt": "2026-08-13T14:35:00.000Z"
}
```

### Processing

1. **Resolve itemId:** If not in message, queries Monday for item with matching agreementId.
2. **Fetch row details:** Reads Monday item for employee name + template type (if not in message).
3. **Download signed PDF:** Calls `downloadSigned(agreementId)` (2 retries internally).
4. **Permanent archive:** Uploads to `pdf-archive` with key `{itemId}_{docType}_{timestamp}.pdf`.
5. **Monday update:** Writes status "Completed", signed PDF URL, signer details.
6. **Archive board record:** Creates entry in Archive board with employee name, signed date, document link.
7. **Logging:** Emits event for audit trail.

### Output

No queue output; success is indicated by Monday status change.

### Error Handling

- **No itemId found:** Throws "No Monday item found with agreementId X" → exception logged (fatal).
- **Adobe download fails:** Throws error → status = "Archive Failed" → exception logged.
- **Blob upload fails:** Same.
- **Monday writes fail:** Logged, errors rethrown.

### Timeout

**10 minutes**

---

# Timer-Triggered Functions

## 11. signPoller (Schedule: 0 */30 * * * * = every 30 minutes)

**Purpose:** 30-minute fallback if Adobe's webhook never fires. Scans onboarding board for "Sent for Sign" items, asks Adobe for live status, enqueues archiving for completed signatures.

**Trigger:** Timer (every 30 minutes)  
**Input:** None (timer object only)

### Processing

1. **Find pending:** Queries Monday for all items on onboarding board with status = "Sent for Sign".
2. **Filter by agreementId:** Only includes items that have an agreementId set.
3. **Poll each:** For each pending item, calls `adobe.getAgreementStatus(agreementId)`.
4. **Check completion:** If status is "SIGNED", enqueues to `docflow-archive`.
5. **Logging:** Emits event with counts (pending items checked, completed).
6. **Retry on error:** Individual failures are logged but don't stop the loop.

### Queue Message (Output)

Same as adobeWebhook (see archiveToBlob input).

### Error Handling

- **Adobe status check fails:** Logged (non-fatal); loop continues.
- **Monday query fails:** Logged; function exits early.
- **Timer is past due:** Logged warning (timer lagged).

### Timeout

**10 minutes**

### Recovery

If webhook never fires and signPoller never completes (e.g., timeout or exception), the next run (30 min later) tries again.

---

## 12. cleanup (Schedule: 0 30 23 * * * = daily at 23:30 UTC)

**Purpose:** Delete aged temporary PDFs (>7 days) from `pdf-temp` container. Signed originals remain forever in `pdf-archive`.

**Trigger:** Timer (daily at 23:30 UTC)  
**Input:** None (timer object only)

### Processing

1. **Find old files:** Lists all blobs in `pdf-temp` container older than `tempMaxAgeHours` (default 168h = 7 days).
2. **Delete each:** Iterates and deletes each blob.
3. **Count results:** Tracks deleted count + error count.
4. **Logging:** Emits event with counts.
5. **Alert on errors:** If errors > 0, emits alert event for human review.

### Output

No queue output; just logging.

### Error Handling

- **Individual blob delete fails:** Logged, loop continues (non-fatal).
- **Blob list call fails:** Logged; function exits early.
- **Timer is past due:** Logged warning.

### Timeout

**10 minutes**

### Configuration

- `tempMaxAgeHours`: Hours to retain temp PDFs (default 168 = 7 days).
- `storage.tempContainer`: Azure Blob container name (default "pdf-temp").

---

# Global Configuration & Timeouts

## Function Timeout

**10 minutes** (defined in `host.json` as `"functionTimeout": "00:10:00"`)

All functions must complete within 10 minutes or are forcibly terminated by Azure Functions runtime.

## Queue Configuration

```json
{
  "maxDequeueCount": 3,
  "visibilityTimeout": "00:01:00",
  "batchSize": 4
}
```

- **Max dequeue:** Queue message retried max 3 times before sent to dead-letter queue.
- **Visibility timeout:** If function doesn't complete or delete message within 1 minute, it becomes visible again (retried).
- **Batch size:** Up to 4 messages processed in parallel per function instance.

---

# Error Codes & Status Patterns

## HTTP Status Codes

| Code | Meaning | When |
|------|---------|------|
| 200 | OK / Accepted | Webhook queued, validation passed, ping answered |
| 201 | Created | ADP user created successfully |
| 400 | Bad Request | Missing required fields (updateMonday, createADPUser) |
| 401 | Unauthorized | JWT signature invalid, Adobe client ID mismatch |
| 500 | Internal Server Error | Unhandled exception in function |
| 502 | Bad Gateway | Downstream service failure (Adobe, Monday, ADP, blob storage) |

## Monday Status Values

| Status | Stage | Pipeline Position |
|--------|-------|-------------------|
| "Pending" | Start | Item ready for trigger |
| "Webhook Error" | Webhook | mondayWebhook crashed |
| "Generated" | PDF stage | PDF created, in temp blob |
| "Sign Failed" | Sign stage | sendForSign crashed |
| "Sent for Sign" | Awaiting signatures | Envelope created, awaiting signers |
| "Completed" | Final | All signed, archived |
| "Archive Failed" | Archive stage | archiveToBlob crashed |
| "Validation Error" | Validation | validateADP crashed |
| "Create New Hire" | ADP validation | All 23 ADP fields complete |
| "Missing Required Fields" | ADP validation | Some ADP fields missing |

## Logging & Alerting

All functions emit structured logs:

- **`logger.event(name, data)`:** Audit trail (emitted to Application Insights).
- **`logger.error(name, err, context)`:** Error with stack trace.
- **`logger.warn(name, data)`:** Warning (e.g., webhook rejected).
- **`logger.info(name, data)`:** Info (e.g., event ignored).

Alert events are automatically routed to operational dashboards/email:
- `alert-monday-write-failed`
- `alert-cleanup-errors`

---

# Integration Examples

## Onboarding Trigger Flow (Nominal Path)

```
1. HR checks "Generate Docs" checkbox on Monday onboarding item
   ↓
2. POST /api/mondayWebhook (Monday webhook)
   ↓
3. Function validates JWT signature, enqueues to docflow-generate
   ↓
4. generatePDF (queue trigger)
   - Fetches row + templates
   - Generates PDF via Adobe PDF Services
   - Uploads to pdf-temp blob (24h SAS URL)
   - Updates Monday: status="Generated", pdfUrl=...
   - Enqueues to docflow-sign
   ↓
5. sendForSign (queue trigger)
   - Creates Adobe Sign envelope with HR → Manager → Employee signers
   - Updates Monday: status="Sent for Sign", agreementId=...
   ↓
6a. Adobe webhook (Fast Path)
   - POST /api/adobeWebhook when all signers complete
   - Enqueues to docflow-archive
   
6b. signPoller Fallback (If webhook fails)
   - Timer runs every 30 min
   - Polls Adobe for "Sent for Sign" items
   - Enqueues completed to docflow-archive
   ↓
7. archiveToBlob (queue trigger)
   - Downloads signed PDF from Adobe
   - Uploads to pdf-archive (permanent)
   - Updates Monday: status="Completed", signedPdfUrl=...
   - Creates Archive board record
```

## Manual Ops: Download Signed PDF

```
GET /api/downloadSigned/agreement-uuid-12345?code=<function-key>
Content-Type: application/pdf
→ Binary PDF file (for re-fetch or inspection)
```

## Manual Ops: Fix Monday Status

```
POST /api/updateMonday?code=<function-key>
{
  "boardId": "18422046530",
  "itemId": "12345678",
  "values": {
    "status": "Completed",
    "signedPdfUrl": "https://blob.azure.com/.../file.pdf"
  }
}
→ {updated: true, ...}
```

---

# Deployment & Secrets

**Environment variables required:**

- `MONDAY_API_KEY`: Monday.com GraphQL API token
- `MONDAY_SIGNING_SECRET`: Monday app signing secret (for JWT validation)
- `ADOBE_CLIENT_ID`: Adobe Sign OAuth client ID
- `ADOBE_CLIENT_SECRET`: Adobe Sign OAuth client secret
- `ADOBE_API_KEY`: Adobe PDF Services API key
- `ADP_CLIENT_ID`: ADP OAuth client ID
- `ADP_CLIENT_SECRET`: ADP OAuth client secret
- `AZURE_STORAGE_ACCOUNT_NAME`: Blob storage account
- `AZURE_STORAGE_ACCOUNT_KEY`: Blob storage account key
- `ENVIRONMENT`: Deployment environment label (e.g., "production")

**Deployment method:** Kudu VFS + AAD token (see DEPLOY-VALIDATEADP.md)

---

# Version History

| Date | Version | Changes |
|------|---------|---------|
| 2026-08-13 | 1.0 | Initial comprehensive API specification. All 12 functions documented. |

