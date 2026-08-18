'use strict';
/**
 * sharePointUploadFunction: Queue-triggered function for uploading signed PDFs to SharePoint.
 *
 * Complements archiveToBlob for DUAL ARCHIVAL:
 * - archiveToBlob: Azure Blob Storage (primary, redundant, SAS URLs)
 * - sharePointUploadFunction: SharePoint Online (secure, employee-accessible, organized)
 *
 * Flow:
 * 1. Download signed PDF from Adobe Sign
 * 2. Upload to SharePoint with folder structure: /DocFlow/{year}/{month}/{employeeName}/
 * 3. Grant employee read access + create shareable link
 * 4. Create shortcuts back to Monday item
 * 5. Update Monday with SharePoint link
 * 6. Handle errors gracefully (non-critical failures don't block completion)
 *
 * Queue message format:
 *   {
 *     agreementId: string,
 *     itemId?: string,
 *     boardId?: string,
 *     employeeName?: string,
 *     employeeEmail?: string,
 *     docType?: string,
 *     firstName?: string,
 *     lastName?: string,
 *   }
 *
 * Error handling:
 * - Transient errors (429, 5xx): retry up to 3x with exponential backoff
 * - SharePoint unavailable: DLQ for manual replay
 * - Metadata/permission failures: non-blocking (log + continue)
 * - Monday update failures: non-blocking (link still in SharePoint)
 *
 * Returns:
 *   {
 *     success: boolean,
 *     itemId: string,
 *     agreementId: string,
 *     shareLinkUrl: string,
 *     sharePointItemId: string,
 *     folderUrl?: string,
 *     accessGranted?: boolean,
 *   }
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const sharepointClient = require('../../lib/sharepointClient');
const { downloadSigned } = require('../downloadSigned');

/**
 * Find the onboarding item that owns this agreementId.
 * Used when itemId is not provided in the queue message.
 */
async function findItemByAgreementId(agreementId) {
  try {
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
    const item = data.items_page_by_column_values?.items?.[0];
    return item ? { itemId: item.id, name: item.name } : null;
  } catch (err) {
    logger.warn('sharepoint-find-by-agreement-failed', { agreementId, error: err.message });
    return null;
  }
}

/**
 * Core pipeline: download signed PDF, upload to SharePoint, update Monday.
 * @param {Object} msg Queue message
 * @returns {Promise<Object>} Upload result
 */
async function processSharePointUpload(msg) {
  const cfg = config.load();
  const { agreementId } = msg;
  let itemId = msg.itemId || null;
  let boardId = msg.boardId || cfg.monday.onboardingBoardId;
  let employeeName = msg.employeeName || msg.firstName || 'Unknown';
  let employeeEmail = msg.employeeEmail || null;
  let docType = msg.docType || 'Document';

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
        logger.warn('sharepoint-no-monday-item', { agreementId });
        itemId = null; // Will still upload, just won't have Monday link
      } else {
        itemId = found.itemId;
        employeeName = employeeName === 'Unknown' ? found.name : employeeName;
      }
    }

    // 2. Fetch row for missing metadata
    if (itemId && (!employeeEmail || !docType || employeeName === 'Unknown')) {
      try {
        const row = await monday.readRow(boardId, itemId);
        employeeName = employeeName === 'Unknown' ? row.name : employeeName;
        employeeEmail = employeeEmail || row.columns[cfg.monday.columns.email] || null;
        docType = docType || row.columns[cfg.monday.columns.template] || 'Document';
      } catch (readErr) {
        logger.warn('sharepoint-read-monday-row-failed', { itemId, error: readErr.message });
        // Continue with what we have
      }
    }

    // 3. Download signed PDF from Adobe
    logger.info('sharepoint-download-start', { agreementId, itemId });
    const signedPdf = await downloadSigned(agreementId);
    logger.info('sharepoint-download-complete', { agreementId, bytes: signedPdf.length });

    if (!signedPdf || signedPdf.length === 0) {
      throw new Error('Adobe returned empty signed PDF');
    }

    // 4. Upload to SharePoint
    const fileName = `${docType.replace(/[^\w-]/g, '-')}_${Date.now()}.pdf`;
    logger.info('sharepoint-upload-to-sp-start', { agreementId, itemId, fileName, employeeName });

    const spUpload = await sharepointClient.uploadSignedDocument({
      pdfBuffer: signedPdf,
      employeeName,
      employeeEmail,
      docType,
      agreementId,
      itemId,
      boardId,
      fileName,
    });

    logger.event('sharepoint-upload-success', {
      agreementId,
      itemId,
      spItemId: spUpload.itemId,
      fileName: spUpload.fileName,
      bytes: spUpload.bytes,
      accessGranted: spUpload.accessGranted,
    });

    // 5. Update Monday with SharePoint link (non-blocking)
    if (itemId) {
      try {
        const sharePointLinkColumn = cfg.monday.columns.sharePointLink || 'link_sharepoint';
        await monday.updateStatus(boardId, itemId, {
          [sharePointLinkColumn]: spUpload.webUrl,
        }, { verify: false });
        logger.info('sharepoint-monday-link-updated', {
          agreementId,
          itemId,
          spItemId: spUpload.itemId,
        });
      } catch (mondayErr) {
        logger.warn('sharepoint-monday-update-failed', {
          agreementId,
          itemId,
          error: mondayErr.message,
        });
        // Don't fail the entire flow if Monday update fails
      }

      // 6. Update Monday status to "Shared to SharePoint" (non-blocking)
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
    }

    logger.event('sharepoint-upload-stage-complete', {
      agreementId,
      itemId,
      spItemId: spUpload.itemId,
      shareLinkUrl: spUpload.webUrl,
      folderUrl: spUpload.folderUrl,
    });

    return {
      success: true,
      itemId,
      agreementId,
      shareLinkUrl: spUpload.webUrl,
      sharePointItemId: spUpload.itemId,
      folderUrl: spUpload.folderUrl,
      fileName: spUpload.fileName,
      accessGranted: spUpload.accessGranted,
    };
  } catch (err) {
    logger.error('sharepoint-upload-failed', err, {
      agreementId,
      itemId,
      docType,
      employeeName,
    });

    // Attempt to mark Monday status as "SharePoint Upload Error" (non-blocking)
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
