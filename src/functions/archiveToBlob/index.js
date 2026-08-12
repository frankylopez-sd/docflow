'use strict';
/**
 * archiveToBlob: queue-triggered final stage. Downloads the signed PDF,
 * stores it permanently in pdf-archive (byte-verified, secondary-account
 * fallback handled by lib/blob), writes status + link back to the onboarding
 * row, and creates the Archive board record.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const blob = require('../../lib/blob');
const { downloadSigned } = require('../downloadSigned');
const { updateMondayStatus } = require('../updateMonday');

/** Find the onboarding item that owns this agreementId (webhook payloads don't carry it). */
async function findItemByAgreementId(agreementId) {
  const cfg = config.load();
  const query = `
    query ($boardId: ID!, $columnId: String!, $value: String!) {
      items_page_by_column_values (
        board_id: $boardId,
        columns: [{column_id: $columnId, column_values: [$value]}],
        limit: 1
      ) {
        items { id name }
      }
    }`;
  const data = await monday._gql(query, {
    boardId: String(cfg.monday.onboardingBoardId),
    columnId: cfg.monday.columns.agreementId,
    value: agreementId,
  }, 'monday-find-by-agreement');
  const item = data.items_page_by_column_values &&
    data.items_page_by_column_values.items &&
    data.items_page_by_column_values.items[0];
  return item ? { itemId: item.id, name: item.name } : null;
}

/**
 * Core pipeline step (exported for tests).
 * @param {Object} msg {agreementId, itemId?, boardId?, signers?}
 */
async function processArchive(msg) {
  const cfg = config.load();
  const { agreementId } = msg;
  let itemId = msg.itemId || null;
  let boardId = msg.boardId || cfg.monday.onboardingBoardId;
  let employeeName = msg.employeeName || null;

  try {
    if (!itemId) {
      const found = await findItemByAgreementId(agreementId);
      if (!found) throw new Error(`No Monday item found with agreementId ${agreementId}`);
      itemId = found.itemId;
      employeeName = employeeName || found.name;
    }
    if (!employeeName) {
      const row = await monday.readRow(boardId, itemId);
      employeeName = row.name;
      msg.docType = msg.docType || row.columns[cfg.monday.columns.template] || 'Document';
    }

    // 1. fetch signed bytes from Adobe
    const signedPdf = await downloadSigned(agreementId);

    // 2. permanent archive: {employeeId}_{docType}_{timestamp}.pdf
    const docType = (msg.docType || 'Document').replace(/[^\w-]+/g, '-');
    const key = `${itemId}_${docType}_${Date.now()}.pdf`;
    const uploaded = await blob.uploadPDF(cfg.storage.archiveContainer, key, signedPdf);
    const permanentUrl = blob.blobUrl(cfg.storage.archiveContainer, key);

    // 3. status + link back on the onboarding row
    await updateMondayStatus(boardId, itemId, {
      status: 'Completed',
      signedPdfUrl: permanentUrl,
      signerDetails: msg.signers || [],
    });

    // 4. archive board record
    let archiveItemId = null;
    if (cfg.monday.archiveBoardId) {
      archiveItemId = await monday.createArchiveRow(cfg.monday.archiveBoardId, {
        employee: employeeName || String(itemId),
        docType: msg.docType || 'Document',
        signedDate: new Date().toISOString(),
        signers: msg.signers || [],
        pdfLink: permanentUrl,
        agreementId,
      });
    }

    logger.event('archive-stage-complete', { agreementId, itemId, key, archiveItemId });
    return { itemId, key, url: permanentUrl, sasUrl: uploaded.sasUrl, archiveItemId };
  } catch (err) {
    logger.error('archive-to-blob-failed', err, { agreementId, itemId });
    if (itemId) {
      try {
        await monday.updateStatus(boardId, itemId, { status: 'Archive Error' }, { verify: false });
      } catch (inner) {
        logger.error('archive-error-status-write-failed', inner, { itemId });
      }
    }
    throw err;
  }
}

module.exports = async function (context, message) {
  const msg = typeof message === 'string' ? JSON.parse(message) : message;
  await processArchive(msg);
};

module.exports.processArchive = processArchive;
module.exports.findItemByAgreementId = findItemByAgreementId;
