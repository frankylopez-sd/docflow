'use strict';
/**
 * uploadToSharePoint: queue-triggered, uploads the fully-signed PDF to SharePoint
 * after Adobe Sign completion.
 *
 * Flow:
 * 1. Download signed PDF from Adobe
 * 2. Upload to SharePoint (Documents/Onboarding/{year}/{month}/{docType}/)
 * 3. Tag with metadata (employee, agreementId, signDate)
 * 4. Update Monday onboarding row with SharePoint link
 * 5. Log completion; surface errors for DLQ
 *
 * Queue message format:
 *   {agreementId, itemId?, boardId?, employeeName?, docType?, signers?}
 *
 * Error handling:
 * - Transient errors (429, 5xx): retry up to 3x with exponential backoff
 * - SharePoint unavailable: DLQ for manual replay
 * - Metadata tagging failures: non-blocking (log + continue)
 * - Monday update failures: non-blocking (link still in SharePoint)
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const sharepoint = require('../../lib/sharepoint');
const { downloadSigned } = require('../downloadSigned');

/** Find the onboarding item that owns this agreementId. */
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
 * Core pipeline: download signed PDF, upload to SharePoint, update Monday.
 * @param {Object} msg {agreementId, itemId?, boardId?, employeeName?, docType?}
 * @returns {Promise<Object>} { itemId, agreementId, shareLinkUrl, itemId: spItemId }
 */
async function processSharePointUpload(msg) {
  const cfg = config.load();
  const { agreementId } = msg;
  let itemId = msg.itemId || null;
  let boardId = msg.boardId || cfg.monday.onboardingBoardId;
  let employeeName = msg.employeeName || null;
  // Leave docType unset here — step 2 fills it from the Monday row's template
  // column (falling back to 'Document') when the message doesn't carry one.
  let docType = msg.docType || null;

  // Bail early if SharePoint is not enabled
  if (!cfg.sharepoint.enabled) {
    logger.warn('sharepoint-disabled', { agreementId });
    return { skipped: true, reason: 'SharePoint integration not enabled' };
  }

  try {
    // 1. Resolve itemId if not provided
    if (!itemId) {
      const found = await findItemByAgreementId(agreementId);
      if (!found) {
        throw new Error(`No Monday item found with agreementId ${agreementId}`);
      }
      itemId = found.itemId;
      employeeName = employeeName || found.name;
    }

    // 2. Fetch row for docType if not provided
    if (!employeeName || !docType) {
      const row = await monday.readRow(boardId, itemId);
      employeeName = employeeName || row.name;
      docType = docType || row.columns[cfg.monday.columns.template] || 'Document';
    }

    // 3. Download signed PDF from Adobe
    logger.info('sharepoint-download-start', { agreementId, itemId });
    const signedPdf = await downloadSigned(agreementId);
    logger.info('sharepoint-download-complete', { agreementId, bytes: signedPdf.length });

    // 4. Upload to SharePoint
    const fileName = `${itemId}_${docType}_${Date.now()}.pdf`;
    const metadata = {
      fileName,
      docType: docType.replace(/[^\w-]+/g, '-'),
      employeeName,
      agreementId,
      signDate: new Date().toISOString(),
    };

    logger.info('sharepoint-upload-start', { agreementId, itemId, fileName });
    const spUpload = await sharepoint.uploadPDF(signedPdf, metadata, { retries: 2 });
    logger.event('sharepoint-upload-success', {
      agreementId,
      itemId,
      spItemId: spUpload.id,
      fileName: spUpload.name,
      bytes: spUpload.bytes,
    });

    // 5. Update Monday with SharePoint link (non-blocking)
    try {
      const sharePointLinkColumn = cfg.monday.columns.sharePointLink || 'link_sharepoint';
      await monday.updateStatus(boardId, itemId, {
        [sharePointLinkColumn]: spUpload.webUrl,
      }, { verify: false });
      logger.info('sharepoint-monday-link-updated', {
        agreementId,
        itemId,
        spItemId: spUpload.id,
      });
    } catch (mondayErr) {
      logger.warn('sharepoint-monday-update-failed', {
        agreementId,
        itemId,
        error: mondayErr.message,
      });
      // Don't fail the entire flow if Monday update fails
    }

    // 6. Update Monday status to "Shared to SharePoint"
    try {
      await monday.updateStatus(boardId, itemId, {
        status: 'Shared to SharePoint',
      }, { verify: false });
    } catch (statusErr) {
      logger.warn('sharepoint-status-update-failed', {
        agreementId,
        itemId,
        error: statusErr.message,
      });
    }

    logger.event('sharepoint-stage-complete', {
      agreementId,
      itemId,
      spItemId: spUpload.id,
      shareLinkUrl: spUpload.webUrl,
    });

    return {
      itemId,
      agreementId,
      shareLinkUrl: spUpload.webUrl,
      spItemId: spUpload.id,
      fileName: spUpload.name,
    };
  } catch (err) {
    logger.error('upload-to-sharepoint-failed', err, {
      agreementId,
      itemId,
      docType,
      employeeName,
    });

    // Attempt to mark Monday status as "SharePoint Upload Error"
    if (itemId) {
      try {
        await monday.updateStatus(boardId, itemId, {
          status: 'SharePoint Upload Error',
        }, { verify: false });
      } catch (inner) {
        logger.error('sharepoint-error-status-write-failed', inner, { itemId });
      }
    }

    // Re-throw to trigger DLQ (if max retries exceeded by Azure Functions runtime)
    throw err;
  }
}

/**
 * Azure Function entry point: queue trigger.
 * Message is automatically deserialized; if parsing fails, Azure Functions
 * handles poison queue routing.
 */
module.exports = async function (context, message) {
  const msg = typeof message === 'string' ? JSON.parse(message) : message;

  try {
    const result = await processSharePointUpload(msg);
    logger.info('sharepoint-queue-processing-complete', { result });
    // Function completes successfully; message is dequeued.
    // If an exception is thrown, Azure Functions runtime enqueues to DLQ after max retries.
  } catch (err) {
    logger.error('sharepoint-queue-processing-failed', err, {
      message: msg,
    });
    // Re-throw to allow Azure Functions to handle DLQ routing
    throw err;
  }
};

module.exports.processSharePointUpload = processSharePointUpload;
module.exports.findItemByAgreementId = findItemByAgreementId;
