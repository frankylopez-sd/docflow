# DocFlow API Reference

**Base URL:** `https://doc-automation-func.azurewebsites.net/api`  
**Runtime:** Node.js 18 (Azure Functions)  
**Global Timeout:** 10 minutes

---

## Quick Summary

DocFlow automates employee document workflows via webhooks and asynchronous queues:

- **mondayWebhook** → triggered by Monday checkbox → queues PDF generation
- **adobeWebhook** → triggered by Adobe Sign completion → queues archival
- **health** → deployment verification endpoint
- **validateADP** → validates hire record completeness
- **Other endpoints** → internal functions, queue triggers, timers

---

## HTTP Endpoints (Public API)

### 1. POST /api/mondayWebhook

**Purpose:** Receive Monday webhook; validate JWT signature; enqueue document generation.

**Authentication:** JWT Bearer token (HS256 signed with Monday app secret)  
**Returns:** 200 (queued), 401 (invalid signature), 500 (error)

**Request:**
```json
{
  "challenge": "handshake_string",  // optional: for verification ping
  "event": {
    "type": "update_column_value|change_column_value",
    "boardId": 18422046530,
    "pulseId": "item_id_string",
    "columnId": "trigger_column_id",
    "value": {
      "checked": true
    }
  }
}
```

**Responses:**

| Scenario | Status | Body |
|----------|--------|------|
| Queued successfully | 200 | `{"queued":true,"itemId":"..."}` |
| Verification ping (challenge) | 200 | `{"challenge":"..."}` |
| Not trigger column or unchecked | 200 | `{"ignored":true,"reason":"..."}` |
| Invalid JWT signature | 401 | `{"error":"invalid signature"}` |
| Internal error | 500 | `{"error":"internal error"}` |

**Behavior:**
- Echoes challenge if present (no signature validation)
- Validates JWT in Authorization header
- Only queues if trigger column is checked
- Pushes to `docflow-generate` queue on success

---

### 2. GET|POST /api/adobeWebhook

**Purpose:** Receive Adobe Sign completion callback; validate client ID; enqueue archival.

**Authentication:** X-AdobeSign-ClientId header (must match config)  
**Returns:** 200 (always), 401 (client ID mismatch), 500 (error)

**Request:**

**Verification ping (GET or POST with no event):**
```
GET /api/adobeWebhook
X-AdobeSign-ClientId: adobe_client_id
```

**Completion payload:**
```json
{
  "event": "AGREEMENT_WORKFLOW_COMPLETED|AGREEMENT_ACTION_COMPLETED_ALL",
  "agreement": {
    "id": "adobe_agreement_uuid",
    "status": "SIGNED|APPROVAL_REQUESTED",
    "participantSetsInfo": [
      {
        "order": 1,
        "status": "SIGNED",
        "memberInfos": [
          {"email": "signer@example.com"}
        ]
      }
    ]
  }
}
```

**Responses:**

| Scenario | Status | Body |
|----------|--------|------|
| Queued for archival | 200 | `{"xAdobeSignClientId":"...","received":true}` |
| Verification ping | 200 | `{"xAdobeSignClientId":"..."}` |
| No agreementId | 200 | `{"xAdobeSignClientId":"...","ignored":true}` |
| Missing/wrong client ID | 401 | `{"error":"unknown client id"}` |
| Internal error | 500 | `{"error":"internal error"}` |

**Behavior:**
- Always returns 200 on success (Adobe requires this)
- Only queues on completion events (WORKFLOW_COMPLETED, ACTION_COMPLETED_ALL, or SIGNED status)
- Echoes X-AdobeSign-ClientId header in response
- Pushes to `docflow-archive` queue

---

### 3. GET /api/health

**Purpose:** Deployment verification and uptime monitoring.

**Authentication:** None (anonymous)  
**Returns:** 200 (always)

**Response:**
```json
{
  "status": "ok",
  "configLoaded": true,
  "environment": "production|staging|unknown",
  "timestamp": "2026-08-13T20:00:00.000Z"
}
```

**Behavior:**
- Always returns 200
- Reports whether config loaded successfully
- Reported environment from env var ENVIRONMENT
- Useful for health checks and alerting

---

### 4. POST /api/validateADP

**Purpose:** Validate 23 required ADP fields on hire record; update Monday status.

**Authentication:** JWT Bearer token (HS256 signed with Monday app secret)  
**Returns:** 200 (validated), 401 (invalid signature), 500 (error)

**Request:**
```json
{
  "challenge": "handshake_string",  // optional: for verification ping
  "event": {
    "type": "update_column_value",
    "boardId": 18422046530,
    "pulseId": "item_id_string",
    "columnId": "validation_trigger_column"
  }
}
```

**Responses:**

| Scenario | Status | Body |
|----------|--------|------|
| All fields valid | 200 | `{"validated":true,"itemId":"...","status":"Create New Hire"}` |
| Missing fields | 200 | `{"validated":false,"itemId":"...","missingFields":[...]}` |
| Invalid JWT | 401 | `{"error":"invalid signature"}` |
| Internal error | 500 | `{"error":"internal error"}` |

**Behavior:**
- Checks all 23 required ADP fields: personal, contact, employment, compensation, emergency contact, benefits
- Updates Monday status column to:
  - `"Create New Hire"` if all fields present
  - `"Missing Required Fields"` if incomplete
- Returns field list in response for debugging
- Similar JWT validation to mondayWebhook

---

### 5. POST /api/createADPUser

**Purpose:** Create new worker record in ADP system.

**Authentication:** Function key (x-functions-key header or query param)  
**Returns:** 200 (created), 400 (invalid), 401 (auth), 500 (error)

**Request:**
```json
{
  "adpRecordId": "ADP_RECORD_ID",
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane.doe@company.com",
  "dept": "Engineering",
  "jobTitle": "Software Engineer",
  ...additional_ADP_fields
}
```

**Responses:**

| Scenario | Status | Body |
|----------|--------|------|
| User created | 200 | `{"created":true,"userId":"...","adpId":"..."}` |
| Missing required fields | 400 | `{"error":"missing_field","field":"..."}` |
| Invalid function key | 401 | `{"error":"unauthorized"}` |
| ADP error | 500 | `{"error":"adp_api_error","details":"..."}` |

**Behavior:**
- Requires function-level authentication
- Calls ADP API to create worker record
- Returns ADP record ID and new user ID
- Used internally by sendForSign step

---

### 6. POST /api/updateMonday

**Purpose:** Manually write status/tracking columns to Monday item; used for ops recovery and pipeline verification.

**Authentication:** Function key  
**Returns:** 200 (updated), 400 (invalid), 401 (auth), 500 (error)

**Request:**
```json
{
  "boardId": 18422046530,
  "itemId": "item_id_string",
  "values": {
    "status": "In Progress|Complete|Error",
    "agreementId": "adobe_uuid",
    "pdfUrl": "https://...",
    "signedPdfUrl": "https://...",
    "signerDetails": "signer@example.com"
  }
}
```

**Responses:**

| Scenario | Status | Body |
|----------|--------|------|
| Updated successfully | 200 | `{"updated":true,"itemId":"..."}` |
| Missing boardId/itemId | 400 | `{"error":"boardId, itemId and values are required"}` |
| Invalid function key | 401 | `{"error":"unauthorized"}` |
| Monday API error | 500 | `{"error":"monday_error"}` |

**Behavior:**
- Requires function-level authentication
- Updates specified columns on item
- Verifies write by reading back (internal retry)
- Used for manual ops fixes and post-processing

---

### 7. GET /api/downloadSigned/{agreementId}

**Purpose:** Download fully-signed PDF from Adobe Sign archive.

**Authentication:** Function key  
**Returns:** 200 (binary), 404 (not found), 401 (auth), 500 (error)

**Request:**
```
GET /api/downloadSigned/adobe-agreement-uuid-12345
x-functions-key: function_key
```

**Responses:**

| Scenario | Status | Content-Type | Body |
|----------|--------|--------------|------|
| PDF found | 200 | `application/pdf` | Binary PDF data |
| Agreement not in archive | 404 | `application/json` | `{"error":"not found"}` |
| Invalid function key | 401 | `application/json` | `{"error":"unauthorized"}` |
| Storage error | 500 | `application/json` | `{"error":"internal error"}` |

**Behavior:**
- Retrieves PDF from Azure Blob Storage
- Returns binary PDF (Content-Disposition: attachment)
- Used for ops manual re-fetch and integration testing
- Logs all downloads for audit

---

## Queue-Triggered Functions (Internal)

| Function | Queue | Trigger | Purpose |
|----------|-------|---------|---------|
| `generatePDF` | `docflow-generate` | mondayWebhook | Merge template + Monday data → PDF |
| `sendForSign` | `docflow-sign` | generatePDF | Create Adobe Sign envelope; upload PDF |
| `archiveToBlob` | `docflow-archive` | adobeWebhook, signPoller | Download signed PDF; store permanently |
| `uploadToSharePoint` | `sharepoint-upload-queue` | sendForSign (conditional) | Upload PDF to SharePoint site |

---

## Timer-Triggered Functions (Internal)

| Function | Schedule | Purpose |
|----------|----------|---------|
| `signPoller` | Every 30 minutes | Fallback: poll Adobe API for completion status |
| `cleanup` | Daily 23:30 UTC | Delete temporary PDFs older than 7 days |

---

## Error Codes & Status

### HTTP Status Codes

- **200** — Request processed (success or intentional ignore)
- **400** — Missing required fields or malformed request
- **401** — Authentication failed (invalid JWT, function key, or client ID)
- **404** — Resource not found (agreement, PDF)
- **500** — Internal server error (unhandled exception)

### Common Error Reasons

| Reason | Endpoint | Fix |
|--------|----------|-----|
| `invalid signature` | mondayWebhook, validateADP | Verify Monday app signing secret in config |
| `unknown client id` | adobeWebhook | Verify Adobe client ID in config |
| `no itemId` | mondayWebhook | Check Monday event payload includes pulseId or itemId |
| `internal error` | Any | Check logs in Azure Application Insights |

---

## Configuration

All endpoints read configuration from environment variables at startup:

```
MONDAY_SIGNING_SECRET           # Monday app signing secret
MONDAY_ONBOARDING_BOARD_ID      # Board ID (18422046530)
MONDAY_COLUMNS_TRIGGER          # Trigger checkbox column ID
ADOBE_CLIENT_ID                 # Adobe Sign client ID
ADOBE_CLIENT_SECRET             # Adobe Sign client secret
ADP_API_KEY                      # ADP Workflex API key
SHAREPOINT_TENANT_ID            # Tenant ID
SHAREPOINT_SITE_ID              # Site ID
AzureWebJobsStorage             # Storage connection string
ENVIRONMENT                     # production|staging
```

See [ENV_CONFIG_TEMPLATE.md](./ENV_CONFIG_TEMPLATE.md) for complete list.

---

## Queue Architecture

```
mondayWebhook
    ↓ (docflow-generate)
generatePDF
    ↓ (docflow-sign)
sendForSign (+ createADPUser, uploadToSharePoint)
    
adobeWebhook / signPoller (every 30m)
    ↓ (docflow-archive)
archiveToBlob
    → updateMonday (status update)
```

---

## Testing & Development

**Local testing:**
```bash
npm install
npm test                  # Run 94 tests
npm run start            # Start local server (port 7071)
```

**Health check:**
```bash
curl http://localhost:7071/api/health
```

**Deploy verification:**
```bash
curl https://doc-automation-func.azurewebsites.net/api/health
```

**Monday webhook test:**
```bash
# Must include valid JWT in Authorization header
curl -X POST https://doc-automation-func.azurewebsites.net/api/mondayWebhook \
  -H "Authorization: Bearer <valid_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"update_column_value","boardId":18422046530,"pulseId":"123","value":{"checked":true}}}'
```

---

## Documentation

- [API_SPECIFICATION.md](./API_SPECIFICATION.md) — Full endpoint details with all error cases
- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) — Architecture & internal design
- [POISON_QUEUE_DELIVERABLES.md](./POISON_QUEUE_DELIVERABLES.md) — Dead-letter handling
- [SHAREPOINT_INTEGRATION.md](./SHAREPOINT_INTEGRATION.md) — SharePoint upload details
- [ENV_CONFIG_TEMPLATE.md](./ENV_CONFIG_TEMPLATE.md) — Configuration reference

---

**Version:** 1.0  
**Last Updated:** 2026-08-13
