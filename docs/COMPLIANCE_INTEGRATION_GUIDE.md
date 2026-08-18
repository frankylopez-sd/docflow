# DocFlow Compliance Integration Guide

This guide shows how to integrate the audit logging and compliance validation system into existing DocFlow Azure Functions.

---

## Quick Start: 5-Minute Integration

### Step 1: Update package.json
No new dependencies needed - uses existing `@azure/storage-blob` and `@azure/identity`.

### Step 2: Import in Your Functions
```javascript
const { AuditLogger } = require('../src/lib/auditLogger');
const { ComplianceValidator } = require('../src/lib/complianceValidator');
const eventSourcing = require('../src/lib/eventSourcing');

// Initialize (do once, reuse instance)
const auditLogger = new AuditLogger();
const validator = new ComplianceValidator();
```

### Step 3: Log Events
Add 1-3 lines to each function to log important events.

---

## Integration by Function

### mondayWebhook - HTTP Trigger

**Location:** `mondayWebhook/index.js`

**Current:** Receives hire creation from Monday, validates, queues PDF generation

**Add Audit Logging:**

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');
const { ComplianceValidator } = require('../src/lib/complianceValidator');

const auditLogger = new AuditLogger();
const validator = new ComplianceValidator();

module.exports = async function (context, req) {
  try {
    // Existing validation code...
    const { hireData, itemId } = parseMonday(req.body);

    // *** ADD: Log hire creation ***
    await auditLogger.logHireCreated(itemId, hireData, {
      userId: req.headers['x-user-id'] || 'webhook',
      ipAddress: req.headers['x-forwarded-for']?.split(',')[0],
      source: 'monday-webhook',
    });

    // *** ADD: Validate ADP fields ***
    const validation = validator.validateADPFields(hireData);
    await auditLogger.logADPValidation(itemId, validation, {
      userId: 'system',
      source: 'mondayWebhook',
    });

    if (!validation.isValid) {
      // Update Monday status to "Missing Fields"
      await monday.updateItemStatus(itemId, 'Missing Fields');
      return { status: 400, body: JSON.stringify(validation) };
    }

    // Queue PDF generation (existing code)
    await queueMessage('generatePDF', { itemId, hireData });

    return { status: 202, body: JSON.stringify({ status: 'queued' }) };
  } catch (error) {
    logger.error('mondayWebhook-error', error, { itemId: req.body?.id });
    await auditLogger.logSystemError(req.body?.id, error, {
      component: 'mondayWebhook',
      userId: 'system',
    });
    throw error;
  }
};
```

**Lines Added:** ~15 (audit logging)

---

### generatePDF - Queue Trigger

**Location:** `generatePDF/index.js`

**Current:** Receives hire from queue, calls Adobe PDF Services, returns PDF URL

**Add Audit Logging:**

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');

const auditLogger = new AuditLogger();

module.exports = async function (context, queueItem) {
  const { itemId, hireData } = queueItem;
  const startTime = Date.now();

  try {
    // *** ADD: Log generation started ***
    context.log(`[${itemId}] Generating PDF...`);

    // Existing PDF generation code...
    const pdf = await adobe.generatePDF(hireData);

    // *** ADD: Log success ***
    await auditLogger.logPDFGeneration(itemId, {
      pdfUrl: pdf.url,
      fileSizeBytes: pdf.size,
      fileName: `onboarding-${itemId}.pdf`,
      duration: Date.now() - startTime,
    }, { userId: 'pdf-generator' });

    // Store PDF URL in Monday (existing)
    await monday.updateItemField(itemId, 'PDF_URL', pdf.url);

    context.done();
  } catch (error) {
    context.log.error(`[${itemId}] PDF generation failed: ${error.message}`);

    // *** ADD: Log failure ***
    await auditLogger.logPDFGenerationFailed(itemId, error, {
      component: 'generatePDF',
      userId: 'system',
    });

    // Update status to "PDF Generation Failed"
    await monday.updateItemStatus(itemId, 'PDF Generation Failed');

    throw error;
  }
};
```

**Lines Added:** ~12

---

### sendForSign - Queue Trigger

**Location:** `sendForSign/index.js`

**Current:** Receives PDF URL, creates Adobe Sign agreement, queues signing

**Add Audit Logging:**

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');

const auditLogger = new AuditLogger();

module.exports = async function (context, queueItem) {
  const { itemId, hireData, pdfUrl } = queueItem;

  try {
    // Existing Adobe Sign setup...
    const agreement = await adobe.createSigningAgreement({
      pdfUrl,
      signers: [
        { email: 'hr@medwatchers.com', name: 'HR Team', order: 0 },
        { email: hireData.supervisor || 'manager@medwatchers.com', name: 'Manager', order: 1 },
        { email: hireData.workEmail, name: `${hireData.firstName} ${hireData.lastName}`, order: 2 },
      ],
    });

    // *** ADD: Log signature request ***
    await auditLogger.logSignatureRequested(itemId, {
      adobeAgreementId: agreement.id,
      signers: [
        { email: 'hr@medwatchers.com', name: 'HR Team', order: 0 },
        { email: hireData.supervisor || 'manager@medwatchers.com', name: 'Manager', order: 1 },
        { email: hireData.workEmail, name: `${hireData.firstName} ${hireData.lastName}`, order: 2 },
      ],
    }, { userId: 'adobe-sign' });

    // Store agreement ID for webhook (existing)
    await monday.updateItemField(itemId, 'ADOBE_AGREEMENT_ID', agreement.id);
    await monday.updateItemStatus(itemId, 'Sent for Signature');

    context.done();
  } catch (error) {
    context.log.error(`[${itemId}] Sign request failed: ${error.message}`);

    // *** ADD: Log failure ***
    await auditLogger.logSignatureFailed(itemId, error, 'hr@medwatchers.com', {
      component: 'sendForSign',
      userId: 'system',
    });

    await monday.updateItemStatus(itemId, 'Sign Request Failed');
    throw error;
  }
};
```

**Lines Added:** ~13

---

### adobeWebhook - HTTP Trigger

**Location:** `adobeWebhook/index.js`

**Current:** Receives signature completion from Adobe Sign

**Add Audit Logging:**

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');

const auditLogger = new AuditLogger();

module.exports = async function (context, req) {
  try {
    const event = req.body;

    // Existing webhook validation...
    if (event.resourceEventType === 'AGREEMENT_ALL_DOCUMENTS_SIGNED') {
      const itemId = event.custom.itemId;
      const signerEmail = event.custom.signerEmail;

      // *** ADD: Log signature received ***
      await auditLogger.logSignatureReceived(itemId, {
        adobeAgreementId: event.id,
        signerEmail,
        signerName: event.custom.signerName,
        signedAt: new Date().toISOString(),
        signatureOrder: event.custom.signerOrder,
      }, { userId: 'adobe-webhook', source: 'adobe-sign' });

      // Queue archival (existing)
      await queueMessage('archiveToBlob', { itemId, agreementId: event.id });
    }

    return { status: 200, body: JSON.stringify({ success: true }) };
  } catch (error) {
    context.log.error(`Adobe webhook error: ${error.message}`);

    // *** ADD: Log webhook error ***
    await auditLogger.logSystemError(
      req.body?.custom?.itemId || 'unknown',
      error,
      { component: 'adobeWebhook', userId: 'system' }
    );

    throw error;
  }
};
```

**Lines Added:** ~15

---

### archiveToBlob - Queue Trigger

**Location:** `archiveToBlob/index.js`

**Current:** Downloads signed PDF, stores in blob archive

**Add Audit Logging:**

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');
const crypto = require('crypto');

const auditLogger = new AuditLogger();

module.exports = async function (context, queueItem) {
  const { itemId, agreementId } = queueItem;

  try {
    // Download from Adobe
    const pdfBuffer = await adobe.downloadSignedPDF(agreementId);

    // *** ADD: Compute hash for integrity ***
    const contentHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

    // Store in blob
    const blobUrl = await blob.upload(
      'pdf-archive',
      `${itemId}/${agreementId}.pdf`,
      pdfBuffer
    );

    // *** ADD: Log archival with hash ***
    await auditLogger.logDocumentArchived(itemId, {
      archiveLocation: blobUrl,
      fileName: `${itemId}-signed.pdf`,
      fileSizeBytes: pdfBuffer.length,
      archiveHash: contentHash,
      dataResidency: 'us-east-1',
      encryptionAlgorithm: 'AES-256',
    }, { userId: 'archive-service' });

    // Update Monday (existing)
    await monday.updateItemField(itemId, 'ARCHIVE_URL', blobUrl);
    await monday.updateItemStatus(itemId, 'Completed');

    context.done();
  } catch (error) {
    context.log.error(`[${itemId}] Archive failed: ${error.message}`);

    // *** ADD: Log archive failure ***
    await auditLogger.logSystemError(itemId, error, {
      component: 'archiveToBlob',
      userId: 'system',
    });

    throw error;
  }
};
```

**Lines Added:** ~16

---

### uploadToSharePoint - Queue Trigger

**Location:** `uploadToSharePoint/index.js`

**Current:** Uploads signed PDF to SharePoint library

**Add Audit Logging:**

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');

const auditLogger = new AuditLogger();

module.exports = async function (context, queueItem) {
  const { itemId, blobUrl, hireData } = queueItem;

  try {
    // Download from blob
    const pdfBuffer = await blob.download(blobUrl);

    // Upload to SharePoint
    const spResult = await sharepoint.upload(
      '/sites/HR/Shared Documents/Onboarding',
      `${hireData.firstName}_${hireData.lastName}_${itemId}.pdf`,
      pdfBuffer
    );

    // *** ADD: Log SharePoint upload ***
    await auditLogger.logDocumentStoredSharePoint(itemId, {
      sharePointUrl: spResult.webUrl,
      siteId: spResult.siteId,
      libraryId: spResult.libraryId,
      itemId: spResult.itemId,
      fileName: spResult.name,
    }, { userId: 'sharepoint-service' });

    // Update Monday (existing)
    await monday.updateItemField(itemId, 'SHAREPOINT_URL', spResult.webUrl);

    context.done();
  } catch (error) {
    context.log.error(`[${itemId}] SharePoint upload failed: ${error.message}`);

    // *** ADD: Log error ***
    await auditLogger.logSystemError(itemId, error, {
      component: 'uploadToSharePoint',
      userId: 'system',
    });

    throw error;
  }
};
```

**Lines Added:** ~15

---

### validateADP - HTTP Trigger

**Location:** `validateADP/index.js`

**Current:** API endpoint for on-demand ADP validation

**Add Audit Logging:**

```javascript
const { ComplianceValidator } = require('../src/lib/complianceValidator');
const { AuditLogger } = require('../src/lib/auditLogger');

const validator = new ComplianceValidator();
const auditLogger = new AuditLogger();

module.exports = async function (context, req) {
  try {
    const { hireData, itemId } = req.body;

    // *** ADD: Log validation request ***
    context.log(`[${itemId}] ADP validation requested`);

    // Validate ADP fields
    const result = validator.validateADPFields(hireData);

    // *** ADD: Log validation result ***
    await auditLogger.logADPValidation(itemId, result, {
      userId: req.headers['x-user-id'] || 'api',
      ipAddress: req.headers['x-forwarded-for']?.split(',')[0],
      source: 'validateADP-http',
    });

    return {
      status: 200,
      body: JSON.stringify({
        isValid: result.isValid,
        completeness: result.completeness,
        missingFields: result.missingFields,
      }),
    };
  } catch (error) {
    context.log.error(`Validation error: ${error.message}`);

    // *** ADD: Log error ***
    await auditLogger.logSystemError(req.body?.itemId || 'unknown', error, {
      component: 'validateADP',
      userId: req.headers['x-user-id'] || 'api',
    });

    return {
      status: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
```

**Lines Added:** ~18

---

## Integration Checklist

- [ ] Import `AuditLogger` and `ComplianceValidator` in each function
- [ ] Add audit logging calls to key business events
- [ ] Log hire creation in `mondayWebhook`
- [ ] Log ADP validation in `mondayWebhook` and `validateADP`
- [ ] Log PDF generation in `generatePDF` (success and failure)
- [ ] Log signature requests in `sendForSign`
- [ ] Log signature receipts in `adobeWebhook`
- [ ] Log archival in `archiveToBlob`
- [ ] Log SharePoint uploads in `uploadToSharePoint`
- [ ] Log system errors in exception handlers
- [ ] Test audit logging with `DOCFLOW_LOG_SILENT=true` disabled
- [ ] Deploy `auditReportFunction` Azure Function
- [ ] Set `AUDIT_REPORT_API_KEY` in Key Vault
- [ ] Deploy compliance dashboard (`complianceReportUI.html`)
- [ ] Configure App Insights (optional but recommended)

---

## Testing Audit Integration

### Unit Test Example

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');
const { ComplianceValidator } = require('../src/lib/complianceValidator');
const eventSourcing = require('../src/lib/eventSourcing');

describe('Audit Logging Integration', () => {
  it('should log hire creation and validation', async () => {
    const auditLogger = new AuditLogger();
    const validator = new ComplianceValidator();
    const jobId = 'test-job-123';

    const hireData = {
      firstName: 'John',
      lastName: 'Doe',
      workEmail: 'john@example.com',
      badgeNumber: 'BD123',
      // ... other 21 fields
    };

    // Log creation
    await auditLogger.logHireCreated(jobId, hireData, {
      userId: 'test-user',
      ipAddress: '127.0.0.1',
    });

    // Validate
    const validation = validator.validateADPFields(hireData);
    await auditLogger.logADPValidation(jobId, validation, {
      userId: 'test-user',
    });

    // Verify events were written
    const history = await eventSourcing.getHistory(jobId);
    assert(history.events.length >= 2);
    assert(history.events[0].eventType.includes('hire-created'));
    assert(history.events[1].eventType.includes('adp-validation'));
  });
});
```

### Manual Testing

```bash
# 1. Start local Azure Storage emulator
azurite

# 2. Run function locally
func start

# 3. Trigger workflow with test data
curl -X POST http://localhost:7071/api/mondayWebhook \
  -H "Content-Type: application/json" \
  -d @test-hire-data.json

# 4. Query audit logs via eventSourcing or auditReportFunction
curl "http://localhost:7071/api/auditReport?startDate=2026-08-01&endDate=2026-08-31&format=json&accessKey=test-key"
```

---

## Compliance Reporting Workflow

### Step 1: Weekly Compliance Checks
Run compliance validation on all jobs from the past week:
```javascript
async function weeklyComplianceCheck() {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const jobs = await eventSourcing.listJobs();
  
  for (const jobId of jobs) {
    const status = await auditLogger.getComplianceStatus(jobId);
    if (!status.isCompliant) {
      // Alert or escalate
      logger.warn('compliance:non-compliant-job', { jobId, status });
    }
  }
}
```

### Step 2: Monthly Audit Report
Export monthly compliance report:
```bash
curl "https://doc-automation-func.azurewebsites.net/api/auditReport\
  ?startDate=2026-08-01&endDate=2026-08-31\
  &format=html\
  &accessKey=YOUR_API_KEY" > monthly_compliance_report.html
```

### Step 3: Yearly Certification
Generate annual certification for compliance frameworks (HIPAA, SOC 2).

---

## Performance Considerations

### Event Sourcing Performance
- Event writes are fast (~50ms avg)
- Batch reads for large date ranges (pagination)
- Consider indexes for frequently filtered fields

### Audit Storage
- Events container grows ~1KB per event
- Plan for 1-2 GB per 1M jobs processed
- 7-year retention = ~10-20 GB for typical volumes

### Query Performance
- Date range queries are efficient (blob prefix search)
- Large date ranges (>1 year) may take 30-60 seconds
- Add `limit` parameter for pagination

---

## Troubleshooting Integration

### Events Not Being Written
1. Check `APPLICATIONINSIGHTS_CONNECTION_STRING` is set
2. Verify storage account credentials
3. Check `DOCFLOW_LOG_SILENT` is not set to true in production
4. Confirm containers exist (`events`, `events-index`)

### Compliance Report Empty
1. Verify API key is correct
2. Check date range includes actual events
3. Ensure events have correct `eventType` format
4. Confirm blob storage access permissions

### Performance Slow
1. Reduce date range for queries
2. Use pagination (`skip` and `limit` parameters)
3. Confirm storage account is in same region as functions
4. Check storage account performance tier

---

## Next Steps

1. **Review** the compliance documentation: `docs/COMPLIANCE_AND_AUDIT.md`
2. **Integrate** audit logging into all functions using this guide
3. **Deploy** the `auditReportFunction` Azure Function
4. **Configure** the compliance dashboard
5. **Test** end-to-end audit trail
6. **Monitor** audit logs and compliance status

---

**Last Updated:** 2026-08-17
