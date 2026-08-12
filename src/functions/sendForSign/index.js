'use strict';
/**
 * sendForSign: queue-triggered. Creates the Adobe Sign envelope with serial
 * signing order (HR -> Manager -> Employee) and writes the agreementId back
 * to Monday. The signPoller timer is the 30-min fallback if Adobe's webhook
 * never fires.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const monday = require('../../lib/monday');

/**
 * Normalize the template's signer list into ordered {email, name} entries.
 * Catalog rows store signers as emails or role placeholders; the placeholder
 * "{employee}" resolves to the onboarding row's email.
 */
function resolveSigners(templateSigners, msg) {
  const raw = Array.isArray(templateSigners) && templateSigners.length
    ? templateSigners
    : ['{employee}'];
  const resolved = raw.map((s) => {
    const entry = typeof s === 'string' ? { email: s } : s;
    if (entry.email === '{employee}' || /employee/i.test(entry.role || '')) {
      return { email: msg.employeeEmail, name: msg.employeeName };
    }
    return entry;
  });
  const missing = resolved.filter((s) => !s.email);
  if (missing.length) throw new Error('sendForSign: signer list has entries without an email');
  return resolved;
}

/**
 * Core pipeline step (exported for tests).
 * @param {Object} msg {boardId, itemId, pdfUrl, signers, employeeEmail, employeeName, templateName}
 */
async function processSend(msg) {
  const { boardId, itemId } = msg;
  try {
    const signers = resolveSigners(msg.signers, msg);
    const envelope = await adobe.createEnvelope(msg.pdfUrl, signers, {
      name: `${msg.templateName || 'Document'} — ${msg.employeeName || itemId}`,
      fileName: msg.pdfKey || 'document.pdf',
    });

    await monday.updateStatus(boardId, itemId, {
      status: 'Sent for Sign',
      agreementId: envelope.agreementId,
      signerDetails: envelope.signers,
    });

    logger.event('sign-stage-complete', { itemId, agreementId: envelope.agreementId });
    return { agreementId: envelope.agreementId, signers: envelope.signers };
  } catch (err) {
    logger.error('send-for-sign-failed', err, { boardId, itemId });
    try {
      await monday.updateStatus(boardId, itemId, { status: 'Sign Failed' }, { verify: false });
    } catch (inner) {
      logger.error('send-for-sign-status-write-failed', inner, { itemId });
    }
    throw err;
  }
}

module.exports = async function (context, message) {
  const msg = typeof message === 'string' ? JSON.parse(message) : message;
  await processSend(msg);
};

module.exports.processSend = processSend;
module.exports.resolveSigners = resolveSigners;
