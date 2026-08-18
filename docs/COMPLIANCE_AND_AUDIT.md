# DocFlow Compliance & Audit Logging System

## Overview

The DocFlow Compliance & Audit Logging System provides comprehensive tracking, validation, and reporting capabilities for document lifecycle management with support for HIPAA, SOC 2, and other regulatory frameworks.

**Key Features:**
- Immutable audit trail (7-year retention, configurable)
- Real-time compliance validation
- Digital signature chain verification
- Data residency compliance checking
- Document integrity verification (SHA-256 hashing)
- Multi-format export (JSON, CSV, HTML, PDF)
- Role-based access control

---

## System Architecture

### Core Components

#### 1. **auditLogger.js** (`src/lib/auditLogger.js`)
High-level audit logging library that tracks all DocFlow events.

**Features:**
- Hire creation and submission tracking
- ADP field validation logging
- PDF generation and failure tracking
- Adobe Sign signature events
- Document archival and access logging
- System error and compliance violation tracking
- User attribution (user ID, IP address, email)
- Sensitive data redaction

**Usage:**
```javascript
const { AuditLogger } = require('./auditLogger');
const auditLogger = new AuditLogger({ retentionDays: 2555 }); // 7 years

// Log hire creation
await auditLogger.logHireCreated(jobId, hireData, {
  userId: 'user123',
  userName: 'John Doe',
  userEmail: 'john@medwatchers.com',
  ipAddress: '192.168.1.1',
});

// Log ADP validation
await auditLogger.logADPValidation(jobId, validationResult, context);

// Log signature received
await auditLogger.logSignatureReceived(jobId, {
  adobeAgreementId: 'abc123',
  signerEmail: 'employee@example.com',
  signerName: 'Jane Smith',
  signedAt: new Date().toISOString(),
  signatureOrder: 2,
}, context);
```

#### 2. **complianceValidator.js** (`src/lib/complianceValidator.js`)
Validates compliance requirements and generates compliance reports.

**Features:**
- ADP field completeness validation (all 25 required fields)
- Field format validation (email, phone, numeric)
- Signature chain verification (3-signer serial process)
- Document integrity checking (SHA-256 hash comparison)
- Data residency verification (US-only storage)
- Multi-standard compliance checking (HIPAA, SOC 2, etc.)

**Usage:**
```javascript
const { ComplianceValidator } = require('./complianceValidator');
const validator = new ComplianceValidator({
  strictMode: true,
  allowedDataResidencies: ['us-east-1'],
});

// Validate ADP fields
const adpValidation = validator.validateADPFields(hireData);
console.log(adpValidation.isValid, adpValidation.completeness);

// Verify signature chain
const signatureChain = await validator.verifySignatureChain(jobId, hireData);
console.log(signatureChain.isComplete, signatureChain.signers);

// Check data residency
const residency = validator.verifyDataResidency(archiveData);
console.log(residency.isCompliant, residency.violations);

// Generate comprehensive report
const report = await validator.generateComplianceReport(jobId, hireData, archiveData);
```

#### 3. **auditReportFunction** (Azure Function)
HTTP-triggered Azure Function for querying and exporting audit logs.

**Endpoint:** `GET /api/auditReport`

**Query Parameters:**
- `startDate` (required): ISO date string (YYYY-MM-DD)
- `endDate` (required): ISO date string (YYYY-MM-DD)
- `jobId` (optional): Filter by specific job ID
- `employeeEmail` (optional): Filter by employee email
- `status` (optional): Filter by status (all, compliant, non-compliant, pending)
- `format` (optional): Export format (json, csv, html, pdf) - default: json
- `accessKey` (required): API authentication key

**Example:**
```bash
curl "https://doc-automation-func.azurewebsites.net/api/auditReport?startDate=2026-08-01&endDate=2026-08-31&format=csv&accessKey=YOUR_API_KEY"
```

#### 4. **complianceReportUI.html** (`src/ui/complianceReportUI.html`)
Modern web dashboard for viewing compliance and audit data.

**Features:**
- Date range filtering
- Job/employee search
- Status filtering (compliant, non-compliant, pending)
- Real-time dashboard with key metrics
- Event timeline visualization
- Document integrity verification
- Multi-format export
- Mobile-responsive design

---

## Audit Event Types

All events are immutable and stored in Azure Blob Storage under `/events/{jobId}/`.

### Lifecycle Events

| Event | Description |
|-------|-------------|
| `audit:hire-created` | New hire initiated from Monday |
| `audit:hire-submitted` | Hire submission triggered |
| `audit:adp-validation-passed` | All 25 ADP fields valid |
| `audit:adp-validation-failed` | ADP validation failed |
| `audit:adp-field-changed` | Individual field change recorded |
| `audit:pdf-generation-started` | PDF generation initiated |
| `audit:pdf-generation-completed` | PDF successfully generated |
| `audit:pdf-generation-failed` | PDF generation failed |
| `audit:signature-requested` | Document sent for signing |
| `audit:signature-received` | Signer completed signing |
| `audit:signature-failed` | Signature process failed |
| `audit:document-archived` | Document archived to blob storage |
| `audit:document-stored-sharepoint` | Document uploaded to SharePoint |
| `audit:document-accessed` | Document accessed for viewing |
| `audit:document-exported` | Document exported for audit/reporting |
| `audit:compliance-check-performed` | Compliance validation executed |
| `audit:system-error` | System error occurred |
| `audit:data-residency-violation` | Data residency compliance violation |

### Event Structure

```json
{
  "eventId": "1724092345123-abc123def456",
  "jobId": "monday-item-12345",
  "timestamp": "2026-08-14T10:30:45.123Z",
  "sequence": 42,
  "eventType": "audit:signature-received",
  "data": {
    "adobeAgreementId": "abc123",
    "signerEmail": "jane@example.com",
    "signerName": "Jane Smith",
    "signedAt": "2026-08-14T10:25:00.000Z",
    "signatureOrder": 2,
    "signatureHash": "sha256_hash_here"
  },
  "metadata": {
    "userId": "user123",
    "userName": "John Doe",
    "userEmail": "john@medwatchers.com",
    "ipAddress": "192.168.1.1",
    "source": "adobe-webhook",
    "severity": "info"
  }
}
```

---

## Compliance Frameworks

### HIPAA Compliance

**Applicable if:** Processing health information (HIPAA-covered entities and business associates)

**DocFlow Controls:**
1. **Access Control**
   - User authentication and authorization
   - IP tracking and audit logging
   - Role-based access to documents

2. **Audit & Accountability**
   - 7-year audit trail retention
   - All actions logged with user attribution
   - Immutable event sourcing prevents tampering

3. **Integrity & Confidentiality**
   - SHA-256 document integrity hashing
   - Encrypted storage (AES-256)
   - US-only data residency (no cross-border transfers)

4. **Documentation**
   - Comprehensive audit reports
   - Change history tracking
   - Error and incident logging

**Configuration:**
```javascript
const auditLogger = new AuditLogger({
  retentionDays: 2555, // 7 years HIPAA requirement
  namespace: 'docflow-hipaa',
});

const validator = new ComplianceValidator({
  strictMode: true, // Enforce all validation rules
  allowedDataResidencies: ['us-east-1'], // US-only for HIPAA
});
```

### SOC 2 Compliance

**Applicable for:** Service organizations providing services to other organizations

**DocFlow Controls:**
1. **Access Control (CC6-CC9)**
   - Authentication and authorization
   - Principle of least privilege
   - Audit logging

2. **Change Management (CC7)**
   - Document version tracking
   - Change history with timestamps
   - Approval workflows (3-signer requirement)

3. **Monitoring & Incident Management**
   - Real-time error tracking
   - System health monitoring
   - Incident response logging

4. **Encryption & Key Management**
   - AES-256 encryption for stored documents
   - SHA-256 hashing for integrity
   - Encrypted transport (HTTPS/TLS)

**SOC 2 Assertion:**
```
Trust Service Criteria: Security (CC - Common Criteria)
- CC1: Organization obtains or generates information
- CC6: Access control policies and procedures
- CC7: System monitoring
- CC9: Change management

DocFlow provides logging and audit trails to support these criteria.
```

### Data Residency & Localization

**Default Configuration:**
- PDF storage: US East 1 (Azure eastus)
- Archive storage: US East 1
- SharePoint: US East 1

**Enforcement:**
```javascript
validator.verifyDataResidency({
  pdfLocation: 'https://docflowstorage.blob.core.windows.net/pdf-archive/...',
  archiveLocation: 'https://docflowstorage.blob.core.windows.net/pdf-archive/...',
  sharePointUrl: 'https://medwatchers.sharepoint.com/sites/...',
});
```

### Digital Signature Requirements

**DocFlow Signature Chain:**
1. **Order 0 - HR Representative**
   - Email: hr@medwatchers.com
   - Role: Initial review and approval

2. **Order 1 - Manager**
   - Email: Resolved from supervisor field
   - Role: Management approval

3. **Order 2 - Employee**
   - Email: Resolved from workEmail field
   - Role: Final acknowledgment and agreement

**Verification:**
```javascript
const signatureChain = await validator.verifySignatureChain(jobId, hireData);
// Returns: { isComplete, signers: [...], missingSigners: [...] }
```

---

## ADP Field Validation (25 Required Fields)

### Personal Information (4 fields)
- `firstName`: Employee first name
- `lastName`: Employee last name
- `workEmail`: Corporate email address
- `badgeNumber`: Badge ID

### Job Details (6 fields)
- `adpJobTitle`: Job title from ADP
- `adpDepartment`: Department assignment
- `adpWorkLocation`: Work location
- `workerType`: Employment type (full-time, part-time, contractor)
- `supervisor`: Manager email/ID
- `reasonForHire`: Hire reason/justification

### Compensation (5 fields)
- `payType`: Salary, hourly, or contract
- `payRate`: Compensation amount
- `payFrequency`: Pay frequency (weekly, bi-weekly, monthly)
- `companyCode`: Company cost center
- `payClass`: Pay classification

### Compliance (3 fields)
- `flsaStatus`: FLSA classification (exempt/non-exempt)
- `suiSdiTaxCode`: State tax code
- `workersCompStatus`: Workers' comp classification

### Workers' Compensation (3 fields)
- `workersCompJobClass`: Job class for comp insurance
- `workedInState`: States where employee has worked
- `livedInState`: States where employee has lived

### Other (4 fields)
- `timeZone`: Employee time zone
- `benefitsEligibility`: Benefits eligibility status
- `benefitsEligibilityClass`: Specific benefits class
- `onboardingExperience`: Experience level/track

---

## Using Audit Logger in Functions

### Example: Integration in mondayWebhook

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');
const auditLogger = new AuditLogger();

async function processHireCreated(hireData, context) {
  const jobId = hireData.mondayItemId;

  // Log hire creation
  await auditLogger.logHireCreated(jobId, hireData, {
    userId: context.req.user?.oid || 'webhook',
    userName: 'Monday Automation',
    userEmail: 'automation@medwatchers.com',
    ipAddress: context.req.ip || context.req.headers['x-forwarded-for'],
  });

  // Validate ADP fields
  const validator = new ComplianceValidator();
  const validation = validator.validateADPFields(hireData);

  // Log validation result
  await auditLogger.logADPValidation(jobId, validation, {
    userId: 'system',
    source: 'monday-webhook',
  });

  if (!validation.isValid) {
    await auditLogger.logADPValidation(jobId, {
      ...validation,
      isValid: false,
    }, { userId: 'system' });
    return { status: 'error', message: 'Missing required fields' };
  }

  // Queue PDF generation
  await queue.sendMessage('generatePDF', { jobId, hireData });

  return { status: 'success', jobId };
}
```

### Example: Integration in PDF Generation

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');
const auditLogger = new AuditLogger();

async function generatePDF(jobId, hireData) {
  const startTime = Date.now();

  try {
    // Generate PDF
    const pdf = await adobeService.generatePDF(hireData);

    // Log success
    await auditLogger.logPDFGeneration(jobId, {
      pdfUrl: pdf.url,
      fileSizeBytes: pdf.size,
      fileName: pdf.filename,
      duration: Date.now() - startTime,
    }, { userId: 'pdf-generator' });

    return pdf;
  } catch (error) {
    // Log failure
    await auditLogger.logPDFGenerationFailed(jobId, error, {
      userId: 'pdf-generator',
      component: 'pdf-generator',
    });

    throw error;
  }
}
```

### Example: Integration in Adobe Sign Webhook

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');
const auditLogger = new AuditLogger();

async function handleAdobeSignWebhook(webhookData) {
  const jobId = webhookData.jobId;

  if (webhookData.status === 'signed') {
    await auditLogger.logSignatureReceived(jobId, {
      adobeAgreementId: webhookData.agreementId,
      signerEmail: webhookData.signerEmail,
      signerName: webhookData.signerName,
      signedAt: webhookData.signedDate,
      signatureOrder: webhookData.signerOrder,
    }, { userId: 'adobe-webhook', source: 'adobe-sign' });
  } else if (webhookData.status === 'rejected') {
    await auditLogger.logSignatureFailed(jobId, new Error('Signature rejected'), webhookData.signerEmail, {
      userId: 'adobe-webhook',
    });
  }
}
```

---

## Querying Audit Logs

### Using eventSourcing Directly

```javascript
const eventSourcing = require('./src/lib/eventSourcing');

// Get all events for a job
const history = await eventSourcing.getHistory(jobId, { limit: 1000 });
console.log(history.events); // Array of audit events

// Get events in a date range
const replay = await eventSourcing.replayFrom(jobId, {
  fromTimestamp: '2026-08-01T00:00:00Z',
  toTimestamp: '2026-08-31T23:59:59Z',
});

// Replay to compute state
const state = await eventSourcing.reduceEvents(jobId, {}, (state, event) => {
  if (event.eventType === 'audit:signature-received') {
    if (!state.signatures) state.signatures = [];
    state.signatures.push(event.data);
  }
  return state;
});
```

### Using Audit Report Function

```bash
# Get all jobs for August 2026 as CSV
curl "https://doc-automation-func.azurewebsites.net/api/auditReport\
  ?startDate=2026-08-01\
  &endDate=2026-08-31\
  &format=csv\
  &accessKey=YOUR_API_KEY" > audit_report.csv

# Get specific employee's audit trail
curl "https://doc-automation-func.azurewebsites.net/api/auditReport\
  ?startDate=2026-08-01\
  &endDate=2026-08-31\
  &employeeEmail=jane@example.com\
  &format=json\
  &accessKey=YOUR_API_KEY" | jq .
```

---

## Generating Compliance Reports

### Command Line

```javascript
const { ComplianceValidator } = require('./src/lib/complianceValidator');
const validator = new ComplianceValidator();

// Generate report
const report = await validator.generateComplianceReport(jobId, hireData, {
  pdfLocation: 'https://...',
  archiveLocation: 'https://...',
  sharePointUrl: 'https://...',
  contentHash: '...',
  archiveHash: '...',
});

// Export in different formats
const jsonReport = validator.exportReport(report, 'json');
const csvReport = validator.exportReport(report, 'csv');
const htmlReport = validator.exportReport(report, 'html');
```

### From Compliance UI

1. Navigate to compliance dashboard
2. Set date range
3. Apply filters (employee, status, etc.)
4. Click "Export Report"
5. Choose format (JSON, CSV, HTML)

---

## Sensitive Data Handling

### Data Redaction

The audit logger automatically redacts sensitive fields in logs:

**Redacted Fields:**
- `socialSecurityNumber`
- `bankAccount`
- `routingNumber`
- `workEmail` (partially masked in logs)

**Example:**
```javascript
// In logs, appears as:
{
  "workEmail": "***n@example.com"
}
```

### PII Protection

All personally identifiable information (PII) is:
1. Encrypted in storage (AES-256)
2. Masked in audit logs when possible
3. Tracked with user access
4. Automatically purged after retention period

---

## Audit Retention & Deletion

### Default Retention
- **Period:** 7 years (2555 days)
- **Expiry Date:** Automatically computed at archival time
- **Configurable:** Via `AuditLogger` constructor

### GDPR/Privacy Deletion
```javascript
// Delete all events for a specific job (GDPR right to be forgotten)
await eventSourcing.deleteJob(jobId);

// Retention expiry is logged for compliance audits
```

---

## Security & Access Control

### API Key Management
- Store `AUDIT_REPORT_API_KEY` in Azure Key Vault
- Rotate keys quarterly
- Log all report access requests
- Monitor for suspicious patterns

### Audit Trail Security
- Events are immutable (append-only)
- Blob storage WORM (Write Once Read Many) mode recommended
- Requires authentication for retrieval
- Cross-region replication for disaster recovery

---

## Testing & Validation

### Unit Tests
```javascript
// Test ADP validation
const validator = new ComplianceValidator();
const result = validator.validateADPFields({
  firstName: 'John',
  lastName: 'Doe',
  // ... 23 more fields
});
assert(result.isValid === true);
assert(result.completeness === 100);

// Test signature chain
const chain = await validator.verifySignatureChain(jobId, hireData);
assert(chain.isComplete === true);
assert(chain.signers.length === 3);
```

### Integration Tests
- Test end-to-end audit trail with mock data
- Verify immutability of stored events
- Confirm compliance report accuracy
- Test export functionality

---

## Monitoring & Alerts

### Key Metrics
- Audit event write latency
- Validation failure rate
- Signature completion time
- Data residency violations (critical)
- Storage quota usage

### Recommended Alerts
```javascript
// Alert on validation failures
logger.event('compliance:validation-failed', {
  jobId,
  missingFields: ['firstName', 'lastName'],
  severity: 'high',
});

// Alert on data residency violations
if (!residency.isCompliant) {
  logger.event('compliance:data-residency-violation', {
    violation: residency.violations[0],
    severity: 'critical',
  });
}
```

---

## Troubleshooting

### Event Not Appearing in Audit Log
1. Check that event sourcing containers exist (`events`, `events-index`)
2. Verify storage account credentials
3. Check for WARP SSL issues (az storage workaround)
4. Verify event was actually written (check logs for errors)

### Compliance Report Empty
1. Confirm date range includes events
2. Verify API key is correct
3. Check blob storage access permissions
4. Ensure events exist for the date range

### Signature Chain Incomplete
1. Verify all 3 signers have valid email addresses
2. Check Adobe Sign webhook is receiving events
3. Confirm `signPoller` function is running
4. Check for Adobe API rate limits

---

## Support & Documentation

- **Audit Logger Issues:** Check `src/lib/auditLogger.js` implementation
- **Compliance Validation:** See `src/lib/complianceValidator.js`
- **Report Generation:** Review `auditReportFunction/index.js`
- **Dashboard:** Access `src/ui/complianceReportUI.html`

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-08-17 | Initial release with HIPAA, SOC 2, and compliance support |

---

**Last Updated:** 2026-08-17  
**Maintained By:** DocFlow Compliance Team  
**Classification:** Internal Use Only
