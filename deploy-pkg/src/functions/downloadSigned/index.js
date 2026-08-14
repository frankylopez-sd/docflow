'use strict';
/**
 * downloadSigned: fetch the fully-signed PDF from Adobe Sign.
 * Used two ways:
 *  - core module (downloadSigned) called by the archive pipeline
 *  - key-protected HTTP endpoint for manual re-fetch during ops
 * Retry (2x) lives in adobe.getSignedPDF; failures propagate to the caller.
 */

const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');

/**
 * @param {string} agreementId
 * @returns {Promise<Buffer>} signed PDF bytes
 */
async function downloadSigned(agreementId) {
  if (!agreementId) throw new Error('downloadSigned: agreementId is required');
  return adobe.getSignedPDF(agreementId);
}

module.exports = async function (context, req) {
  const agreementId = (context.bindingData && context.bindingData.agreementId) ||
    (req.query && req.query.agreementId);
  try {
    const buffer = await downloadSigned(agreementId);
    context.res = {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${agreementId}.pdf"`,
      },
      body: buffer,
      isRaw: true,
    };
  } catch (err) {
    logger.error('download-signed-http-failed', err, { agreementId });
    context.res = { status: 502, body: { error: err.message } };
  }
};

module.exports.downloadSigned = downloadSigned;
