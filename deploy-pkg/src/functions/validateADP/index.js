'use strict';
/**
 * ADP Validation: checks all 23 required ADP fields on hire record.
 * Updates status column to "Create New Hire" (all fields complete) or
 * "Missing Required Fields" (incomplete). Returns 200 immediately.
 */

const crypto = require('crypto');
const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');

function _b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifySignature(authHeader, secret) {
  if (!secret) return { valid: true, reason: 'no-secret-configured' };
  if (!authHeader) return { valid: false, reason: 'missing-authorization-header' };

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed-jwt' };

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const provided = _b64urlDecode(parts[2]);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { valid: false, reason: 'bad-signature' };
  }

  try {
    const payload = JSON.parse(_b64urlDecode(parts[1]).toString('utf8'));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { valid: false, reason: 'token-expired' };
    }
  } catch (_) {
    return { valid: false, reason: 'bad-payload' };
  }
  return { valid: true };
}

/**
 * All 23 required ADP fields.
 * Column ID → human-readable name for logging.
 */
const ADP_FIELDS = {
  // Personal
  'text_mm65hxkh': 'Work Email',
  'text_mm65ktsr': 'Badge Number',
  // Employment
  'dropdown_mm65yf4s': 'ADP Job Title',
  'dropdown_mm65xbge': 'ADP Department',
  'dropdown_mm65fa2g': 'ADP Work Location',
  'dropdown_mm65jpby': 'Worker Type',
  'board_relation_mm65qm64': 'Supervisor',
  'dropdown_mm66d04': 'Reason for Hire',
  // Payroll
  'dropdown_mm65v43b': 'Pay Type',
  'numeric_mm65mx3m': 'Pay Rate',
  'dropdown_mm658n1t': 'Pay Frequency',
  'dropdown_mm6566ff': 'Company Code',
  'dropdown_mm65aswt': 'Pay Class',
  // Tax
  'dropdown_mm6576ra': 'FLSA Status',
  'dropdown_mm651ram': 'SUI/SDI Tax Code',
  // Time & Attendance
  'dropdown_mm65r639': 'Workers Comp Status',
  'dropdown_mm65e9dz': 'Workers Comp Job Class Code',
  'dropdown_mm66y9tg': 'Worked-In State',
  'dropdown_mm669dw4': 'Lived-In State',
  'dropdown_mm66x62b': 'Time Zone',
  'color_mm651h50': 'Benefits Eligibility',
  'dropdown_mm66xmr6': 'Benefits Eligibility Class',
  'dropdown_mm66tnrh': 'Onboarding Experience',
};

function isFieldEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (typeof value === 'object' && Object.keys(value).length === 0) return true;
  return false;
}

/**
 * Validate all 23 ADP fields on a hire record.
 * @returns {{ isComplete: boolean, missingFields: string[] }}
 */
function validateADPFields(columnValues) {
  const missingFields = [];

  Object.entries(ADP_FIELDS).forEach(([columnId, fieldName]) => {
    const value = columnValues[columnId];
    if (isFieldEmpty(value)) {
      missingFields.push(fieldName);
    }
  });

  return {
    isComplete: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Core handler (exported for tests).
 * @returns {{status:number, body:Object}}
 */
async function handleValidation(req, cfg) {
  const body = req.body || {};

  // Monday challenge handshake
  if (body.challenge) {
    return { status: 200, body: { challenge: body.challenge } };
  }

  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || null;
  const sig = verifySignature(auth, cfg.monday.signingSecret);
  if (!sig.valid) {
    logger.warn('validateADP-rejected', { reason: sig.reason });
    return { status: 401, body: { error: 'invalid signature' } };
  }

  const event = body.event || {};
  const boardId = event.boardId || cfg.monday.onboardingBoardId;
  const itemId = event.pulseId || event.itemId;
  if (!itemId) {
    logger.warn('validateADP-no-item', { eventType: event.type });
    return { status: 200, body: { ignored: true, reason: 'no itemId' } };
  }

  try {
    // Fetch the full hire record from Monday
    const item = await monday.readRow(boardId, itemId);

    // Validate all 23 ADP fields
    const validation = validateADPFields(item.columns);
    const newStatus = validation.isComplete ? 'Create New Hire' : 'Missing Required Fields';

    // Post status back to Monday
    await monday.updateStatus(boardId, itemId, { status: newStatus }, { verify: false });

    const logData = {
      boardId: String(boardId),
      itemId: String(itemId),
      isComplete: validation.isComplete,
      missingCount: validation.missingFields.length,
      newStatus,
    };
    if (!validation.isComplete) {
      logData.missingFields = validation.missingFields;
    }
    logger.event('adp-validation-complete', logData);

    return { status: 200, body: { validated: true, isComplete: validation.isComplete, newStatus } };
  } catch (err) {
    logger.error('validateADP-validation-failed', err);
    // Best effort: try to mark as error on board
    try {
      await monday.updateStatus(boardId, itemId, { status: 'Validation Error' }, { verify: false });
    } catch (inner) {
      logger.error('validateADP-error-status-write-failed', inner);
    }
    return { status: 200, body: { error: 'validation failed', details: err.message } };
  }
}

module.exports = async function (context, req) {
  try {
    const cfg = config.load();
    const result = await handleValidation(req, cfg);
    context.res = { status: result.status, headers: { 'Content-Type': 'application/json' }, body: result.body };
  } catch (err) {
    logger.error('validateADP-handler-failed', err);
    context.res = { status: 500, body: { error: 'internal error' } };
  }
};

module.exports.handleValidation = handleValidation;
module.exports.validateADPFields = validateADPFields;
