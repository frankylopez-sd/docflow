'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const blob = require('../../lib/blob');
const monday = require('../../lib/monday');
const { findItemByAgreementId } = require('../uploadToSharePoint');

/**
 * archiveToBlob: Queue-triggered function that archives signed PDF
 * Downloads from Adobe Sign, uploads to blob archive, updates Monday
 */

async function processArchive(context, queueItem) {
  const cfg = config.load();

  // Support both Azure Functions (context + queueItem) and test (queueItem only) signatures
  if (!queueItem && context && typeof context === 'object' && context.agreementId) {
    queueItem = context;
    context = { bindings: {} };
  }

  const boardId = queueItem?.boardId || cfg.monday.onboardingBoardId;
  let itemId = queueItem?.itemId || null;

  try {
    const { agreementId, firstName, lastName } = queueItem;
    let employeeName = [firstName, lastName].filter(Boolean).join('-') || null;

    logger.info('archiveToBlob-start', { itemId, agreementId });

    // Adobe webhook messages only carry the agreementId — resolve the Monday
    // item that owns this agreement before writing any status back.
    if (!itemId) {
      const found = await findItemByAgreementId(agreementId);
      if (!found) {
        throw new Error(`No Monday item found with agreementId ${agreementId}`);
      }
      itemId = found.itemId;
      employeeName = employeeName || found.name;
      logger.info('archiveToBlob-item-resolved', { itemId, agreementId });
    }

    // Update Monday: status → "Archived"
    await monday.updateItemStatus(boardId, itemId, 'Archived').catch(err => {
      logger.warn('archiveToBlob-status-update-failed', { itemId, error: err.message });
    });

    // Download signed PDF from Adobe
    logger.info('archiveToBlob-downloading-signed', { agreementId });
    const signedPdfBuffer = await adobe.downloadSignedDocument(agreementId);

    if (!signedPdfBuffer || signedPdfBuffer.length === 0) {
      throw new Error('Adobe returned empty signed PDF');
    }

    logger.info('archiveToBlob-downloaded', { agreementId, size: signedPdfBuffer.length });

    // Upload to archive blob (permanent storage, non-SAS URL for Monday)
    const safeName = String(employeeName || 'employee').replace(/[^\w-]+/g, '-');
    const archiveFileName = `signed-offer-${safeName}-${itemId}-${Date.now()}.pdf`;
    const upload = await blob.uploadPDF('pdf-archive', archiveFileName, signedPdfBuffer);
    const archiveUrl = upload.url;

    logger.info('archiveToBlob-archived', { itemId, url: archiveUrl });

    // Update Monday with signed PDF link
    await monday.updateItemColumn(boardId, itemId, cfg.monday.columns.signedPdfUrl, { url: archiveUrl, text: 'Signed PDF' }).catch(err => {
      logger.warn('archiveToBlob-link-update-failed', { itemId, error: err.message });
    });

    // Final status: Onboarding Complete
    await monday.updateItemStatus(boardId, itemId, 'Onboarding Complete').catch(err => {
      logger.warn('archiveToBlob-final-status-update-failed', { itemId, error: err.message });
    });

    // Downstream kickoff: open the background check and link it to the hire
    await monday.createBackgroundCheck(boardId, itemId, employeeName ? employeeName.replace(/-/g, ' ') : null).catch(err => {
      logger.warn('archiveToBlob-bg-check-create-failed', { itemId, error: err.message });
    });

    logger.info('archiveToBlob-complete', { itemId, archiveUrl });

    context.res = {
      status: 200,
      body: { itemId, archiveUrl, status: 'Signed document archived and onboarding complete' }
    };

  } catch (error) {
    logger.error('archiveToBlob-error', { error: error.message, itemId });

    // Update Monday: status → "Archive Error" (only when we know which item)
    if (itemId) {
      await monday.updateItemStatus(boardId, itemId, 'Archive Error').catch(() => {});
    }

    throw error;
  }
}

module.exports = processArchive;
module.exports.processArchive = processArchive;
