'use strict';
/**
 * Audit Logger for DocFlow Compliance & Regulatory Tracking
 *
 * Comprehensive audit logging for all document lifecycle events with:
 * - Immutable event trail (7-year retention, configurable)
 * - User attribution (who performed the action)
 * - IP address tracking
 * - Monday item ID & status changes
 * - Error tracking with stack traces
 * - App Insights structured telemetry
 * - HIPAA, SOC 2, and compliance report support
 */

const crypto = require('crypto');
const eventSourcing = require('./eventSourcing');
const logger = require('./logger');

// Audit event types for compliance reporting
const AUDIT_EVENT_TYPES = {
  // Hire lifecycle
  HIRE_CREATED: 'audit:hire-created',
  HIRE_SUBMITTED: 'audit:hire-submitted',

  // ADP validation
  ADP_VALIDATION_PASSED: 'audit:adp-validation-passed',
  ADP_VALIDATION_FAILED: 'audit:adp-validation-failed',
  ADP_FIELD_CHANGED: 'audit:adp-field-changed',

  // PDF generation
  PDF_GENERATION_STARTED: 'audit:pdf-generation-started',
  PDF_GENERATION_COMPLETED: 'audit:pdf-generation-completed',
  PDF_GENERATION_FAILED: 'audit:pdf-generation-failed',

  // Adobe Sign workflow
  SIGNATURE_REQUESTED: 'audit:signature-requested',
  SIGNATURE_RECEIVED: 'audit:signature-received',
  SIGNATURE_FAILED: 'audit:signature-failed',
  SIGNATURE_REJECTED: 'audit:signature-rejected',

  // Archive & storage
  DOCUMENT_ARCHIVED: 'audit:document-archived',
  DOCUMENT_STORED_SHAREPOINT: 'audit:document-stored-sharepoint',
  ARCHIVE_FAILED: 'audit:archive-failed',

  // Access & compliance
  DOCUMENT_ACCESSED: 'audit:document-accessed',
  DOCUMENT_EXPORTED: 'audit:document-exported',
  COMPLIANCE_CHECK_PERFORMED: 'audit:compliance-check-performed',

  // User & admin actions
  DOCUMENT_DELETED: 'audit:document-deleted',
  DOCUMENT_CORRECTED: 'audit:document-corrected',
  DOCUMENT_RESUBMITTED: 'audit:document-resubmitted',

  // Errors & failures
  SYSTEM_ERROR: 'audit:system-error',
  WEBHOOK_ERROR: 'audit:webhook-error',
  DATA_RESIDENCY_VIOLATION: 'audit:data-residency-violation',
};

/**
 * Core audit logger class.
 * All methods are async to support event sourcing writes.
 */
class AuditLogger {
  constructor(options = {}) {
    this.retentionDays = options.retentionDays || 2555; // 7 years default
    this.namespace = options.namespace || 'docflow';
  }

  /**
   * Generate a content hash for document integrity checking.
   * @private
   */
  _hashContent(content) {
    return crypto
      .createHash('sha256')
      .update(typeof content === 'string' ? content : JSON.stringify(content))
      .digest('hex');
  }

  /**
   * Extract user context from request (for HTTP functions).
   * @private
   */
  _extractUserContext(context) {
    return {
      userId: context?.userId || context?.headers?.['x-user-id'] || 'system',
      userName: context?.userName || context?.headers?.['x-user-name'] || 'unknown',
      userEmail: context?.userEmail || context?.headers?.['x-user-email'] || null,
      ipAddress: context?.ipAddress || context?.headers?.['x-forwarded-for']?.split(',')[0] || null,
      userAgent: context?.userAgent || context?.headers?.['user-agent'] || null,
    };
  }

  /**
   * Log hire creation event.
   */
  async logHireCreated(jobId, hireData, context = {}) {
    const userContext = this._extractUserContext(context);
    const eventData = {
      mondayItemId: hireData.mondayItemId,
      firstName: hireData.firstName,
      lastName: hireData.lastName,
      workEmail: hireData.workEmail,
      adpJobTitle: hireData.adpJobTitle,
      adpDepartment: hireData.adpDepartment,
      fieldCount: Object.keys(hireData).length,
      contentHash: this._hashContent(hireData),
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.HIRE_CREATED,
      eventData,
      {
        ...userContext,
        source: 'monday-webhook',
        riskLevel: 'low',
      },
    );

    logger.event('audit:hire-created', {
      jobId,
      mondayItemId: hireData.mondayItemId,
      userId: userContext.userId,
      ipAddress: userContext.ipAddress,
    });
  }

  /**
   * Log ADP field validation result.
   */
  async logADPValidation(jobId, validationResult, context = {}) {
    const userContext = this._extractUserContext(context);
    const eventType = validationResult.isValid
      ? AUDIT_EVENT_TYPES.ADP_VALIDATION_PASSED
      : AUDIT_EVENT_TYPES.ADP_VALIDATION_FAILED;

    const eventData = {
      isValid: validationResult.isValid,
      totalFields: validationResult.totalFields || 25,
      validFields: validationResult.validFields || 0,
      missingFields: validationResult.missingFields || [],
      missingFieldCount: (validationResult.missingFields || []).length,
    };

    await eventSourcing.writeEvent(
      jobId,
      eventType,
      eventData,
      {
        ...userContext,
        source: 'adp-validation',
        severity: validationResult.isValid ? 'info' : 'warning',
      },
    );

    logger.event(`audit:adp-validation-${validationResult.isValid ? 'passed' : 'failed'}`, {
      jobId,
      validFields: validationResult.validFields,
      missingFields: validationResult.missingFields?.join(', '),
    });
  }

  /**
   * Log individual ADP field change (for audit trail).
   */
  async logADPFieldChange(jobId, fieldName, oldValue, newValue, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      fieldName,
      oldValue: oldValue || null,
      newValue: newValue || null,
      oldHash: this._hashContent(oldValue || ''),
      newHash: this._hashContent(newValue || ''),
      isSensitive: ['workEmail', 'socialSecurityNumber', 'bankAccount'].includes(fieldName),
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.ADP_FIELD_CHANGED,
      eventData,
      {
        ...userContext,
        source: 'monday-update',
        severity: eventData.isSensitive ? 'high' : 'info',
      },
    );
  }

  /**
   * Log PDF generation event.
   */
  async logPDFGeneration(jobId, pdfData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      pdfUrl: pdfData.pdfUrl,
      fileSizeBytes: pdfData.fileSizeBytes || 0,
      fileName: pdfData.fileName || `docflow-${jobId}.pdf`,
      pdfHash: this._hashContent(pdfData.pdfContent || pdfData.pdfUrl),
      generatedAt: pdfData.generatedAt || new Date().toISOString(),
      duration: pdfData.duration || 0,
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.PDF_GENERATION_COMPLETED,
      eventData,
      {
        ...userContext,
        source: 'pdf-generator',
        severity: 'info',
      },
    );

    logger.event('audit:pdf-generation-completed', {
      jobId,
      fileSizeBytes: eventData.fileSizeBytes,
      duration: eventData.duration,
    });
  }

  /**
   * Log PDF generation failure.
   */
  async logPDFGenerationFailed(jobId, error, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      errorMessage: error.message || String(error),
      errorCode: error.code || 'UNKNOWN',
      errorStack: error.stack || null,
      retryable: error.retryable !== false,
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.PDF_GENERATION_FAILED,
      eventData,
      {
        ...userContext,
        source: 'pdf-generator',
        severity: 'error',
        riskLevel: 'high',
      },
    );

    logger.error('audit:pdf-generation-failed', error, { jobId });
  }

  /**
   * Log signature request (document sent for signing).
   */
  async logSignatureRequested(jobId, signatureData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      adobeAgreementId: signatureData.adobeAgreementId,
      signers: (signatureData.signers || []).map((s) => ({
        email: s.email,
        name: s.name,
        order: s.order,
        status: 'pending',
      })),
      signerCount: signatureData.signers?.length || 0,
      requestedAt: new Date().toISOString(),
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.SIGNATURE_REQUESTED,
      eventData,
      {
        ...userContext,
        source: 'adobe-sign',
        severity: 'info',
      },
    );

    logger.event('audit:signature-requested', {
      jobId,
      adobeAgreementId: signatureData.adobeAgreementId,
      signerCount: eventData.signerCount,
    });
  }

  /**
   * Log signature received (signer completed signing).
   */
  async logSignatureReceived(jobId, signatureData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      adobeAgreementId: signatureData.adobeAgreementId,
      signerEmail: signatureData.signerEmail,
      signerName: signatureData.signerName,
      signedAt: signatureData.signedAt || new Date().toISOString(),
      signatureOrder: signatureData.signatureOrder || 0,
      signatureHash: this._hashContent(signatureData.adobeAgreementId + signatureData.signedAt),
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.SIGNATURE_RECEIVED,
      eventData,
      {
        ...userContext,
        source: 'adobe-webhook',
        severity: 'info',
      },
    );

    logger.event('audit:signature-received', {
      jobId,
      signerEmail: signatureData.signerEmail,
      signatureOrder: eventData.signatureOrder,
    });
  }

  /**
   * Log signature failure.
   */
  async logSignatureFailed(jobId, error, signerEmail, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      signerEmail,
      errorMessage: error.message || String(error),
      errorCode: error.code || 'UNKNOWN',
      retryable: error.retryable !== false,
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.SIGNATURE_FAILED,
      eventData,
      {
        ...userContext,
        source: 'adobe-sign',
        severity: 'error',
        riskLevel: 'high',
      },
    );

    logger.error('audit:signature-failed', error, { jobId, signerEmail });
  }

  /**
   * Log document archival.
   */
  async logDocumentArchived(jobId, archiveData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      archiveLocation: archiveData.archiveLocation, // e.g., 'blob://pdf-archive/...'
      fileName: archiveData.fileName,
      fileSizeBytes: archiveData.fileSizeBytes || 0,
      archiveHash: archiveData.archiveHash || this._hashContent(archiveData.archiveLocation),
      dataResidency: archiveData.dataResidency || 'us-east-1',
      encryptionAlgorithm: archiveData.encryptionAlgorithm || 'AES-256',
      retentionExpiry: archiveData.retentionExpiry || this._computeRetentionExpiry(),
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.DOCUMENT_ARCHIVED,
      eventData,
      {
        ...userContext,
        source: 'archive-service',
        severity: 'info',
      },
    );

    logger.event('audit:document-archived', {
      jobId,
      archiveLocation: eventData.archiveLocation,
      dataResidency: eventData.dataResidency,
    });
  }

  /**
   * Log SharePoint upload.
   */
  async logDocumentStoredSharePoint(jobId, sharePointData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      sharePointUrl: sharePointData.sharePointUrl,
      siteId: sharePointData.siteId,
      libraryId: sharePointData.libraryId,
      itemId: sharePointData.itemId,
      fileName: sharePointData.fileName,
      uploadedAt: new Date().toISOString(),
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.DOCUMENT_STORED_SHAREPOINT,
      eventData,
      {
        ...userContext,
        source: 'sharepoint-service',
        severity: 'info',
      },
    );

    logger.event('audit:document-stored-sharepoint', {
      jobId,
      sharePointUrl: sharePointData.sharePointUrl,
    });
  }

  /**
   * Log document access (for access control audits).
   */
  async logDocumentAccessed(jobId, accessData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      documentId: jobId,
      accessType: accessData.accessType || 'view', // 'view', 'download', 'export'
      purpose: accessData.purpose || 'compliance-check',
      accessedAt: new Date().toISOString(),
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.DOCUMENT_ACCESSED,
      eventData,
      {
        ...userContext,
        source: 'document-service',
        severity: 'info',
      },
    );
  }

  /**
   * Log document export (for compliance reports).
   */
  async logDocumentExported(jobId, exportData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      exportFormat: exportData.exportFormat || 'pdf', // 'pdf', 'csv', 'json'
      exportedAt: new Date().toISOString(),
      purpose: exportData.purpose || 'audit-report',
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.DOCUMENT_EXPORTED,
      eventData,
      {
        ...userContext,
        source: 'export-service',
        severity: 'warning', // Exports are tracked as important
      },
    );

    logger.event('audit:document-exported', {
      jobId,
      exportFormat: exportData.exportFormat,
      userId: userContext.userId,
    });
  }

  /**
   * Log system error (for incident tracking).
   */
  async logSystemError(jobId, error, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      errorMessage: error.message || String(error),
      errorCode: error.code || 'UNKNOWN',
      errorType: error.name || 'Error',
      errorStack: error.stack || null,
      systemComponent: context.component || 'unknown',
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.SYSTEM_ERROR,
      eventData,
      {
        ...userContext,
        source: context.component || 'system',
        severity: 'error',
        riskLevel: 'high',
      },
    );

    logger.error(`audit:system-error:${context.component}`, error, { jobId });
  }

  /**
   * Log data residency violation (for compliance).
   */
  async logDataResidencyViolation(jobId, violationData, context = {}) {
    const userContext = this._extractUserContext(context);

    const eventData = {
      expectedLocation: violationData.expectedLocation,
      actualLocation: violationData.actualLocation,
      dataType: violationData.dataType || 'document',
      violationType: violationData.violationType || 'unknown',
    };

    await eventSourcing.writeEvent(
      jobId,
      AUDIT_EVENT_TYPES.DATA_RESIDENCY_VIOLATION,
      eventData,
      {
        ...userContext,
        source: 'compliance-checker',
        severity: 'critical',
        riskLevel: 'critical',
      },
    );

    logger.error('audit:data-residency-violation', new Error('Data residency violation'), {
      jobId,
      expectedLocation: violationData.expectedLocation,
      actualLocation: violationData.actualLocation,
    });
  }

  /**
   * Get audit history for a job (wraps eventSourcing).
   */
  async getAuditHistory(jobId, options = {}) {
    return eventSourcing.getHistory(jobId, options);
  }

  /**
   * Get compliance status for a job.
   */
  async getComplianceStatus(jobId) {
    const history = await this.getAuditHistory(jobId, { skip: 0, limit: 10000 });

    const events = history.events || [];
    const status = {
      jobId,
      totalEvents: events.length,
      adpValidationPassed: false,
      allSignaturesCaptured: false,
      documentArchived: false,
      dataResidencyVerified: false,
      hasErrors: false,
      lastUpdated: new Date().toISOString(),
      timeline: [],
    };

    const signerStatuses = {};
    const expectedSigners = 3; // HR, Manager, Employee

    for (const event of events) {
      const eventType = event.eventType || '';
      const data = event.data || {};

      // Track validation
      if (eventType === AUDIT_EVENT_TYPES.ADP_VALIDATION_PASSED) {
        status.adpValidationPassed = data.isValid || true;
      }

      // Track signatures
      if (eventType === AUDIT_EVENT_TYPES.SIGNATURE_RECEIVED) {
        signerStatuses[data.signerEmail] = true;
      }

      // Track archival
      if (eventType === AUDIT_EVENT_TYPES.DOCUMENT_ARCHIVED) {
        status.documentArchived = true;
        status.dataResidencyVerified = data.dataResidency === 'us-east-1';
      }

      // Track errors
      if (eventType.includes('failed') || eventType.includes('error')) {
        status.hasErrors = true;
      }

      // Build timeline
      status.timeline.push({
        timestamp: event.timestamp,
        eventType: eventType.replace('audit:', ''),
        status: eventType.includes('failed') ? 'failed' : 'success',
      });
    }

    status.allSignaturesCaptured = Object.keys(signerStatuses).length >= expectedSigners;
    status.isCompliant = status.adpValidationPassed
      && status.allSignaturesCaptured
      && status.documentArchived
      && status.dataResidencyVerified
      && !status.hasErrors;

    return status;
  }

  /**
   * Compute retention expiry date.
   * @private
   */
  _computeRetentionExpiry() {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + this.retentionDays);
    return expiry.toISOString();
  }
}

module.exports = {
  AuditLogger,
  AUDIT_EVENT_TYPES,
};
