# Project Memory Anchor: Azure-Adobe-Monday Integration Engine (DocFlow)

## High-Level System Mindset
- This project is an **Asynchronous Distributed State Machine**.
- The system is **Stateless**. Monday.com serves as the database of record.
- All triggers and event routes must be strictly **Idempotent**. Inspect current status before executing anything.
- Do not overwrite existing code pipelines or abstract helpers without explicit confirmation.

## Label Vocabulary (single source of truth: cfg.monday.statusLabels / offerLabels in src/lib/config.js)
Both lifecycle columns use numbered, self-describing labels: 👤 = human action, ⚙️ = automated, 🎉 = done, ❌ = failed (instructions in item Updates). Onboarding Status: ①👤 Send Welcome Form → ②⏳ Awaiting Candidate Info → ③👤 Complete Hire Fields → ④⚙️ Docs In Progress → ⑤⚙️ Out for Signature → ⑥⚙️ Archiving → ⑦🎉 Onboarding Complete (+ ADP handoff labels kept verbatim: Create New Hire / Ready to Create / Missing Required Fields). Offer Letter Status: ① Not Started → ②⚙️ Generating Offer → ③👤 Review Offer (HR) → ④✅ Approved — Send It → ⑤⚙️ Out for Signature → ⑥🎉 Signed & Archived (+ ✋/🛑/❌). Monday constraint: existing label IDs keep their colors — never change a label's color, only text/index/description; new labels pick color freely. Every action is logged on the item via monday.logAction (Pacific-time stamp + plain line + 🔧 technical line).

## The Complete Multi-State Document Lifecycle
1. **STATE: 'Generate Document'** (Inbound Monday Webhook)
   - Read item fields → Call Adobe Document Generation API → Upload Draft PDF to Monday Column → Advance Monday Status to 'For Review'.
2. **STATE: 'Approved'** (Inbound Monday Webhook)
   - Read Draft PDF from item → Call Adobe Sign API (create agreement + register callback webhook) → Advance Monday Status to 'Out for Signature'.
3. **STATE: 'Signed'** (Inbound Adobe Sign Webhook Callback)
   - Intercept Adobe signature completion ping → Authenticate callback handshake → Download final signed PDF → Upload PDF to Monday Column → Update Monday Status to 'Done'.

## Architectural Layout Requirements
- **Central Dispatcher Hub** pattern inside a unified Azure Function App (Node.js). `mondayWebhook` is the single public gateway: validates token handshake, parses the unique item ID, and routes on the status column's current string value.
- Isolate operational boundaries: Monday GraphQL services (`src/lib/monday.js`), Adobe Doc Gen services, and Adobe Sign services (`src/lib/adobe.js`) remain separate modules.
- Maintain an explicit **Status Exclusion List** (`'For Review'`, `'Out for Signature'`, `'Done'`, plus any status this system writes itself) at the entry router. On match: return HTTP 200 immediately and drop execution — this stops cascading infinite webhook recursion loops.

## Known Traps (learned the hard way — do not repeat)
- **Infinite Loop Trap**: our own status updates re-trigger Monday webhooks. The exclusion list at the router is the only defense. Never remove it.
- **Large File Streams**: never move PDFs as in-memory strings. Stream binary through Azure Blob Storage (`pdf-temp` container) before pushing into Monday mutations.
- **Async Webhook Callbacks**: Functions cannot wait for signatures. Adobe Sign must call back to `adobeWebhook`, which must answer Adobe's GET challenge handshake (echo `X-AdobeSign-ClientId`) before processing payloads.
- **CI gate blocks deploys silently**: GitHub Actions runs tests before deploy; failing tests mean Azure keeps running STALE code while local looks fixed. Always check `gh run list` after push.
- **Resource group is `doc-automation-rg`** — NOT `medwatchers-prod`. Queries against the wrong RG return empty results that look like missing config.
- **WARP firewall**: `az functionapp config appsettings set` and `az functionapp restart` hang locally. Use `az rest` against ARM (`management.azure.com`) or Kudu with AAD bearer tokens instead.
- **Deploy fallback**: Kudu zipdeploy with `Authorization: Bearer $(az account get-access-token)` to `https://doc-automation-func.scm.azurewebsites.net/api/zipdeploy?isAsync=true` always works.

## Infrastructure Facts
- Function App: `doc-automation-func` (doc-automation-rg, West US, Node.js, subscription 9aa34901-d6ee-49fc-b284-fdd9d7b47c11)
- Storage: `docautomationstore` (queues: docflow-generate-high / docflow-generate / docflow-generate-batch; blobs: pdf-temp, pdf-archive)
- Monday Onboarding board: `18422046530` · Template catalog: `18425963576`
- Key Vault: `doc-automation-kv` (exists; RBAC access must be granted before use)

## Context Maintenance Guidelines
- Never assume unknown payload shapes. Ask for schema samples or use the mock data patterns in `src/tests/`.
- If a task fails or loops, halt immediately, run diagnostics, and report status before retrying.
