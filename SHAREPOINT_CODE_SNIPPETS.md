# SharePoint Integration - Code Snippets

Copy-paste code for integrating SharePoint into existing DocFlow functions.

## 1. Queue Both Blob & SharePoint (Parallel)

**Use in:** sendForSign, adobeWebhook, or any function that triggers archival

```javascript
// File: src/functions/sendForSign/index.js (or adobeWebhook)

const { queue } = require('../../lib/queue');

// ... existing code ...

try {
  // Send to Adobe Sign (existing code)
  const agreement = await adobe.sendForSignature({
    /* ... existing params ... */
  });

  const agreementId = agreement.id;

  // DUAL ARCHIVAL: Queue both Blob and SharePoint
  const [blobResult, spResult] = await Promise.allSettled([
    // Primary: Azure Blob Storage
    queue.enqueue('blob-archive', {
      boardId,
      itemId,
      agreementId,
      firstName,
      lastName,
    }),

    // Secondary: SharePoint Online (NEW)
    queue.enqueue('sharepoint-uploads', {
      agreementId,
      itemId,
      boardId,
      employeeName: `${firstName} ${lastName}`,
      employeeEmail: empEmail || null,
      docType: templateName || 'Document',
    }),
  ]);

  // Log results
  if (blobResult.status === 'fulfilled') {
    logger.info('sendForSign-blob-queued', { agreementId, itemId });
  } else {
    logger.warn('sendForSign-blob-queue-failed', { error: blobResult.reason.message });
  }

  if (spResult.status === 'fulfilled') {
    logger.info('sendForSign-sharepoint-queued', { agreementId, itemId });
  } else {
    logger.warn('sendForSign-sharepoint-queue-failed', { error: spResult.reason.message });
  }

  // Continue with rest of sendForSign flow...
  
} catch (err) {
  logger.error('sendForSign-failed', err);
  throw err;
}
```

## 2. Queue SharePoint Only (If Preferred)

**Use when:** You only want SharePoint (no blob), or conditional queueing

```javascript
const { queue } = require('../../lib/queue');

async function queueSharePointUpload(agreementId, itemId, boardId, employee) {
  const cfg = config.load();
  
  // Skip if SharePoint not enabled
  if (!cfg.sharepoint.enabled) {
    logger.warn('sharepoint-disabled', { agreementId });
    return { skipped: true };
  }

  try {
    await queue.enqueue('sharepoint-uploads', {
      agreementId,
      itemId,
      boardId,
      employeeName: employee.name,
      employeeEmail: employee.email,
      docType: employee.docType,
    });
    logger.info('sharepoint-queued', { agreementId, itemId });
    return { queued: true };
  } catch (err) {
    logger.error('sharepoint-queue-failed', err, { agreementId });
    throw err;
  }
}

// Usage:
await queueSharePointUpload(agreementId, itemId, boardId, {
  name: `${firstName} ${lastName}`,
  email: empEmail,
  docType: templateName,
});
```

## 3. Update Monday with SharePoint Link

**Use in:** Any function that updates Monday after SharePoint upload

```javascript
const monday = require('../../lib/monday');
const config = require('../../lib/config');

async function updateMondayWithSharePointLink(boardId, itemId, sharePointUrl) {
  const cfg = config.load();
  
  try {
    const sharePointLinkColumn = cfg.monday.columns.sharePointLink || 'link_sharepoint';
    
    await monday.updateStatus(boardId, itemId, {
      [sharePointLinkColumn]: sharePointUrl,
    }, { verify: false });
    
    logger.info('monday-sharepoint-link-updated', {
      itemId,
      sharePointUrl,
    });
    return { success: true };
  } catch (err) {
    logger.warn('monday-sharepoint-link-update-failed', {
      itemId,
      error: err.message,
    });
    // Non-blocking: log but don't throw
    return { success: false, error: err.message };
  }
}

// Usage:
await updateMondayWithSharePointLink(
  boardId,
  itemId,
  'https://medwatchers.sharepoint.com/sites/HR/Shared Documents/...'
);
```

## 4. Upload Document Directly (Without Queue)

**Use in:** Webhook handlers, on-demand functions, or tests

```javascript
const sharepointClient = require('../../lib/sharepointClient');
const { downloadSigned } = require('../downloadSigned');

async function uploadSignedDocumentDirect(agreementId, employeeInfo) {
  const cfg = config.load();

  if (!cfg.sharepoint.enabled) {
    logger.warn('sharepoint-disabled');
    return { skipped: true };
  }

  try {
    // Download from Adobe
    const pdfBuffer = await downloadSigned(agreementId);
    
    // Upload to SharePoint
    const result = await sharepointClient.uploadSignedDocument({
      pdfBuffer,
      employeeName: employeeInfo.name,
      employeeEmail: employeeInfo.email,
      docType: employeeInfo.docType,
      agreementId,
      itemId: employeeInfo.itemId,
      boardId: employeeInfo.boardId,
    });

    // Update Monday if result successful
    if (result.success) {
      await updateMondayWithSharePointLink(
        employeeInfo.boardId,
        employeeInfo.itemId,
        result.webUrl
      );
    }

    return result;
  } catch (err) {
    logger.error('upload-signed-document-direct-failed', err, { agreementId });
    throw err;
  }
}

// Usage:
const result = await uploadSignedDocumentDirect(
  'CBJCHBCAABACsW7z',
  {
    name: 'John Smith',
    email: 'john@company.com',
    docType: 'Offer Letter',
    itemId: '5678901234',
    boardId: '18422046530',
  }
);
```

## 5. Check if Employee Can Access SharePoint

**Use in:** Permission verification, health checks

```javascript
const sharepointClient = require('../../lib/sharepointClient');

async function verifyEmployeeAccess(employeeName, employeeEmail) {
  try {
    const cfg = config.load();

    if (!cfg.sharepoint.enabled) {
      return { enabled: false };
    }

    // List documents for employee
    const docs = await sharepointClient.listEmployeeDocuments(employeeName);

    // Try to create a shareable link if documents exist
    if (docs.length > 0) {
      const link = await sharepointClient.createShareableLink(docs[0].id);
      return {
        enabled: true,
        hasDocuments: true,
        documentCount: docs.length,
        shareableLink: link,
      };
    }

    return {
      enabled: true,
      hasDocuments: false,
      documentCount: 0,
    };
  } catch (err) {
    logger.warn('verify-employee-access-failed', {
      employeeName,
      error: err.message,
    });
    return { enabled: false, error: err.message };
  }
}

// Usage in health endpoint:
module.exports = async function (context) {
  const check = await verifyEmployeeAccess('John Smith', 'john@company.com');
  context.res = { status: 200, body: check };
};
```

## 6. Handle SharePoint in Error Scenarios

**Use in:** Error handlers, cleanup functions

```javascript
const sharepointClient = require('../../lib/sharepointClient');

async function cleanupSharePointIfError(itemId, isError) {
  if (!isError) return;

  const cfg = config.load();
  if (!cfg.sharepoint.enabled) return;

  try {
    // Optionally delete file from SharePoint on error
    const result = await sharepointClient.deleteDocument(itemId);
    logger.info('sharepoint-error-cleanup-success', { itemId, deleted: result.success });
  } catch (err) {
    // Non-critical: just log
    logger.warn('sharepoint-error-cleanup-failed', { itemId, error: err.message });
  }
}

// Usage in error handler:
try {
  // ... main function ...
} catch (err) {
  await cleanupSharePointIfError(spItemId, true);
  throw err;
}
```

## 7. Batch Upload Multiple Documents

**Use in:** Bulk operations, migrations

```javascript
const sharepointClient = require('../../lib/sharepointClient');

async function uploadMultipleDocuments(documents) {
  const results = [];

  for (const doc of documents) {
    try {
      const result = await sharepointClient.uploadSignedDocument({
        pdfBuffer: doc.pdfBuffer,
        employeeName: doc.employeeName,
        employeeEmail: doc.employeeEmail,
        docType: doc.docType,
        agreementId: doc.agreementId,
        itemId: doc.itemId,
        boardId: doc.boardId,
      });

      results.push({
        agreementId: doc.agreementId,
        success: true,
        itemId: result.itemId,
        webUrl: result.webUrl,
      });
    } catch (err) {
      results.push({
        agreementId: doc.agreementId,
        success: false,
        error: err.message,
      });
    }
  }

  return results;
}

// Usage:
const documents = [
  {
    pdfBuffer: buffer1,
    employeeName: 'John Smith',
    employeeEmail: 'john@company.com',
    docType: 'Offer Letter',
    agreementId: 'AGR-001',
    itemId: '1',
    boardId: '123',
  },
  // ... more documents
];

const results = await uploadMultipleDocuments(documents);
logger.info('batch-upload-complete', {
  total: results.length,
  successful: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
});
```

## 8. Get Employee Documents List

**Use in:** Reporting, auditing, employee portals

```javascript
const sharepointClient = require('../../lib/sharepointClient');

async function getEmployeeDocumentReport(employeeName) {
  try {
    const docs = await sharepointClient.listEmployeeDocuments(employeeName);

    const report = await Promise.all(
      docs.map(async (doc) => {
        try {
          const info = await sharepointClient.getDocumentInfo(doc.id);
          return {
            name: doc.name,
            url: doc.webUrl,
            size: doc.size,
            created: doc.createdDateTime,
            docType: info.metadata?.docType,
            signedDate: info.metadata?.signedDate,
            agreementId: info.metadata?.agreementId,
          };
        } catch (err) {
          return {
            name: doc.name,
            error: err.message,
          };
        }
      })
    );

    return report;
  } catch (err) {
    logger.error('get-employee-document-report-failed', err, { employeeName });
    throw err;
  }
}

// Usage:
const report = await getEmployeeDocumentReport('John Smith');
logger.info('employee-document-report', { employeeName: 'John Smith', documents: report });
```

## 9. Conditional Queue Based on Config

**Use in:** Feature flags, gradual rollout

```javascript
const config = require('../../lib/config');
const { queue } = require('../../lib/queue');

async function queueArchivalWithFeatureFlag(agreementId, itemId, boardId, employee) {
  const cfg = config.load();
  const results = {};

  // Always queue blob (primary)
  try {
    await queue.enqueue('blob-archive', {
      boardId,
      itemId,
      agreementId,
      firstName: employee.firstName,
      lastName: employee.lastName,
    });
    results.blob = { queued: true };
  } catch (err) {
    results.blob = { queued: false, error: err.message };
  }

  // Queue SharePoint only if enabled (secondary)
  if (cfg.sharepoint.enabled) {
    try {
      await queue.enqueue('sharepoint-uploads', {
        agreementId,
        itemId,
        boardId,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        employeeEmail: employee.email,
        docType: employee.docType,
      });
      results.sharepoint = { queued: true };
    } catch (err) {
      results.sharepoint = { queued: false, error: err.message };
      logger.warn('sharepoint-queue-failed', err);
      // Don't throw; blob is already queued
    }
  } else {
    results.sharepoint = { queued: false, disabled: true };
  }

  return results;
}

// Usage:
const queueResults = await queueArchivalWithFeatureFlag(
  agreementId,
  itemId,
  boardId,
  { firstName, lastName, email, docType }
);
logger.info('archival-queued', queueResults);
```

## 10. Complete sendForSign Integration

**Full updated function with SharePoint:**

```javascript
// File: src/functions/sendForSign/index.js

'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const monday = require('../../lib/monday');
const { queue } = require('../../lib/queue');

module.exports = async function (context) {
  try {
    const { itemId, boardId, firstName, lastName, email } = context.req.body;

    const cfg = config.load();
    logger.info('sendForSign-start', { itemId, boardId });

    // Get Monday row for metadata
    const row = await monday.readRow(boardId, itemId);
    const empEmail = email || row.columns[cfg.monday.columns.email];
    const templateName = row.columns[cfg.monday.columns.template] || 'Document';

    // Send to Adobe Sign
    const agreement = await adobe.sendForSignature({
      documentUrl: row.columns[cfg.monday.columns.pdfUrl],
      signerEmail: empEmail,
      signerName: `${firstName} ${lastName}`,
      documentName: templateName,
    });

    logger.info('sendForSign-sent', { agreementId: agreement.id, itemId });

    // Update Monday: status -> "Awaiting Signature"
    await monday.updateStatus(boardId, itemId, { status: 'Awaiting Signature' });

    // DUAL ARCHIVAL: Queue both Blob and SharePoint
    const [blobResult, spResult] = await Promise.allSettled([
      // Primary: Azure Blob Storage
      queue.enqueue('blob-archive', {
        boardId,
        itemId,
        agreementId: agreement.id,
        firstName,
        lastName,
      }),

      // Secondary: SharePoint Online
      queue.enqueue('sharepoint-uploads', {
        agreementId: agreement.id,
        itemId,
        boardId,
        employeeName: `${firstName} ${lastName}`,
        employeeEmail: empEmail,
        docType: templateName,
      }),
    ]);

    logger.info('sendForSign-dual-archive-queued', {
      agreementId: agreement.id,
      itemId,
      blobQueued: blobResult.status === 'fulfilled',
      sharepointQueued: spResult.status === 'fulfilled',
    });

    context.res = {
      status: 200,
      body: {
        itemId,
        agreementId: agreement.id,
        status: 'Sent for signature',
        archivalQueued: {
          blob: blobResult.status === 'fulfilled',
          sharepoint: spResult.status === 'fulfilled',
        },
      },
    };
  } catch (error) {
    logger.error('sendForSign-error', error);
    context.res = { status: 500, body: { error: error.message } };
  }
};
```

## Tips

### Use allSettled for Independent Operations

```javascript
// Both should queue even if one fails
const [blob, sp] = await Promise.allSettled([queue1, queue2]);
// Not: await Promise.all([queue1, queue2]); // Would fail if either fails
```

### Check if SharePoint is Enabled

```javascript
const cfg = config.load();
if (cfg.sharepoint.enabled) {
  // Queue SharePoint
}
```

### Handle Queue Failures Gracefully

```javascript
try {
  await queue.enqueue('sharepoint-uploads', msg);
} catch (err) {
  logger.warn('sharepoint-queue-failed', err);
  // Continue; blob queue may have succeeded
}
```

### Log Both Success and Failure

```javascript
logger.info('sendForSign-blob-queued', { agreementId, itemId });
logger.info('sendForSign-sharepoint-queued', { agreementId, itemId });
```

## Testing Snippets

### Test Queue Message (Console)

```javascript
// In Azure Portal → Function → Code + Test → Console:
const msg = {
  agreementId: 'TEST-AGR-001',
  employeeName: 'Test User',
  employeeEmail: 'test@company.com',
  docType: 'Test Document',
  itemId: '999',
  boardId: '123',
};
JSON.stringify(msg);
```

### Test sharepointClient Directly

```javascript
const client = require('./lib/sharepointClient');
const fs = require('fs');

// Test with real PDF
const pdf = fs.readFileSync('./test.pdf');
const result = await client.uploadSignedDocument({
  pdfBuffer: pdf,
  employeeName: 'Test User',
  employeeEmail: 'test@company.com',
  docType: 'Test',
  agreementId: 'TEST-001',
});
console.log(result);
```

### Test Folder Creation

```javascript
const client = require('./lib/sharepointClient');
const path = client.calculateFolderPath('John Smith');
console.log(path); // Output: DocFlow/2026/08/john-smith
```
