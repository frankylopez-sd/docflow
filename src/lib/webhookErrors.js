'use strict';
/**
 * Webhook error handling strategies.
 * Defines HTTP response codes based on failure type:
 * - 401: Security/validation failures (signature, JWT expiry)
 * - 422: Data validation warnings (but still queued—PDF gen catches full errors)
 * - 503: Queue/infrastructure failures (Azure will retry)
 * - 500: Unexpected internal errors
 */

const logger = require('./logger');

// Error categories for structured logging and response routing
const ErrorTypes = {
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  SIGNATURE_MISSING: 'SIGNATURE_MISSING',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_MALFORMED: 'TOKEN_MALFORMED',
  HIRE_DATA_INCOMPLETE: 'HIRE_DATA_INCOMPLETE',
  QUEUE_SUBMISSION_FAILED: 'QUEUE_SUBMISSION_FAILED',
  QUEUE_SERVICE_UNAVAILABLE: 'QUEUE_SERVICE_UNAVAILABLE',
  EVENT_PAYLOAD_INVALID: 'EVENT_PAYLOAD_INVALID',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/**
 * Map error types to HTTP status codes and retry behavior.
 */
const ErrorResponses = {
  [ErrorTypes.SIGNATURE_INVALID]: {
    status: 401,
    body: { error: 'invalid signature' },
    retryable: false,
    reason: 'Webhook signature validation failed',
  },
  [ErrorTypes.SIGNATURE_MISSING]: {
    status: 401,
    body: { error: 'missing authorization' },
    retryable: false,
    reason: 'Authorization header missing',
  },
  [ErrorTypes.TOKEN_EXPIRED]: {
    status: 401,
    body: { error: 'token expired' },
    retryable: false,
    reason: 'JWT token timestamp outside valid window',
  },
  [ErrorTypes.TOKEN_MALFORMED]: {
    status: 401,
    body: { error: 'malformed token' },
    retryable: false,
    reason: 'JWT token structure invalid',
  },
  [ErrorTypes.HIRE_DATA_INCOMPLETE]: {
    status: 422,
    body: { warning: 'incomplete hire data', queued: true, note: 'PDF generation will validate fully' },
    retryable: false,
    reason: 'Hire data missing optional fields; queued anyway for PDF gen to handle',
  },
  [ErrorTypes.QUEUE_SUBMISSION_FAILED]: {
    status: 503,
    body: { error: 'queue submission failed', retry: true },
    retryable: true,
    reason: 'Failed to submit message to processing queue; Azure will retry',
  },
  [ErrorTypes.QUEUE_SERVICE_UNAVAILABLE]: {
    status: 503,
    body: { error: 'queue service unavailable', retry: true },
    retryable: true,
    reason: 'Queue storage service is temporarily unavailable',
  },
  [ErrorTypes.EVENT_PAYLOAD_INVALID]: {
    status: 400,
    body: { error: 'invalid event payload' },
    retryable: false,
    reason: 'Event payload does not match expected schema',
  },
  [ErrorTypes.INTERNAL_ERROR]: {
    status: 500,
    body: { error: 'internal server error' },
    retryable: true,
    reason: 'Unexpected internal error occurred',
  },
};

/**
 * Structured webhook error.
 * @param {string} type - ErrorTypes value
 * @param {string} message - User-friendly message
 * @param {Object} details - Additional context for logging
 */
class WebhookError extends Error {
  constructor(type, message, details = {}) {
    super(message);
    this.name = 'WebhookError';
    this.type = type;
    this.details = details;
    this.response = ErrorResponses[type] || ErrorResponses[ErrorTypes.INTERNAL_ERROR];
  }

  /**
   * Get HTTP response for this error.
   */
  getResponse() {
    return {
      status: this.response.status,
      body: this.response.body,
    };
  }

  /**
   * Whether Azure should retry this webhook call.
   */
  isRetryable() {
    return this.response.retryable;
  }

  /**
   * Log this error with context.
   */
  log(context = {}) {
    const logLevel = this.response.retryable ? 'warn' : 'error';
    const logData = {
      errorType: this.type,
      message: this.message,
      reason: this.response.reason,
      httpStatus: this.response.status,
      retryable: this.response.retryable,
      ...this.details,
      ...context,
    };

    if (logLevel === 'error') {
      logger.error(`webhook-${this.type.toLowerCase()}`, this, logData);
    } else {
      logger.warn(`webhook-${this.type.toLowerCase()}`, logData);
    }
  }
}

/**
 * Validate Monday signature and extract claims.
 * Raises WebhookError if invalid.
 * @param {string} authHeader - Authorization header value
 * @param {string} secret - Webhook signing secret
 * @returns {{valid: boolean, reason?: string, claims?: Object}}
 */
function validateSignature(authHeader, secret) {
  if (!secret) {
    return { valid: true, reason: 'no-secret-configured' };
  }

  if (!authHeader) {
    throw new WebhookError(
      ErrorTypes.SIGNATURE_MISSING,
      'Authorization header is required but not present',
      { header: 'Authorization' }
    );
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new WebhookError(
      ErrorTypes.TOKEN_MALFORMED,
      'JWT token does not have 3 parts (header.payload.signature)',
      { parts: parts.length }
    );
  }

  const crypto = require('crypto');

  function _b64urlDecode(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  // Verify signature
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const provided = _b64urlDecode(parts[2]);

  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new WebhookError(
      ErrorTypes.SIGNATURE_INVALID,
      'JWT signature verification failed',
      { expectedLen: expected.length, providedLen: provided.length }
    );
  }

  // Decode and validate claims
  let payload;
  try {
    payload = JSON.parse(_b64urlDecode(parts[1]).toString('utf8'));
  } catch (err) {
    throw new WebhookError(
      ErrorTypes.TOKEN_MALFORMED,
      'JWT payload is not valid JSON',
      { parseError: err.message }
    );
  }

  // Check expiration
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    throw new WebhookError(
      ErrorTypes.TOKEN_EXPIRED,
      'JWT token has expired',
      { expiry: new Date(payload.exp * 1000).toISOString(), now: new Date().toISOString() }
    );
  }

  return { valid: true, claims: payload };
}

/**
 * Validate that hire data has minimum required fields.
 * Returns warnings if optional fields are missing, but doesn't throw.
 * (PDF generation will do full validation.)
 *
 * @param {Object} row - Monday row object
 * @param {Object} cols - Column configuration
 * @returns {{warnings: string[], allValid: boolean}}
 */
function validateHireData(row, cols) {
  const warnings = [];

  // Required fields for any hire
  const required = ['email', 'startDate', 'position'];
  for (const field of required) {
    const colId = cols[field];
    if (!colId || !row.columns || !row.columns[colId]) {
      warnings.push(`Missing required field: ${field}`);
    }
  }

  // Optional but strongly recommended
  const recommended = ['manager'];
  for (const field of recommended) {
    const colId = cols[field];
    if (!colId || !row.columns || !row.columns[colId]) {
      warnings.push(`Missing recommended field: ${field}`);
    }
  }

  return {
    allValid: warnings.length === 0,
    warnings,
  };
}

/**
 * Build a robust response for queue submission attempts.
 * Catches and converts queue errors into proper HTTP responses.
 *
 * @param {Error} err - The queue submission error
 * @returns {WebhookError}
 */
function queueErrorToWebhookError(err) {
  if (!err) {
    return new WebhookError(
      ErrorTypes.INTERNAL_ERROR,
      'Unknown queue error',
      {}
    );
  }

  const msg = String(err.message || '').toLowerCase();

  // Azure Storage service unavailable
  if (msg.includes('503') || msg.includes('service unavailable') || msg.includes('timeout')) {
    return new WebhookError(
      ErrorTypes.QUEUE_SERVICE_UNAVAILABLE,
      'Azure Queue Storage service is temporarily unavailable',
      { originalError: err.message }
    );
  }

  // Generic queue submission failure
  if (msg.includes('queue') || msg.includes('storage')) {
    return new WebhookError(
      ErrorTypes.QUEUE_SUBMISSION_FAILED,
      'Failed to submit message to processing queue',
      { originalError: err.message, code: err.code }
    );
  }

  // Fallback
  return new WebhookError(
    ErrorTypes.INTERNAL_ERROR,
    err.message || 'Unexpected internal error',
    { originalError: err.message }
  );
}

module.exports = {
  ErrorTypes,
  ErrorResponses,
  WebhookError,
  validateSignature,
  validateHireData,
  queueErrorToWebhookError,
};
