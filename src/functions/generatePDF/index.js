'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const blob = require('../../lib/blob');
const monday = require('../../lib/monday');

/**
 * generatePDF: Queue-triggered function that generates offer letter PDF
 * Uses Adobe PDF Services to merge template with hire data
 * Uploads temp PDF to blob storage, queues for signing
 */

async function processGenerate(context, queueItem) {
  const cfg = config.load();

  // Support both Azure Functions (context + queueItem) and test (queueItem only) signatures
  if (!queueItem && context && typeof context === 'object' && context.boardId) {
    queueItem = context;
    context = { bindings: {} };
  }

  try {
    const { boardId, itemId, firstName, lastName, workEmail, adpJobTitle, adpDepartment, supervisor, payRate, payFrequency, startDate } = queueItem;

    logger.info('generatePDF-start', { itemId });

    // Update Monday: status → "Documentation Generating"
    await monday.updateItemStatus(boardId, itemId, 'Documentation Generating').catch(err => {
      logger.warn('generatePDF-status-update-failed', { itemId, error: err.message });
    });

    // Prepare merge data for Adobe template
    const mergeData = {
      firstName,
      lastName,
      jobTitle: adpJobTitle,
      department: adpDepartment,
      email: workEmail,
      supervisor,
      compensation: payRate,
      frequency: payFrequency,
      startDate: startDate || new Date().toISOString().split('T')[0],
      generatedDate: new Date().toISOString().split('T')[0]
    };

    // Call Adobe PDF Services to merge template
    logger.info('generatePDF-calling-adobe', { itemId });
    const pdfBuffer = await adobe.generateOfferLetter(mergeData);

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('Adobe returned empty PDF');
    }

    logger.info('generatePDF-created', { itemId, size: pdfBuffer.length });

    // Upload to blob storage (temp container, 24h expiry)
    const fileName = `offer-${itemId}-${Date.now()}.pdf`;
    const tempUrl = await blob.uploadPdf(pdfBuffer, fileName, 'pdf-temp');

    logger.info('generatePDF-uploaded', { itemId, url: tempUrl });

    // Update Monday with PDF URL
    await monday.updateItemColumn(boardId, itemId, 'link_pdf', tempUrl).catch(err => {
      logger.warn('generatePDF-link-update-failed', { itemId, error: err.message });
    });

    // Queue for signing (output binding matches function.json "signQueue")
    context.bindings.signQueue = {
      boardId,
      itemId,
      pdfUrl: tempUrl,
      firstName,
      lastName,
      workEmail,
      supervisor
    };

    logger.info('generatePDF-queued-sign', { itemId });

    context.res = {
      status: 200,
      body: { itemId, pdfUrl: tempUrl, status: 'PDF generated and queued for signing' }
    };

  } catch (error) {
    logger.error('generatePDF-error', { error: error.message, itemId: queueItem?.itemId });

    // Update Monday: status → "PDF Gen Failed"
    await monday.updateItemStatus(queueItem?.boardId, queueItem?.itemId, 'PDF Gen Failed').catch(() => {});

    throw error; // Let Azure retry based on maxDequeueCount
  }
}

// Export for Azure Functions (default) and tests (named)
module.exports = processGenerate;
module.exports.processGenerate = processGenerate;
