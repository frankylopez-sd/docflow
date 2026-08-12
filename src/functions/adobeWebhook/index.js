'use strict';
/**
 * adobeWebhook: Adobe Sign completion callback.
 * Adobe validates webhooks by sending X-AdobeSign-ClientId and requiring it
 * echoed back — that header must match our client id or we reject. Returns
 * 200 immediately; the actual download/archive runs on the docflow-archive
 * queue.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');

const COMPLETED_EVENTS = new Set([
  'AGREEMENT_WORKFLOW_COMPLETED',
  'AGREEMENT_ACTION_COMPLETED_ALL',
]);

/**
 * Core handler (exported for tests).
 * @returns {{status:number, headers:Object, body:Object, queueMessage:Object|null}}
 */
async function handleAdobeWebhook(req) {
  const cfg = config.load();
  const clientIdHeader =
    (req.headers && (req.headers['x-adobesign-clientid'] || req.headers['X-AdobeSign-ClientId'])) || null;

  // Verification: header must be present and match our Adobe client id.
  if (!clientIdHeader || clientIdHeader !== cfg.adobe.clientId) {
    logger.warn('adobe-webhook-rejected', { reason: 'client-id-mismatch' });
    return { status: 401, headers: {}, body: { error: 'unknown client id' }, queueMessage: null };
  }
  const echoHeaders = { 'X-AdobeSign-ClientId': clientIdHeader };

  // Adobe's webhook-registration verification ping (GET or empty POST).
  const body = req.body || {};
  if (req.method === 'GET' || !body.event) {
    return {
      status: 200,
      headers: echoHeaders,
      body: { xAdobeSignClientId: clientIdHeader },
      queueMessage: null,
    };
  }

  const agreement = body.agreement || {};
  const agreementId = agreement.id || body.agreementId;
  const eventType = body.event;

  if (!agreementId) {
    logger.warn('adobe-webhook-no-agreement-id', { eventType });
    return {
      status: 200,
      headers: echoHeaders,
      body: { xAdobeSignClientId: clientIdHeader, ignored: true },
      queueMessage: null,
    };
  }

  let queueMessage = null;
  if (COMPLETED_EVENTS.has(eventType) || agreement.status === 'SIGNED') {
    queueMessage = {
      agreementId,
      eventType,
      agreementStatus: agreement.status || 'SIGNED',
      signers: (agreement.participantSetsInfo || []).map((ps) => ({
        order: ps.order,
        status: ps.status,
        emails: (ps.memberInfos || []).map((m) => m.email),
      })),
      receivedAt: new Date().toISOString(),
    };
    logger.event('agreement-completed-queued', { agreementId, eventType });
  } else {
    logger.info('adobe-webhook-event-ignored', { agreementId, eventType });
  }

  return {
    status: 200,
    headers: echoHeaders,
    body: { xAdobeSignClientId: clientIdHeader, received: true },
    queueMessage,
  };
}

module.exports = async function (context, req) {
  try {
    const result = await handleAdobeWebhook(req);
    if (result.queueMessage) context.bindings.archiveQueue = JSON.stringify(result.queueMessage);
    context.res = {
      status: result.status,
      headers: { 'Content-Type': 'application/json', ...result.headers },
      body: result.body,
    };
  } catch (err) {
    logger.error('adobe-webhook-failed', err);
    context.res = { status: 500, body: { error: 'internal error' } };
  }
};

module.exports.handleAdobeWebhook = handleAdobeWebhook;
