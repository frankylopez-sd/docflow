# SharePoint Integration - Deployment Checklist

Complete checklist for deploying the SharePoint integration to production.

## Pre-Deployment (1-2 hours)

### Azure AD Setup
- [ ] Create app registration "DocFlow SharePoint" in Azure AD
- [ ] Record Application (client) ID
- [ ] Add API permissions: Sites.ReadWrite.All, Files.ReadWrite.All, User.ReadWrite.All
- [ ] Grant admin consent for permissions
- [ ] Create client secret
- [ ] Record secret value (only visible once!)
- [ ] Store secret in Azure Key Vault (preferred) or note for App Settings

### SharePoint IDs Discovery
- [ ] Use Graph Explorer to find Site ID (`/sites/medwatchers.sharepoint.com:/sites/HR`)
- [ ] Record Site ID (format: `tenant,site,web`)
- [ ] Use Graph Explorer to find Drive ID (`/sites/{siteId}/drives`)
- [ ] Record Drive ID (Document library)
- [ ] Get Tenant ID from Azure AD Properties
- [ ] Verify Site URL: `https://medwatchers.sharepoint.com/sites/HR`

### Monday Board Setup
- [ ] Create new column: Type **Link**, Name: **SharePoint Link**
- [ ] Set Column ID: `link_sharepoint` (must match config)
- [ ] Test that column accepts URLs
- [ ] (Optional) Create status values: "Shared to SharePoint", "SharePoint Upload Error"

### Local Testing (Optional)
- [ ] Clone docflow repo locally
- [ ] Copy `.env.example` to `.env`
- [ ] Fill in SHAREPOINT_* variables
- [ ] Run `npm test` (should pass)
- [ ] Test sharepointClient directly with sample PDF
- [ ] Verify folder creation in SharePoint

## Deployment (30 minutes)

### Code Deployment
- [ ] Verify `src/lib/sharepointClient.js` exists
- [ ] Verify `src/functions/sharePointUploadFunction/index.js` exists
- [ ] Verify `src/functions/sharePointUploadFunction/function.json` exists
- [ ] Push to main branch (triggers GitHub Actions)
- [ ] Monitor deployment in GitHub Actions
- [ ] Verify functions deployed: `az functionapp function list --name doc-automation-func`

### Environment Variables (Azure Portal)

Go to **Function App → doc-automation-func → Settings → Configuration**

Add these variables:

```
SHAREPOINT_ENABLED=true
SHAREPOINT_TENANT_ID=<from Azure AD>
SHAREPOINT_CLIENT_ID=<from App Reg>
SHAREPOINT_CLIENT_SECRET=<from App Reg secret>
SHAREPOINT_SITE_ID=<from Graph Explorer>
SHAREPOINT_SITE_URL=https://medwatchers.sharepoint.com/sites/HR
SHAREPOINT_DRIVE_ID=<from Graph Explorer>
MONDAY_COL_SHAREPOINT_LINK=link_sharepoint
```

- [ ] Set SHAREPOINT_ENABLED=true
- [ ] Set SHAREPOINT_TENANT_ID
- [ ] Set SHAREPOINT_CLIENT_ID
- [ ] Set SHAREPOINT_CLIENT_SECRET
- [ ] Set SHAREPOINT_SITE_ID
- [ ] Set SHAREPOINT_SITE_URL
- [ ] Set SHAREPOINT_DRIVE_ID
- [ ] Set MONDAY_COL_SHAREPOINT_LINK
- [ ] Click **Save** (function app restarts)
- [ ] Wait for restart to complete

### Verify Configuration
- [ ] Check that DocFlow folder exists in SharePoint (Documents → DocFlow)
- [ ] Confirm all variables show correctly in portal (not *****)
- [ ] Test Graph API access: `GET /sites/{siteId}/drives`

### Storage Queue Configuration
- [ ] Verify `sharepoint-uploads` queue exists in storage account
- [ ] If missing, create it via Azure Portal
- [ ] Verify `blob-archive` queue still exists (don't break existing flow)

## Integration (1-2 hours)

### Update sendForSign Function
- [ ] Edit `src/functions/sendForSign/index.js`
- [ ] Add dual-queue enqueue (blob + SharePoint)
- [ ] Use `Promise.allSettled` for independent queuing
- [ ] Test locally (optional)
- [ ] Push to main branch (deploys automatically)

### Update adobeWebhook Function (Optional)
- [ ] Edit `src/functions/adobeWebhook/index.js`
- [ ] Add dual-queue enqueue (if implementing webhook-based flow)
- [ ] Push to main branch

### Test Integration
- [ ] Create test Monday item in onboarding board
- [ ] Fill in required fields (email, template, etc.)
- [ ] Send to Adobe Sign (triggers sendForSign)
- [ ] Monitor Application Insights logs
- [ ] Look for: `sendForSign-blob-queued`, `sendForSign-sharepoint-queued`
- [ ] Wait for both queues to process (5-10 seconds typical)

## Validation (30 minutes)

### Application Insights Logs
- [ ] Filter: `sharepoint-upload-start`
- [ ] Filter: `sharepoint-upload-success`
- [ ] Verify no `sharepoint-upload-failed` entries
- [ ] Check custom properties: agreementId, itemId, employeeName

### SharePoint Verification
- [ ] Go to SharePoint site → Documents
- [ ] Verify **DocFlow** folder exists
- [ ] Navigate: DocFlow → 2026 → 08 → [employee-name]
- [ ] Verify PDF file appears (within 10 seconds)
- [ ] Verify file has correct name (e.g., Document_1692123456789.pdf)
- [ ] Click file to open → Should download correctly

### Monday Verification
- [ ] Go to onboarding board
- [ ] Find test item
- [ ] Verify **link_signed** column has blob URL
- [ ] Verify **link_sharepoint** column has SharePoint URL
- [ ] Verify status is "Shared to SharePoint" or "Archived"
- [ ] Click both links → Should work and open PDFs

### Permissions Verification
- [ ] Log in as employee (test user)
- [ ] Go to SharePoint → Documents → DocFlow → 2026 → 08 → [employee-name]
- [ ] Verify employee can see folder and files
- [ ] Verify employee can read but not modify files
- [ ] (May take 5-10 min for permissions to propagate)

### Error Handling Verification
- [ ] Disable SHAREPOINT_ENABLED temporarily (set to false)
- [ ] Queue test message
- [ ] Verify function returns early (skipped)
- [ ] Re-enable SHAREPOINT_ENABLED
- [ ] Test with invalid credentials
- [ ] Verify error message in Application Insights
- [ ] Verify message goes to DLQ after retries

## Monitoring Setup (30 minutes)

### Application Insights Alerts

Create these alerts:

#### Alert 1: SharePoint Upload Failure Rate

```
Metric: Custom Events → sharepoint-upload-failed
Threshold: Count > 5 in 5 minutes
Severity: Medium
Action: Check SharePoint config, auth
```

#### Alert 2: All Uploads Failing

```
Query:
customEvents
| where name in ('blob-uploaded', 'sharepoint-upload-success')
| summarize count() by name
| where count_ == 0

Threshold: Any result
Severity: High
Action: Both systems down, investigate immediately
```

#### Alert 3: Blob Success but SharePoint Fails

```
Query:
customEvents
| where name == 'blob-uploaded'
| summarize BlobCount=count()
| union (customEvents | where name == 'sharepoint-upload-success' | summarize SPCount=count())
| where BlobCount > 10 and SPCount == 0

Threshold: Any result
Severity: High
Action: SharePoint system degraded
```

### Dashboard Setup

Create Azure Dashboard with these tiles:

1. **Archive Success Rate (last 24h)**
   - Metric: Custom Events blob-uploaded, sharepoint-upload-success

2. **Archive Error Count (last 24h)**
   - Metric: Custom Events blob-archive-error, sharepoint-upload-failed

3. **Function Execution Time**
   - Metric: Average execution duration (ms) for sharePointUploadFunction

4. **Queue Depth**
   - Metric: Queue length for blob-archive, sharepoint-uploads

### Document Repository Report

Create Monday automation (optional):

```
When: Daily
Action: Query Application Insights for upload counts
        Create report in HR Dashboard
```

## Post-Deployment (Ongoing)

### Day 1
- [ ] Monitor Application Insights continuously
- [ ] Check for errors every 30 minutes
- [ ] Verify folder structure is created correctly
- [ ] Test with 5+ sample employees

### Week 1
- [ ] Monitor error rates (should be < 2%)
- [ ] Verify permissions are working for employees
- [ ] Check performance (typical: 2-5 sec per document)
- [ ] Review logs for any anomalies
- [ ] Test with real employee onboarding flow

### Month 1
- [ ] Performance review (latency, throughput)
- [ ] Cost analysis (should be < $5/month)
- [ ] Security review (credentials, permissions)
- [ ] Capacity planning (% of quota used)
- [ ] Documentation updates

## Rollback Plan

If critical issues occur:

### Immediate (< 5 min)
```
Azure Portal → Function App → Settings → Configuration
Set: SHAREPOINT_ENABLED=false
Click: Save
```
- Functions will return early
- No errors thrown
- Blob archive continues normally

### Queue Cleanup (5-15 min)
1. Go to Storage Account → Queues
2. Select `sharepoint-uploads` queue
3. View messages (stuck messages)
4. Move to DLQ or delete

### Code Rollback (if needed)
```
GitHub → Releases → Revert to previous version
Or: Manually deploy previous version
```

### Restore Service (1-2 hours)
1. Fix underlying issue (auth, config, permissions)
2. Set SHAREPOINT_ENABLED=true
3. Monitor logs for success
4. Manually replay any DLQ messages if needed

## Production Readiness Checklist

- [ ] All tests pass locally
- [ ] Code deployed to main branch
- [ ] All environment variables set correctly
- [ ] SharePoint folder structure verified
- [ ] Monday board columns created
- [ ] Integration tested with sample document
- [ ] Permissions verified for test employee
- [ ] Error handling tested (config disabled, auth failed)
- [ ] Logs appear in Application Insights
- [ ] Alerts configured in Application Insights
- [ ] Dashboard created
- [ ] Documentation reviewed and updated
- [ ] Team trained on new SharePoint functionality
- [ ] Runbook created for troubleshooting
- [ ] Stakeholders notified of new feature

## Maintenance Tasks (Ongoing)

### Weekly
- [ ] Review Application Insights alerts
- [ ] Check queue depths (should be near 0)
- [ ] Verify no stuck messages

### Monthly
- [ ] Review cost (should be stable)
- [ ] Check error trends
- [ ] Verify employee access still working
- [ ] Review retention policies

### Quarterly
- [ ] Performance review
- [ ] Security audit
- [ ] Capacity planning
- [ ] Update documentation

### Annually
- [ ] Rotate client secret in Azure AD
- [ ] Audit all employee permissions
- [ ] Disaster recovery drill
- [ ] Update disaster recovery procedures

## Support Contacts

- **Application Issues:** Check APPLICATION_INSIGHTS logs
- **SharePoint API Issues:** Microsoft Graph Explorer + Docs
- **Azure Function Issues:** Azure Portal → Function App Logs
- **Monday Issues:** Check Monday API docs
- **Configuration Issues:** Review SHAREPOINT_SETUP_GUIDE.md

## Documentation References

- [SHAREPOINT_QUICK_REFERENCE.md](./SHAREPOINT_QUICK_REFERENCE.md) - One-page summary
- [SHAREPOINT_INTEGRATION_COMPLETE.md](./SHAREPOINT_INTEGRATION_COMPLETE.md) - Full documentation
- [SHAREPOINT_SETUP_GUIDE.md](./SHAREPOINT_SETUP_GUIDE.md) - Step-by-step setup
- [SHAREPOINT_INTEGRATION_WITH_WORKFLOW.md](./SHAREPOINT_INTEGRATION_WITH_WORKFLOW.md) - Workflow integration
- [SHAREPOINT_CODE_SNIPPETS.md](./SHAREPOINT_CODE_SNIPPETS.md) - Copy-paste code

## Sign-Off

- [ ] Dev: Code reviewed and tested
- [ ] QA: Integration tested
- [ ] DevOps: Infrastructure verified
- [ ] Security: Secrets management approved
- [ ] Product: Feature approved for production
- [ ] Francisco: Ready to deploy

**Deployment Date:** _______________  
**Deployed By:** _______________  
**Verified By:** _______________
