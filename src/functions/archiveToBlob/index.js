'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const blob = require('../../lib/blob');
const monday = require('../../lib/monday');

/**
 * archiveToBlob: Queue-triggered function that archives signed PDF
 * Downloads from Adobe Sign, uploads to SharePoint, updates Monday
 */

async function processArchive(context, queueItem) {
  const cfg = config.load();

  // Support both Azure Functions (context + queueItem) and test (queueItem only) signatures
  if (!queueItem && context && typeof context === 'object' && context.agreementId) {
    queueItem = context;
    context = { bindings: {} };
  }

  try {
    const { boardId, itemId, agreementId, firstName, lastName } = queueItem;

    logger.info('archiveToBlob-start', { itemId, agreementId });

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

    // Upload to archive blob (permanent storage)
    const archiveFileName = `signed-offer-${firstName}-${lastName}-${itemId}-${Date.now()}.pdf`;
    const archiveUrl = await blob.uploadPdf(signedPdfBuffer, archiveFileName, 'pdf-archive');

    logger.info('archiveToBlob-archived', { itemId, url: archiveUrl });

    // Update Monday with signed PDF link
    await monday.updateItemColumn(boardId, itemId, 'link_signed', archiveUrl).catch(err => {
      logger.warn('archiveToBlob-link-update-failed', { itemId, error: err.message });
    });

    // Final status: Onboarding Complete
    await monday.updateItemStatus(boardId, itemId, 'Onboarding Complete').catch(err => {
      logger.warn('archiveToBlob-final-status-update-failed', { itemId, error: err.message });
    });

    logger.info('archiveToBlob-complete', { itemId, archiveUrl });

    context.res = {
      status: 200,
      body: { itemId, archiveUrl, status: 'Signed document archived and onboarding complete' }
    };

  } catch (error) {
    logger.error('archiveToBlob-error', { error: error.message, itemId: queueItem?.itemId });

    // Update Monday: status → "Archive Error"
    await monday.updateItemStatus(queueItem?.boardId, queueItem?.itemId, 'Archive Error').catch(() => {});

    throw error;
  }
}

module.exports = processArchive;
module.exports.processArchive = processArchive;
