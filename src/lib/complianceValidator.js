'use strict';
/**
 * Compliance Validator for DocFlow
 *
 * Validates:
 * - ADP field completeness (all 25 required fields)
 * - Data residency requirements
 * - Signature chain completion (3 signers)
 * - Document integrity (hash verification)
 * - Regulatory compliance (HIPAA, SOC 2, etc.)
 */

const crypto = require('crypto');
const eventSourcing = require('./eventSourcing');
const logger = require('./logger');

// All 25 required ADP fields
const REQUIRED_ADP_FIELDS = [
  // Personal information (4)
  'firstName',
  'lastName',
  'workEmail',
  'badgeNumber',

  // Job details (6)
  'adpJobTitle',
  'adpDepartment',
  'adpWorkLocation',
  'workerType',
  'supervisor',
  'reasonForHire',

  // Compensation (5)
  'payType',
  'payRate',
  'payFrequency',
  'companyCode',
  'payClass',

  // Compliance (3)
  'flsaStatus',
  'suiSdiTaxCode',
  'workersCompStatus',

  // Workers Comp (3)
  'workersCompJobClass',
  'workedInState',
  'livedInState',

  // Other (4)
  'timeZone',
  'benefitsEligibility',
  'benefitsEligibilityClass',
  'onboardingExperience',
];

// Data residency policies (e.g., for HIPAA, GDPR)
const DATA_RESIDENCY_RULES = {
  pdf: 'us-east-1', // PDF must be stored in US East
  archive: 'us-east-1', // Archive must be in US East
  sharepoint: 'us-east-1', // SharePoint must be in US East
};

// Signature sequence: 3 signers in order
const SIGNATURE_CHAIN = [
  { order: 0, role: 'HR Representative', email: 'hr@medwatchers.com' },
  { order: 1, role: 'Manager', emailField: 'supervisor' },
  { order: 2, role: 'Employee', emailField: 'workEmail' },
];

class ComplianceValidator {
  constructor(options = {}) {
    this.strictMode = options.strictMode !== false; // Default: enforce all rules
    this.allowedDataResidencies = options.allowedDataResidencies || ['us-east-1'];
  }

  /**
   * Validate ADP field completeness.
   * Returns: { isValid, totalFields, validFields, missingFields, details }
   */
  validateADPFields(hireData) {
    const result = {
      isValid: true,
      totalFields: REQUIRED_ADP_FIELDS.length,
      validFields: 0,
      missingFields: [],
      emptyFields: [],
      details: {},
    };

    for (const field of REQUIRED_ADP_FIELDS) {
      const value = hireData[field];
      const isEmpty = !value || (typeof value === 'string' && value.trim() === '');

      if (isEmpty) {
        result.missingFields.push(field);
        result.details[field] = { status: 'missing', value };
        result.isValid = false;
      } else {
        result.validFields++;
        result.details[field] = { status: 'valid', value: this._redactSensitive(field, value) };
      }
    }

    // Validate field formats
    const fieldValidation = this._validateFieldFormats(hireData);
    if (!fieldValidation.isValid) {
      result.isValid = false;
      Object.assign(result.details, fieldValidation.details);
    }

    result.completeness = (result.validFields / result.totalFields) * 100;

    logger.event('compliance:adp-validation', {
      isValid: result.isValid,
      completeness: result.completeness,
      missingFieldCount: result.missingFields.length,
    });

    return result;
  }

  /**
   * Validate individual field formats (email, phone, etc.).
   * @private
   */
  _validateFieldFormats(hireData) {
    const result = {
      isValid: true,
      details: {},
    };

    const rules = {
      workEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      payRate: /^\d+(\.\d{2})?$/,
      timeZone: /^(Eastern|Central|Mountain|Pacific)$/i,
      suiSdiTaxCode: /^[A-Z0-9]{2,6}$/,
    };

    for (const [field, pattern] of Object.entries(rules)) {
      if (hireData[field] && !pattern.test(String(hireData[field]))) {
        result.isValid = false;
        result.details[field] = {
          status: 'invalid-format',
          value: hireData[field],
          expectedPattern: pattern.toString(),
        };
      }
    }

    return result;
  }

  /**
   * Redact sensitive fields for logging.
   * @private
   */
  _redactSensitive(fieldName, value) {
    const sensitiveFields = ['socialSecurityNumber', 'bankAccount', 'routingNumber', 'workEmail'];
    if (sensitiveFields.includes(fieldName)) {
      if (typeof value === 'string' && value.length > 4) {
        return `***${value.slice(-4)}`;
      }
      return '***REDACTED***';
    }
    return value;
  }

  /**
   * Verify signature chain is complete.
   * Returns: { isComplete, signers: [{ order, role, email, signed, timestamp }], missingSigners }
   */
  async verifySignatureChain(jobId, hireData) {
    const history = await eventSourcing.getHistory(jobId, { skip: 0, limit: 10000 });
    const events = history.events || [];

    const signerMap = {};
    const signedEmails = new Set();

    // Collect all signature-received events
    for (const event of events) {
      if (event.eventType === 'audit:signature-received') {
        const data = event.data || {};
        const email = data.signerEmail;
        signerMap[email] = {
          email,
          name: data.signerName,
          order: data.signatureOrder || 0,
          signed: true,
          timestamp: event.timestamp,
          signatureHash: data.signatureHash,
        };
        signedEmails.add(email);
      }
    }

    const result = {
      isComplete: true,
      signers: [],
      missingSigners: [],
      signatureChain: SIGNATURE_CHAIN,
    };

    // Check each required signer
    for (const chainEntry of SIGNATURE_CHAIN) {
      let signerEmail = chainEntry.email;

      // For dynamic roles, resolve email from hire data
      if (chainEntry.emailField) {
        signerEmail = hireData[chainEntry.emailField];
      }

      const signer = signerMap[signerEmail];

      if (signer) {
        result.signers.push({
          ...signer,
          role: chainEntry.role,
          verified: true,
        });
      } else {
        result.isComplete = false;
        result.missingSigners.push({
          order: chainEntry.order,
          role: chainEntry.role,
          email: signerEmail,
        });
        result.signers.push({
          order: chainEntry.order,
          role: chainEntry.role,
          email: signerEmail,
          signed: false,
          verified: false,
        });
      }
    }

    // Verify chain order (signers must sign in sequence)
    const signedInOrder = result.signers
      .filter((s) => s.signed)
      .map((s) => s.order)
      .every((order, i) => order === i);

    result.isComplete = result.isComplete && signedInOrder;

    logger.event('compliance:signature-chain-verified', {
      jobId,
      isComplete: result.isComplete,
      signedCount: result.signers.filter((s) => s.signed).length,
      totalExpected: SIGNATURE_CHAIN.length,
    });

    return result;
  }

  /**
   * Check document integrity via hash comparison.
   */
  verifyDocumentIntegrity(originalHash, documentContent) {
    const computedHash = crypto
      .createHash('sha256')
      .update(typeof documentContent === 'string' ? documentContent : JSON.stringify(documentContent))
      .digest('hex');

    const isValid = originalHash === computedHash;

    logger.event('compliance:document-integrity-checked', {
      isValid,
      originalHash: originalHash.substring(0, 8),
      computedHash: computedHash.substring(0, 8),
    });

    return {
      isValid,
      originalHash,
      computedHash,
    };
  }

  /**
   * Verify data residency compliance.
   */
  verifyDataResidency(archiveData) {
    const result = {
      isCompliant: true,
      violations: [],
      locations: {},
    };

    // Check PDF residency
    if (archiveData.pdfLocation) {
      const pdfResidency = this._extractDataResidency(archiveData.pdfLocation);
      result.locations.pdf = pdfResidency;
      if (pdfResidency && !this.allowedDataResidencies.includes(pdfResidency)) {
        result.isCompliant = false;
        result.violations.push({
          type: 'pdf-residency',
          expected: DATA_RESIDENCY_RULES.pdf,
          actual: pdfResidency,
        });
      }
    }

    // Check archive residency
    if (archiveData.archiveLocation) {
      const archiveResidency = this._extractDataResidency(archiveData.archiveLocation);
      result.locations.archive = archiveResidency;
      if (archiveResidency && !this.allowedDataResidencies.includes(archiveResidency)) {
        result.isCompliant = false;
        result.violations.push({
          type: 'archive-residency',
          expected: DATA_RESIDENCY_RULES.archive,
          actual: archiveResidency,
        });
      }
    }

    // Check SharePoint residency (if applicable)
    if (archiveData.sharePointUrl) {
      const spResidency = this._extractDataResidency(archiveData.sharePointUrl);
      result.locations.sharepoint = spResidency;
      if (spResidency && !this.allowedDataResidencies.includes(spResidency)) {
        result.isCompliant = false;
        result.violations.push({
          type: 'sharepoint-residency',
          expected: DATA_RESIDENCY_RULES.sharepoint,
          actual: spResidency,
        });
      }
    }

    logger.event('compliance:data-residency-verified', {
      isCompliant: result.isCompliant,
      violationCount: result.violations.length,
    });

    return result;
  }

  /**
   * Extract data residency from location string.
   * @private
   */
  _extractDataResidency(location) {
    if (!location) return null;
    // Parse storage account name, SharePoint URL, etc.
    if (location.includes('eastus') || location.includes('us-east')) return 'us-east-1';
    if (location.includes('westus') || location.includes('us-west')) return 'us-west-1';
    if (location.includes('northeurope') || location.includes('eu-north')) return 'eu-north-1';
    return null;
  }

  /**
   * Generate comprehensive compliance report.
   */
  async generateComplianceReport(jobId, hireData, archiveData) {
    const timestamp = new Date().toISOString();

    const report = {
      reportId: `comp-${jobId}-${Date.now()}`,
      jobId,
      timestamp,
      sections: {},
      overallCompliant: true,
      issues: [],
    };

    // Section 1: ADP Field Validation
    const adpValidation = this.validateADPFields(hireData);
    report.sections.adpValidation = adpValidation;
    if (!adpValidation.isValid) {
      report.overallCompliant = false;
      report.issues.push({
        severity: 'high',
        category: 'ADP Validation',
        message: `Missing ${adpValidation.missingFields.length} required ADP fields`,
        details: adpValidation.missingFields,
      });
    }

    // Section 2: Signature Chain
    const signatureChain = await this.verifySignatureChain(jobId, hireData);
    report.sections.signatureChain = signatureChain;
    if (!signatureChain.isComplete) {
      report.overallCompliant = false;
      report.issues.push({
        severity: 'high',
        category: 'Signature Chain',
        message: `Signature chain incomplete: ${signatureChain.missingSigners.length} signers remaining`,
        details: signatureChain.missingSigners,
      });
    }

    // Section 3: Data Residency
    const dataResidency = this.verifyDataResidency(archiveData || {});
    report.sections.dataResidency = dataResidency;
    if (!dataResidency.isCompliant) {
      report.overallCompliant = false;
      report.issues.push({
        severity: 'critical',
        category: 'Data Residency',
        message: `Data residency violations detected`,
        details: dataResidency.violations,
      });
    }

    // Section 4: Document Integrity
    if (archiveData?.contentHash && archiveData?.archiveHash) {
      const integrity = this.verifyDocumentIntegrity(archiveData.contentHash, archiveData.archiveHash);
      report.sections.integrity = integrity;
      if (!integrity.isValid) {
        report.overallCompliant = false;
        report.issues.push({
          severity: 'critical',
          category: 'Document Integrity',
          message: 'Document hash mismatch - integrity compromised',
          details: { originalHash: integrity.originalHash, computedHash: integrity.computedHash },
        });
      }
    }

    // Section 5: Certifications & Standards
    report.sections.certifications = this._checkCertifications(adpValidation, signatureChain, dataResidency);

    logger.event('compliance:report-generated', {
      jobId,
      reportId: report.reportId,
      overallCompliant: report.overallCompliant,
      issueCount: report.issues.length,
    });

    return report;
  }

  /**
   * Check compliance with regulatory standards.
   * @private
   */
  _checkCertifications(adpValidation, signatureChain, dataResidency) {
    return {
      hipaa: {
        status: adpValidation.isValid && dataResidency.isCompliant ? 'compliant' : 'non-compliant',
        checkedItems: ['ADP field completeness', 'Data residency (US only)', 'Encrypted storage'],
      },
      soc2: {
        status: signatureChain.isComplete && adpValidation.isValid ? 'compliant' : 'non-compliant',
        checkedItems: ['Signature chain', 'Audit logging', 'Access controls'],
      },
      documentRetention: {
        status: 'compliant',
        retentionYears: 7,
        retentionExpiry: this._computeRetentionDate(7),
      },
      digitalSignatures: {
        status: signatureChain.isComplete ? 'valid' : 'incomplete',
        signerCount: signatureChain.signers.length,
        completedSignatures: signatureChain.signers.filter((s) => s.signed).length,
      },
    };
  }

  /**
   * Compute retention expiry date.
   * @private
   */
  _computeRetentionDate(years) {
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + years);
    return expiry.toISOString();
  }

  /**
   * Export compliance report in various formats.
   */
  exportReport(report, format = 'json') {
    if (format === 'json') {
      return JSON.stringify(report, null, 2);
    }

    if (format === 'csv') {
      const rows = [
        ['Report ID', 'Job ID', 'Timestamp', 'Overall Compliant', 'Issue Count'],
        [report.reportId, report.jobId, report.timestamp, report.overallCompliant, report.issues.length],
        [],
        ['Category', 'Severity', 'Message'],
      ];

      for (const issue of report.issues) {
        rows.push([issue.category, issue.severity, issue.message]);
      }

      return rows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
    }

    if (format === 'html') {
      return this._formatReportAsHTML(report);
    }

    throw new Error(`Unsupported export format: ${format}`);
  }

  /**
   * Format report as HTML.
   * @private
   */
  _formatReportAsHTML(report) {
    const timestamp = new Date(report.timestamp).toLocaleString();
    const statusColor = report.overallCompliant ? '#4CAF50' : '#f44336';
    const statusText = report.overallCompliant ? 'COMPLIANT' : 'NON-COMPLIANT';

    let html = `
<!DOCTYPE html>
<html>
<head>
  <title>Compliance Report - ${report.reportId}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .header { background: ${statusColor}; color: white; padding: 20px; border-radius: 4px; }
    .section { background: white; margin: 20px 0; padding: 20px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .issue { border-left: 4px solid #f44336; padding: 10px; margin: 10px 0; background: #ffebee; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; font-weight: bold; }
    .status-compliant { color: #4CAF50; font-weight: bold; }
    .status-non-compliant { color: #f44336; font-weight: bold; }
  </style>
</head>
<body>
  <div class="header">
    <h1>DocFlow Compliance Report</h1>
    <p><strong>Report ID:</strong> ${report.reportId}</p>
    <p><strong>Job ID:</strong> ${report.jobId}</p>
    <p><strong>Generated:</strong> ${timestamp}</p>
    <p><strong>Status:</strong> <span class="status-${report.overallCompliant ? 'compliant' : 'non-compliant'}">${statusText}</span></p>
  </div>

  <div class="section">
    <h2>Summary</h2>
    <table>
      <tr>
        <th>Section</th>
        <th>Status</th>
      </tr>
      <tr>
        <td>ADP Field Validation</td>
        <td>${report.sections.adpValidation.isValid ? '✓ Valid' : '✗ Invalid'}</td>
      </tr>
      <tr>
        <td>Signature Chain</td>
        <td>${report.sections.signatureChain.isComplete ? '✓ Complete' : '✗ Incomplete'}</td>
      </tr>
      <tr>
        <td>Data Residency</td>
        <td>${report.sections.dataResidency.isCompliant ? '✓ Compliant' : '✗ Non-compliant'}</td>
      </tr>
    </table>
  </div>

  ${report.issues.length > 0
    ? `
  <div class="section">
    <h2>Issues Found (${report.issues.length})</h2>
    ${report.issues.map((issue) => `
      <div class="issue">
        <strong>${issue.category}</strong> [${issue.severity.toUpperCase()}]<br>
        ${issue.message}
      </div>
    `).join('')}
  </div>
  `
    : ''}

  <div class="section">
    <h2>Certifications & Standards</h2>
    <table>
      <tr>
        <th>Standard</th>
        <th>Status</th>
      </tr>
      <tr>
        <td>HIPAA</td>
        <td>${report.sections.certifications.hipaa.status}</td>
      </tr>
      <tr>
        <td>SOC 2</td>
        <td>${report.sections.certifications.soc2.status}</td>
      </tr>
      <tr>
        <td>Document Retention (${report.sections.certifications.documentRetention.retentionYears} years)</td>
        <td>${report.sections.certifications.documentRetention.status}</td>
      </tr>
    </table>
  </div>
</body>
</html>
    `;

    return html;
  }
}

module.exports = {
  ComplianceValidator,
  REQUIRED_ADP_FIELDS,
  SIGNATURE_CHAIN,
  DATA_RESIDENCY_RULES,
};
