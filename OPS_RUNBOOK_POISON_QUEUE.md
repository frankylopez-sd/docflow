# Operations Runbook: DocFlow Poison Queue Management

**Audience**: Platform Operations, SharePoint Admins, On-Call Engineers
**Last Updated**: 2026-08-13

---

## Quick Reference

### What is a "Poison Queue"?

A poison queue handles documents that fail to upload to SharePoint repeatedly. DocFlow automatically:
1. Attempts SharePoint upload (immediate)
2. Falls back to blob storage (immediate)
3. Retries SharePoint every hour for 24 hours
4. After 24 hours: moves to fallback blob + creates ops alert

### Key Status Values in Monday

- **"Completed"** - Successfully uploaded to SharePoint or blob
- **"Archive Error"** - Blob upload failed (rare, emergency case)
- **"Poison Queue - Retrying"** - Automatically retrying SharePoint (hourly)
- **"Poison - Awaiting Manual Upload"** - 24-hour retry window expired, awaiting action

---

## Monitoring

### Where to Check Queue Depth

**Azure Portal**:
```
Storage Accounts → [docflow-storage] → Queues → docflow-archive-retry
```
Check: "Approximate Message Count" in queue properties

**Azure CLI**:
```bash
az storage queue metadata show \
  --account-name <storage-account> \
  --name docflow-archive-retry
```

### Alert Thresholds

| Metric | Normal | Warning | Critical |
|--------|--------|---------|----------|
| Queue depth | 0-2 | 2-5 | > 5 |
| Daily fallback ops | 0-1 | 1-3 | > 3 |
| Handler failures | 0 | Any | Any |

### How to Find Poison Messages in Monday

1. Navigate to **Onboarding Board** (ID: 18422046530)
2. Filter status: `"Poison"`
3. Sort by "Updated" timestamp (newest first)
4. Click item to view details:
   - Agreement ID (text field)
   - Status history (notes)
   - Error message (in notes)
   - Attempt count (if logged)

### Check Logs

**Application Insights**:
```kusto
traces 
| where message contains "poison" or message contains "sharepoint"
| order by timestamp desc
| limit 50
```

**Log Details**:
- `poison-queue-scan-start` - Handler started
- `poison-sharepoint-retry-success` - Retry succeeded (can stop monitoring)
- `poison-requeued-for-retry` - Message re-queued (still retrying)
- `poison-fallback-stored` - Moved to blob (24hr window expired)
- `poison-ops-alert-created` - Ops alert item created in Monday

---

## Troubleshooting

### Scenario 1: Queue Depth Growing (> 5 items)

**Symptoms**:
- Poison queue has multiple items
- Handler scan logs show repeated failures
- SharePoint upload errors in logs

**Investigation**:
1. Check SharePoint status:
   ```bash
   curl -I https://tenant.sharepoint.com/sites/documents
   ```
2. Verify SharePoint credentials in Key Vault:
   ```bash
   az keyvault secret list --vault-name <vault-name> | grep -i sharepoint
   ```
3. Check network connectivity:
   ```bash
   az vm run-command invoke -g <resource-group> -n <func-app-name> \
     --command-id RunShellScript --scripts "curl https://graph.microsoft.com/v1.0/me"
   ```

**Resolution**:
- **If SharePoint down**: Wait for restoration (handler will retry automatically)
- **If auth expired**: Update credentials in Key Vault
- **If network issue**: Contact network team

### Scenario 2: Document Stuck in "Poison - Awaiting Manual Upload"

**Symptoms**:
- Monday status: "Poison - Awaiting Manual Upload"
- Created > 24 hours ago
- No recent retry attempts in logs

**Investigation**:
1. Find document by Agreement ID
2. Check if blob fallback exists:
   ```bash
   az storage blob list --account-name <storage-account> \
     --container-name pdf-archive \
     --prefix "poison-fallback" \
     --auth-mode login
   ```
3. Verify Monday update succeeded:
   ```kusto
   traces 
   | where customDimensions.agreementId == "AGREE-12345"
   | order by timestamp desc
   ```

**Resolution** (choose one):

**Option A: SharePoint Now Available**
1. Verify SharePoint is responsive
2. Download PDF from blob:
   ```bash
   az storage blob download --account-name <storage-account> \
     --container-name pdf-archive \
     --name "poison-fallback/AGREE-12345_*.pdf" \
     --file ./document.pdf
   ```
3. Upload manually to SharePoint
4. Update Monday status to "Completed"

**Option B: Keep Blob Storage**
1. Verify blob URL is accessible
2. Update Monday status to "Completed" 
3. Add note: "Document stored in blob fallback - approved by [ops-name]"
4. Close any related tickets

**Option C: Retry Again**
1. If SharePoint just came back online:
   ```bash
   # Manually re-enqueue to retry queue
   az storage queue send --connection-string "..." \
     --queue-name docflow-archive-retry \
     --message-text '{
       "agreementId": "AGREE-12345",
       "itemId": "45678",
       "retry_count": 0,
       "firstFailedAt": "'$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')'",
       "tempKey": "45678_Offer_Letter_*.pdf",
       "fileName": "45678_Offer_Letter_*.pdf"
     }'
   ```
2. Monitor handler logs for retry attempts
3. Verify success via Monday status update

### Scenario 3: Handler Timer Not Running

**Symptoms**:
- No "poison-queue-scan-start" logs for > 10 minutes
- Queue depth not decreasing
- No retry attempts happening

**Investigation**:
1. Check function app status:
   ```bash
   az functionapp show -g <resource-group> -n <func-app-name>
   ```
2. Verify timer function is enabled:
   ```bash
   az functionapp function show -g <resource-group> -n <func-app-name> \
     --function-name poisonQueueHandler
   ```
3. Check function logs for errors:
   ```kusto
   traces
   | where cloud_RoleName == "poisonQueueHandler"
   | where severityLevel >= 2  # Warnings and errors
   ```

**Resolution**:
- **If app is stopped**: Start it via portal or CLI
- **If function disabled**: Enable via function UI or config
- **If auth error**: Check Key Vault permissions for function's managed identity
- **If timeout**: Check handler timeout settings (should be > 60s)

### Scenario 4: Manual Retry Not Working

**Symptoms**:
- Manually re-enqueued message not being processed
- Handler logs don't show the message

**Investigation**:
1. Verify message landed in queue:
   ```bash
   az storage queue peek --account-name <storage-account> \
     --name docflow-archive-retry --num-messages 32
   ```
2. Check message format validity:
   - Required fields: `agreementId`, `itemId`, `retry_count`, `firstFailedAt`
   - Verify JSON is valid (no truncation)

**Resolution**:
1. If message format wrong: Delete and re-send with correct format
2. If queue full (max 262,144 items): Clear old messages first
3. Restart handler function after re-enqueuing

---

## Common Commands

### Peek at Queue Messages
```bash
az storage queue peek \
  --account-name <storage-account> \
  --name docflow-archive-retry \
  --num-messages 10
```

### Clear Queue (use cautiously)
```bash
az storage queue delete \
  --account-name <storage-account> \
  --name docflow-archive-retry

az storage queue create \
  --account-name <storage-account> \
  --name docflow-archive-retry
```

### List Blob Fallback Files
```bash
az storage blob list \
  --account-name <storage-account> \
  --container-name pdf-archive \
  --prefix "poison-fallback/" \
  --output table
```

### Download a Fallback PDF
```bash
az storage blob download \
  --account-name <storage-account> \
  --container-name pdf-archive \
  --name "poison-fallback/AGREE-12345_1725000123.pdf" \
  --file ./document.pdf
```

### Force Handler Run (Restart Function)
```bash
# Restart the function to trigger immediate timer
az functionapp restart -g <resource-group> -n <func-app-name>

# Or, delete and re-create timer trigger to fire immediately
# (Advanced - use only if stuck)
```

---

## Escalation Path

### Level 1: Self-Service (Ops Team)
- Monitor queue depth
- Check SharePoint status
- Verify blob fallback storage

### Level 2: Engineering (DocFlow Team)
- Investigate auth failures
- Debug handler function
- Analyze retry logic

### Level 3: SharePoint Team
- If SharePoint is down or misconfigured
- If auth integration broken
- Contact: sharepoint-platform@company.com

### Level 4: Executive (On-Call)
- Multiple critical documents stuck > 48hrs
- Poison queue depth > 20
- System unable to process new documents

---

## Metrics & Alerts (Set up in Azure Monitor)

### Alert 1: Queue Depth Threshold
```
Metric: docflow-archive-retry queue message count
Condition: > 5
Duration: 10 minutes
Action: Notify ops@company.com
```

### Alert 2: Handler Function Failures
```
Metric: poisonQueueHandler function exceptions
Condition: > 0 in 1 hour
Duration: 5 minutes
Action: Page on-call engineer
```

### Alert 3: Fallback Usage
```
Metric: poison-fallback-stored events count
Condition: > 2 per day
Duration: Daily
Action: Notify sharepoint-platform@company.com
```

---

## Prevention

### Before Going Live
- [ ] Test SharePoint auth with actual credentials
- [ ] Load test: 100 documents simultaneously
- [ ] Verify blob fallback paths are writable
- [ ] Confirm Monday API rates not exceeded

### During Normal Operations
- [ ] Monitor poison queue depth daily
- [ ] Review handler logs for unusual patterns
- [ ] Test fallback blob access weekly
- [ ] Verify Monday alerts are firing

### After Incidents
- [ ] Root cause analysis (SharePoint vs network vs auth)
- [ ] Update runbook with lessons learned
- [ ] Adjust alert thresholds if needed
- [ ] Add automated health checks

---

## Reference

**Config Locations**:
- Storage Account: `docflow-storage` (production)
- SharePoint Site: `https://tenant.sharepoint.com/sites/documents`
- Monday Board: Onboarding (18422046530)
- Archive Board: Document Archive (configured via MONDAY_ARCHIVE_BOARD_ID)
- Ops Alerts: OPS Alerts (configured via MONDAY_OPS_ALERTS_BOARD_ID)

**Key Files**:
- Handler Function: `/functions/poisonQueueHandler/index.js`
- Archive Function: `/functions/archiveToBlob/index.js`
- SharePoint Library: `/lib/sharepoint.js`
- Main Docs: `POISON_QUEUE_HANDLING.md`

**Support Contacts**:
- DocFlow Engineer: [Name/Slack]
- SharePoint Admin: [Name/Slack]
- On-Call: [PagerDuty URL]
