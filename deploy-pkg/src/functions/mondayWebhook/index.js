'use strict';
/**
 * Monday webhook receiver: checkbox checked on the onboarding board.
 * Validates the signed Authorization JWT, answers Monday's challenge
 * handshake, and enqueues async processing (returns 200 immediately —
 * the docflow-generate queue does the heavy lifting).
 */

const crypto = require('crypto');
const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');

function _b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Minimal HS256 JWT verification (Monday signs webhook Authorization headers
 * with the app signing secret). No jsonwebtoken dependency needed.
 */
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
 * Core handler (exported for tests / integration flow).
 * @returns {{status:number, body:Object, queueMessage:Object|null}}
 */
async function handleWebhook(req) {
  const cfg = config.load();
  const body = req.body || {};

  // Monday URL-verification handshake: echo the challenge.
  if (body.challenge) {
    return { status: 200, body: { challenge: body.challenge }, queueMessage: null };
  }

  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || null;
  const sig = verifySignature(auth, cfg.monday.signingSecret);
  if (!sig.valid) {
    logger.warn('monday-webhook-rejected', { reason: sig.reason });
    return { status: 401, body: { error: 'invalid signature' }, queueMessage: null };
  }

  const event = body.event || {};
  const boardId = event.boardId || cfg.monday.onboardingBoardId;
  const itemId = event.pulseId || event.itemId;
  if (!itemId) {
    logger.warn('monday-webhook-no-item', { eventType: event.type });
    return { status: 200, body: { ignored: true, reason: 'no itemId' }, queueMessage: null };
  }

  // Only react to the trigger checkbox being CHECKED.
  const isColumnEvent = event.type === 'update_column_value' || event.type === 'change_column_value';
  const isTriggerColumn = !event.columnId || event.columnId === cfg.monday.columns.trigger;
  const checked = event.value && (event.value.checked === true || event.value.checked === 'true');
  if (isColumnEvent && (!isTriggerColumn || !checked)) {
    return { status: 200, body: { ignored: true, reason: 'not trigger checkbox checked' }, queueMessage: null };
  }

  const queueMessage = {
    boardId: String(boardId),
    itemId: String(itemId),
    eventType: event.type || 'unknown',
    receivedAt: new Date().toISOString(),
  };
  logger.event('onboarding-request-queued', queueMessage);
  return { status: 200, body: { queued: true, itemId: String(itemId) }, queueMessage };
}

module.exports = async function (context, req) {
  try {
    const result = await handleWebhook(req);
    if (result.queueMessage) context.bindings.generateQueue = JSON.stringify(result.queueMessage);
    context.res = { status: result.status, headers: { 'Content-Type': 'application/json' }, body: result.body };
  } catch (err) {
    logger.error('monday-webhook-failed', err);
    // Best effort: surface the failure on the board so HR sees it.
    try {
      const cfg = config.load();
      const itemId = req.body && req.body.event && (req.body.event.pulseId || req.body.event.itemId);
      if (itemId) {
        await monday.updateStatus(cfg.monday.onboardingBoardId, itemId, { status: 'Webhook Error' }, { verify: false });
      }
    } catch (inner) {
      logger.error('monday-webhook-error-status-write-failed', inner);
    }
    context.res = { status: 500, body: { error: 'internal error' } };
  }
};

module.exports.handleWebhook = handleWebhook;
module.exports.verifySignature = verifySignature;
