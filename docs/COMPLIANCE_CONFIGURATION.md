# DocFlow Compliance Configuration

## Environment Variables

Add these environment variables to Azure Key Vault and Function App Settings:

### Audit & Compliance Settings

```
# Audit Logging Retention (in days)
AUDIT_RETENTION_DAYS=2555                    # 7 years, HIPAA requirement

# Audit Report API Authentication
AUDIT_REPORT_API_KEY=<generate-random-key>   # Strong key for report access

# Compliance Mode
COMPLIANCE_STRICT_MODE=true                  # Enforce all compliance rules
COMPLIANCE_NAMESPACE=docflow                 # For multi-tenant setups

# Data Residency
ALLOWED_DATA_RESIDENCIES=us-east-1          # Comma-separated list
DEFAULT_DATA_RESIDENCY=us-east-1            # Default storage region

# Application Insights (optional but recommended)
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=...
```

### Example Key Vault Setup

```bash
# Create these secrets in Azure Key Vault
az keyvault secret set --vault-name "docflow-kv" \
  --name "audit-report-api-key" \
  --value "$(openssl rand -hex 32)"

az keyvault secret set --vault-name "docflow-kv" \
  --name "audit-retention-days" \
  --value "2555"

# Reference in Function App Settings:
@Microsoft.KeyVault(SecretUri=https://docflow-kv.vault.azure.net/secrets/audit-report-api-key/)
```

---

## Compliance Validator Configuration

### Initialization in Azure Functions

```javascript
// In function initialization code
const { ComplianceValidator } = require('../src/lib/complianceValidator');

const validator = new ComplianceValidator({
  strictMode: process.env.COMPLIANCE_STRICT_MODE === 'true',
  allowedDataResidencies: (process.env.ALLOWED_DATA_RESIDENCIES || 'us-east-1')
    .split(',')
    .map(s => s.trim()),
});

module.exports = { validator };
```

### Configuration Options

```javascript
const validator = new ComplianceValidator({
  // Enforce all validation rules strictly
  strictMode: true,
  
  // Allowed data residency locations
  allowedDataResidencies: ['us-east-1', 'eastus'],
  
  // Default retention period (configurable per organization)
  retentionYears: 7,
});

// Custom configuration for different compliance frameworks
const hipaaValidator = new ComplianceValidator({
  strictMode: true,
  allowedDataResidencies: ['us-east-1'], // HIPAA requires US-only storage
});

const gdprValidator = new ComplianceValidator({
  strictMode: true,
  allowedDataResidencies: ['northeurope', 'westeurope'], // EU-only
});
```

---

## Audit Logger Configuration

### Initialization in Azure Functions

```javascript
const { AuditLogger } = require('../src/lib/auditLogger');

const auditLogger = new AuditLogger({
  retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '2555'),
  namespace: process.env.COMPLIANCE_NAMESPACE || 'docflow',
});

module.exports = { auditLogger };
```

### Event Sourcing Configuration

The audit logger uses the existing event sourcing system. No additional configuration needed, but ensure:

1. **Blob Storage Containers:**
   - `events` - stores immutable audit events
   - `events-index` - stores metadata indexes

2. **Storage Account Settings:**
   - Enable versioning (for accidental deletion recovery)
   - Consider WORM policies (Write Once Read Many)
   - Enable georeplication for disaster recovery

```bash
# Enable versioning on events container
az storage container create \
  --name events \
  --account-name docflowstorage \
  --public-access off

# Enable blob versioning
az storage account blob-service-properties update \
  --account-name docflowstorage \
  --enable-versioning true
```

---

## Audit Report Function Configuration

### Function App Settings

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "DefaultEndpointsProtocol=https;...",
    "AUDIT_REPORT_API_KEY": "@Microsoft.KeyVault(SecretUri=...)",
    "AUDIT_RETENTION_DAYS": "2555",
    "ALLOWED_DATA_RESIDENCIES": "us-east-1"
  },
  "functionTimeout": "00:05:00"
}
```

### API Security

The `auditReportFunction` requires authentication:

```javascript
// API Key can be passed as:
// 1. Query parameter: ?accessKey=YOUR_KEY
// 2. Header: x-audit-key: YOUR_KEY

// Example with curl:
curl "https://doc-automation-func.azurewebsites.net/api/auditReport\
  ?startDate=2026-08-01\
  &endDate=2026-08-31\
  &accessKey=YOUR_API_KEY"

// Or with header:
curl -H "x-audit-key: YOUR_API_KEY" \
  "https://doc-automation-func.azurewebsites.net/api/auditReport\
  ?startDate=2026-08-01\
  &endDate=2026-08-31"
```

### Rate Limiting (Recommended)

Add Azure API Management or Azure Front Door for rate limiting:

```bash
# Example: Limit to 100 requests per hour
az apim api operation policy create \
  --resource-group docflow-rg \
  --api-management-instance docflow-apim \
  --api-id audit-report-api \
  --operation-id get \
  --policy "@rate-limit-policy.xml"
```

**rate-limit-policy.xml:**
```xml
<policies>
  <inbound>
    <rate-limit calls="100" renewal-period="3600" />
  </inbound>
</policies>
```

---

## Compliance Dashboard Configuration

### Hosting Options

#### Option 1: Azure Blob Storage (Static Website)
```bash
# Enable static website on blob storage
az storage blob service-properties update \
  --account-name docflowstorage \
  --static-website \
  --index-document index.html

# Upload dashboard
az storage blob upload \
  --account-name docflowstorage \
  --container-name '$web' \
  --name 'compliance-dashboard.html' \
  --file 'src/ui/complianceReportUI.html'

# Access at: https://docflowstorage.z13.web.core.windows.net/compliance-dashboard.html
```

#### Option 2: Azure App Service
```bash
# Create new App Service Plan
az appservice plan create \
  --name docflow-ui-plan \
  --resource-group docflow-rg \
  --sku B1 \
  --is-linux

# Create web app
az webapp create \
  --resource-group docflow-rg \
  --plan docflow-ui-plan \
  --name docflow-compliance-ui \
  --runtime "node|18"

# Deploy dashboard
cd src/ui && \
  zip -r dashboard.zip . && \
  az webapp up \
    --name docflow-compliance-ui \
    --resource-group docflow-rg
```

#### Option 3: SharePoint (Embedded in Monday)
Host in Monday.com document widget for integrated access.

### Dashboard Configuration

Edit the dashboard HTML to set your API endpoint:

```javascript
// In complianceReportUI.html, update:
const API_KEY = 'YOUR_AUDIT_API_KEY'; // From Key Vault
const API_BASE = 'https://doc-automation-func.azurewebsites.net'; // Your API
```

Or use environment variables:

```html
<script>
  // Load from server config
  fetch('/api/config')
    .then(r => r.json())
    .then(config => {
      window.API_KEY = config.auditReportApiKey;
      window.API_BASE = config.apiBase;
    });
</script>
```

---

## Monitoring & Alerting

### Application Insights Queries

#### 1. Compliance Violations
```kusto
customEvents
| where name == "compliance:data-residency-violation"
| summarize count() by tostring(customDimensions.violation)
| order by count_ desc
```

#### 2. Failed Validations
```kusto
customEvents
| where name startswith "compliance:validation"
| where customDimensions.isValid == "false"
| summarize count() by tostring(customDimensions.jobId)
```

#### 3. Signature Completion Time
```kusto
customEvents
| where name == "audit:signature-received"
| join kind=inner (
    customEvents
    | where name == "audit:signature-requested"
  ) on $left.customDimensions.jobId == $right.customDimensions.jobId
| extend completionTime = datetime_diff('minute', timestamp, timestamp1)
| summarize avg(completionTime), percentiles(completionTime, 50, 95)
```

#### 4. Audit Log Write Latency
```kusto
customEvents
| where name == "event-written"
| extend latency = todouble(customDimensions.duration)
| summarize avg(latency), p95=percentile(latency, 95), p99=percentile(latency, 99)
```

### Alert Configuration

```javascript
// Create alerts in Application Insights
[
  {
    name: "Data Residency Violation",
    query: `
      customEvents
      | where name == "compliance:data-residency-violation"
      | summarize count() by bin(timestamp, 1h)
      | where count_ > 0
    `,
    severity: 4, // Critical
    threshold: 1,
  },
  {
    name: "High Validation Failure Rate",
    query: `
      let total = customEvents
        | where name startswith "compliance:validation"
        | count;
      let failed = customEvents
        | where name startswith "compliance:validation"
        | where customDimensions.isValid == "false"
        | count;
      failed / total > 0.1
    `,
    severity: 3, // Warning
    threshold: 0.1,
  },
]
```

---

## Backup & Disaster Recovery

### Backup Strategy

```bash
# 1. Enable blob storage backup
az storage account blob-service-properties update \
  --account-name docflowstorage \
  --enable-versioning true \
  --enable-soft-delete true \
  --soft-delete-retention-days 30 \
  --enable-blob-soft-delete true

# 2. Enable geo-replication
az storage account update \
  --resource-group docflow-rg \
  --name docflowstorage \
  --sku Standard_GZRS  # Geo-zone-redundant storage

# 3. Create backup vault
az backup vault create \
  --resource-group docflow-rg \
  --name docflow-backup-vault \
  --location eastus

# 4. Enable backup for events container
az backup protection enable-for-vm \
  --vault-name docflow-backup-vault \
  --resource-group docflow-rg \
  --storage-account docflowstorage \
  --container-name events
```

### Disaster Recovery Plan

1. **RTO (Recovery Time Objective):** 4 hours
2. **RPO (Recovery Point Objective):** 24 hours
3. **Backup Frequency:** Daily snapshots
4. **Secondary Region:** West US (for geo-redundancy)
5. **Test Recovery:** Monthly DR drills

---

## Regulatory Compliance Checklists

### HIPAA Compliance Checklist

- [ ] Encryption in transit (HTTPS/TLS 1.2+)
- [ ] Encryption at rest (AES-256)
- [ ] Access controls and audit logging
- [ ] Backup and disaster recovery
- [ ] Data residency (US-only)
- [ ] Business Associate Agreement (BAA) with Azure
- [ ] Annual security risk assessment
- [ ] Employee training (annually)
- [ ] Incident response plan
- [ ] Breach notification procedures

### SOC 2 Compliance Checklist

- [ ] Access controls (CC6-CC9)
- [ ] Change management (CC7)
- [ ] Logical security (L1)
- [ ] Physical security (P1)
- [ ] Logical/physical access logging
- [ ] Annual SOC 2 Type II audit
- [ ] Documented security policies
- [ ] Encryption standards
- [ ] Monitoring and alerting
- [ ] Incident management

### GDPR Compliance Checklist (if processing EU data)

- [ ] Data Processing Agreement (DPA)
- [ ] Right to be forgotten (data deletion)
- [ ] Data portability features
- [ ] Consent management
- [ ] Privacy impact assessment
- [ ] Data transfer mechanisms (Standard Contractual Clauses)
- [ ] Breach notification (72-hour requirement)
- [ ] Privacy policy documentation

---

## Testing Configuration

### Local Development Setup

```bash
# 1. Start Azure Storage Emulator
azurite

# 2. Set environment variables
export STORAGE_ACCOUNT_NAME=devstoreaccount1
export STORAGE_ACCOUNT_KEY=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;...
export AUDIT_RETENTION_DAYS=2555
export AUDIT_REPORT_API_KEY=test-key-123
export COMPLIANCE_STRICT_MODE=true

# 3. Run tests
npm test -- --grep "audit|compliance"
```

### Integration Test Configuration

```javascript
// test/compliance.integration.test.js

const { AuditLogger } = require('../src/lib/auditLogger');
const { ComplianceValidator } = require('../src/lib/complianceValidator');
const eventSourcing = require('../src/lib/eventSourcing');

describe('Compliance Integration', () => {
  before(async () => {
    // Reset event sourcing for tests
    eventSourcing._reset();
  });

  it('should create complete audit trail', async () => {
    const auditLogger = new AuditLogger();
    const jobId = `test-${Date.now()}`;
    const hireData = {
      // ... complete hire data with all 25 fields
    };

    // Test workflow
    await auditLogger.logHireCreated(jobId, hireData);
    const validator = new ComplianceValidator();
    const validation = validator.validateADPFields(hireData);
    await auditLogger.logADPValidation(jobId, validation);

    // Verify
    const history = await eventSourcing.getHistory(jobId);
    assert(history.events.length >= 2);
  });
});
```

---

## Performance Tuning

### Blob Storage Optimization

```javascript
// For high-volume audit logging, use blob batching
async function batchWriteEvents(jobIds) {
  const batch = new BlobBatch();
  
  for (const jobId of jobIds) {
    const event = createAuditEvent(jobId);
    batch.addOperation(jobId, event);
  }
  
  // Write all in parallel
  await containerClient.submitBatch(batch);
}
```

### Query Performance

```javascript
// Use date-based pagination for large queries
async function getAuditLogsPaginated(startDate, endDate) {
  const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
  const pageSize = Math.ceil(days / 10); // 10 pages max
  
  for (let offset = 0; offset < days; offset += pageSize) {
    const pageStart = new Date(startDate.getTime() + offset * 24 * 60 * 60 * 1000);
    const pageEnd = new Date(pageStart.getTime() + pageSize * 24 * 60 * 60 * 1000);
    
    const events = await queryEventsByDateRange(pageStart, pageEnd);
    yield events;
  }
}
```

---

## Compliance Documentation

### Annual Compliance Report

Create an automated report generation:

```bash
#!/bin/bash
# generate-annual-compliance-report.sh

YEAR=$(date +%Y)
START_DATE="${YEAR}-01-01"
END_DATE="${YEAR}-12-31"

# Generate report
curl "https://doc-automation-func.azurewebsites.net/api/auditReport\
  ?startDate=${START_DATE}\
  &endDate=${END_DATE}\
  &format=html\
  &accessKey=${AUDIT_REPORT_API_KEY}" > "compliance_report_${YEAR}.html"

# Archive
az storage blob upload \
  --account-name docflowstorage \
  --container-name compliance-reports \
  --name "annual_report_${YEAR}.html" \
  --file "compliance_report_${YEAR}.html"
```

---

## Support & Next Steps

1. **Deploy** auditReportFunction to your environment
2. **Configure** environment variables in Key Vault
3. **Deploy** compliance dashboard
4. **Set up** monitoring and alerts
5. **Test** end-to-end audit trail
6. **Schedule** regular compliance reports
7. **Document** your compliance approach

---

**Last Updated:** 2026-08-17  
**Version:** 1.0
