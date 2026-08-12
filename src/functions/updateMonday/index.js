'use strict';
/**
 * updateMonday: writes status/tracking columns back to a board item with
 * read-back verification and retry (both inside monday.updateStatus).
 * Exposed as a core module for the pipeline plus a key-protected HTTP
 * endpoint for manual ops fixes. Failures here are logged + alerted but
 * must not sink the whole pipeline — callers decide whether to rethrow.
 */

const logger = require('../../lib/logger');
const monday = require('../../lib/monday');

/**
 * @param {Object} values {status, agreementId, pdfUrl, signedPdfUrl, signerDetails}
 */
async function updateMondayStatus(boardId, itemId, values) {
  try {
    return await monday.updateStatus(boardId, itemId, values);
  } catch (err) {
    logger.error('update-monday-failed', err, { boardId, itemId, status: values && values.status });
    logger.event('alert-monday-write-failed', { boardId, itemId });
    throw err;
  }
}

module.exports = async function (context, req) {
  const body = req.body || {};
  const { boardId, itemId, values } = body;
  if (!boardId || !itemId || !values) {
    context.res = { status: 400, body: { error: 'boardId, itemId and values are required' } };
    return;
  }
  try {
    const result = await updateMondayStatus(boardId, itemId, values);
    context.res = { status: 200, body: result };
  } catch (err) {
    context.res = { status: 502, body: { error: err.message } };
  }
};

module.exports.updateMondayStatus = updateMondayStatus;
