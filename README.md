# DocFlow — Document Automation Platform

Monday.com onboarding board → Adobe PDF Services (document generation) → Adobe Sign (serial e-signature) → Azure Blob archive → status written back to Monday.

## Architecture

```
Monday checkbox checked
        │  (webhook, HMAC-verified JWT)
        ▼
┌───────────────┐   docflow-generate    ┌───────────────┐
│ mondayWebhook │ ────── queue ───────► │  generatePDF  │──► Adobe PDF Services
│  (HTTP, 200   │                       │ (queue trig.) │──► pdf-temp blob + 24h SAS
│  immediately) │                       └──────┬────────┘──► Monday: "Generated"
└───────────────┘                              │ docflow-sign queue
                                               ▼
                                        ┌───────────────┐
                                        │  sendForSign  │──► Adobe Sign envelope
                                        │ (queue trig.) │    (HR → Manager → Employee, serial)
                                        └──────┬────────┘──► Monday: "Sent for Sign" + agreementId
                                               │
                Adobe Sign signs complete      │   ┌────────────┐ every 30 min fallback
                        │                      │   │ signPoller │ (missed-webhook safety net)
                        ▼                      │   └─────┬──────┘
                ┌───────────────┐              │         │
                │ adobeWebhook  │── docflow-archive queue ┘
                │ (HTTP, 200    │              ▼
                │  immediately) │       ┌───────────────┐    downloadSigned (Adobe fetch)
                └───────────────┘       │ archiveToBlob │──► pdf-archive blob (byte-verified,
                                        │ (queue trig.) │    secondary-account fallback)
                                        └──────┬────────┘──► updateMonday: "Completed" + link
                                               │        └──► Archive board row
                                               ▼
                                     cleanup (daily 23:30 UTC): purge pdf-temp > 7 days
                                     health  (GET /api/health): deploy + uptime probe
```

Queues (`docflow-generate`, `docflow-sign`, `docflow-archive`) live in the
function app's `AzureWebJobsStorage` account and are created automatically.
Webhooks return 200 immediately; queue redelivery (maxDequeueCount 3) gives
every stage at-least-once processing with poison-queue capture.

## Layout

```
src/lib/        adobe.js  monday.js  blob.js  config.js  logger.js  util.js
src/functions/  mondayWebhook  generatePDF  sendForSign  adobeWebhook
                downloadSigned  archiveToBlob  updateMonday  signPoller
                cleanup  health
src/tests/      adobe.test.js  monday.test.js  blob.test.js  integration.test.js
deploy/         deploy.ps1 (zipdeploy, WARP-safe)
```

Notes:
- Adobe is called over REST with axios (not `@adobe/pdfservices-node-sdk`) —
  fully mockable offline, no 100MB SDK in the cold-start path.
- `downloadSigned` and `updateMonday` are pipeline cores that also expose
  key-protected HTTP endpoints for manual ops (re-fetch a signed PDF, fix a
  board status) without touching data by hand.
- `signPoller` implements the "fallback poller (every 30 min)" requirement
  from the sendForSign spec as its own timer function.

## Local setup

```powershell
cd docflow
npm install
copy .env.example .env                       # fill in real values
copy local.settings.json.example local.settings.json   # same values, func-host format
npm test                                     # offline: no credentials needed
npm start                                    # requires Azure Functions Core Tools v4 + Azurite
```

Tests are fully offline — every external API (Monday GraphQL, Adobe IMS/PDF
Services/Sign, Azure Blob) is mocked. `npm test` must pass before any deploy.

## Configuration

All values come from environment (see `.env.example`). Required at startup
(config throws if missing): `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET`,
`ADOBE_SIGN_API_URL`, `MONDAY_API_TOKEN`, `MONDAY_ONBOARDING_BOARD_ID`,
`MONDAY_TEMPLATE_CATALOG_ID`, `STORAGE_ACCOUNT_NAME`.

- **Azure**: put secrets in Key Vault and use Key Vault references in App
  Settings (`@Microsoft.KeyVault(SecretUri=...)`). Code only ever reads env.
- **Adobe Sign auth**: either `ADOBE_SIGN_INTEGRATION_KEY` (static) or
  `ADOBE_SIGN_REFRESH_TOKEN` (OAuth refresh; auto-refreshes 10 min before
  expiry, same as the PDF Services token).
- **Monday columns**: all column ids are `MONDAY_COL_*` settings — zero
  hardcoded ids. Adjust to the real board once it exists.
- **Storage fallback**: set `STORAGE_ACCOUNT_NAME_SECONDARY` (+ key) to enable
  automatic failover on archive writes.

### Template catalog board (Monday)

One row per document template with columns:
| Column | Content |
|---|---|
| Name | Template display name (matched against the row's Template column) |
| Adobe Template ID | PDF Services asset id of the uploaded .docx template |
| Data Fields | Comma-separated required merge fields (`firstName,lastName,...`) |
| Signers | Comma-separated emails in signing order; `{employee}` = row's email |

## Deployment (when credentials arrive)

1. **Provision** (once):
   ```powershell
   az group create -n mw-docflow-rg -l westus
   az storage account create -n docautomationstore -g mw-docflow-rg --sku Standard_LRS --kind StorageV2
   az keyvault create -n mw-docflow-kv -g mw-docflow-rg
   az functionapp create -n mw-docflow -g mw-docflow-rg --consumption-plan-location westus `
     --runtime node --runtime-version 20 --functions-version 4 --storage-account docautomationstore
   ```
   (Node 20/18 on Windows Consumption — Node 22 has the known worker bug.)
2. **Settings**: load every `.env` key as an App Setting (`az functionapp
   config appsettings set` — merge, never raw ARM PUT). Secrets as KV references.
3. **Deploy**: `deploy/deploy.ps1 -App mw-docflow -ResourceGroup mw-docflow-rg`
   (zipdeploy via SCM — ARM route is blocked under WARP).
4. **Verify**: `curl https://mw-docflow.azurewebsites.net/api/health` → 200.
5. **Wire webhooks**:
   - Monday: integration webhook on the onboarding board → `POST /api/mondayWebhook`
     (handles the challenge handshake automatically); set the signing secret
     as `MONDAY_SIGNING_SECRET`.
   - Adobe Sign: call `adobe.ensureWebhook()` once (or register in the Sign UI)
     pointing at `POST /api/adobeWebhook`; validation is by
     `X-AdobeSign-ClientId` echo, which the function implements.
6. **Containers**: `pdf-temp` and `pdf-archive` are created on first write.

## Status vocabulary (Monday status column)

`Generated` → `Sent for Sign` → `Completed`, with error states
`Webhook Error`, `PDF Gen Failed`, `Sign Failed`, `Archive Error`.

## Operations

- All logs/exceptions/events go to App Insights (`APPLICATIONINSIGHTS_CONNECTION_STRING`).
  Alert-worthy events: `alert-monday-write-failed`, `alert-cleanup-errors`.
- Manual re-fetch of a signed PDF: `GET /api/downloadSigned/{agreementId}?code=<funckey>`.
- Manual status fix: `POST /api/updateMonday?code=<funckey>` with
  `{boardId, itemId, values:{status: "..."}}`.
- Rate limits: Adobe 500/min and Monday 10/sec are enforced client-side with
  queuing; 429s additionally retry with exponential backoff.
