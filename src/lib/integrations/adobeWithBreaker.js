'use strict';
/**
 * Adobe API client with Circuit Breaker integration.
 * Wraps the existing adobe.js functions with circuit breaking.
 *
 * When to use circuit breaker:
 * - Adobe PDF Services has rate limits + downstream SLA
 * - Token acquisition failures are transient but signal auth service down
 * - Document generation job timeouts need fast-fail to prevent queue backup
 * - Signed document retrieval must not hammer service during outage
 *
 * Decision matrix:
 *   Operation              | Threshold | Timeout | Rationale
 *   ---------------------- | --------- | ------- | ---------------------------------
 *   Token refresh          | 3 failures| 30s     | Auth service down -> fail fast
 *   PDF generation submit  | 3 failures| 30s     | Queuing failures indicate outage
 *   PDF poll              | 5 failures| 60s     | Transient, retry longer
 *   PDF download          | 3 failures| 45s     | Pre-signed URL, if fails = real issue
 *   Sign envelope create  | 3 failures| 30s     | Immediate failure = service down
 *   Sign status check     | 5 failures| 60s     | Can retry longer, non-blocking
 *   Signed PDF download   | 3 failures| 45s     | Critical path, fail fast
 */

const adobe = require('../adobe');
const { callApi } = require('../apiClient');

// Store original functions
const _originalFunctions = { ...adobe };

/**
 * Wrapped token fetch with circuit breaker.
 * If token service is down, fail immediately after 3 attempts.
 */
async function getToken(kind) {
  return callApi('adobe', async () => {
    return _originalFunctions.getToken(kind);
  }, {
    label: `adobe-token-${kind}`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 30000,
    },
  });
}

/**
 * Wrapped PDF creation with circuit breaker.
 * Breaks if Adobe PDF Services consistently rejects requests.
 */
async function createPDF(templateId, data, schema) {
  return callApi('adobe', async () => {
    return _originalFunctions.createPDF(templateId, data, schema);
  }, {
    label: `adobe-pdf-create-${templateId}`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 30000,
    },
  });
}

/**
 * Wrapped envelope creation with circuit breaker.
 * Adobe Sign service down -> fail fast to avoid orphaned agreements.
 */
async function createEnvelope(pdf, signers, opts = {}) {
  return callApi('adobe', async () => {
    return _originalFunctions.createEnvelope(pdf, signers, opts);
  }, {
    label: `adobe-sign-create-envelope`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 30000,
    },
  });
}

/**
 * Wrapped agreement status check with circuit breaker.
 * This is called periodically by signPoller; can tolerate longer timeout.
 */
async function getAgreementStatus(agreementId) {
  return callApi('adobe', async () => {
    return _originalFunctions.getAgreementStatus(agreementId);
  }, {
    label: `adobe-sign-status-${agreementId}`,
    breakerOpts: {
      failureThreshold: 5,
      timeout: 60000,
    },
  });
}

/**
 * Wrapped signed PDF download with circuit breaker.
 * Critical path: user requested the signed document.
 * Fail fast if Adobe is down.
 */
async function getSignedPDF(agreementId) {
  return callApi('adobe', async () => {
    return _originalFunctions.getSignedPDF(agreementId);
  }, {
    label: `adobe-sign-download-${agreementId}`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 45000,
    },
  });
}

/**
 * Wrapped transient document upload with circuit breaker.
 */
async function uploadTransientDocument(buffer, fileName = 'document.pdf') {
  return callApi('adobe', async () => {
    return _originalFunctions.uploadTransientDocument(buffer, fileName);
  }, {
    label: `adobe-sign-upload-transient`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 45000,
    },
  });
}

/**
 * Wrapped webhook registration.
 */
async function ensureWebhook(webhookUrl) {
  return callApi('adobe', async () => {
    return _originalFunctions.ensureWebhook(webhookUrl);
  }, {
    label: `adobe-sign-ensure-webhook`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 30000,
    },
  });
}

/**
 * Wrapped merge field extraction (local operation, no breaker needed).
 */
function extractMergeFields(templateSchema, data) {
  return _originalFunctions.extractMergeFields(templateSchema, data);
}

// Export wrapped versions + original for testing
module.exports = {
  getToken,
  createPDF,
  extractMergeFields,
  uploadTransientDocument,
  createEnvelope,
  ensureWebhook,
  getAgreementStatus,
  getSignedPDF,
  _resetState: _originalFunctions._resetState,
};
