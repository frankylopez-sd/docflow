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
    let { boardId, itemId, firstName, lastName, workEmail, adpJobTitle, adpDepartment, supervisor, payRate, payFrequency, startDate } = queueItem;

    logger.info('generatePDF-start', { itemId });

    // Webhook-triggered messages carry only {boardId, itemId}. Monday is the
    // database of record — hydrate any missing hire fields from the board.
    if (!firstName || !lastName || !workEmail || !adpJobTitle) {
      const hire = await monday.fetchHireData(boardId, itemId);
      firstName = firstName || hire.firstName;
      lastName = lastName || hire.lastName;
      workEmail = workEmail || hire.workEmail;
      adpJobTitle = adpJobTitle || hire.adpJobTitle;
      adpDepartment = adpDepartment || hire.adpDepartment;
      supervisor = supervisor || hire.supervisor;
      payRate = payRate || hire.payRate;
      payFrequency = payFrequency || hire.payFrequency;
      startDate = startDate || hire.startDate;
      logger.info('generatePDF-hydrated-from-monday', { itemId });
    }

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

    // Select the offer-letter template by role: licensed pharmacists get the
    // salaried/licensure letter, everyone else the standard hourly letter.
    const isPharmacist = /^pharmacist\b/i.test(String(adpJobTitle || ''));
    const templateKey = isPharmacist
      ? (process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER_RPH || 'offer-letter-rph.docx')
      : (process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER || 'offer-letter-clerk.docx');

    // Call Adobe PDF Services to merge template
    logger.info('generatePDF-calling-adobe', { itemId, templateKey });
    const pdfBuffer = await adobe.generateOfferLetter(mergeData, { templateKey });

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('Adobe returned empty PDF');
    }

    logger.info('generatePDF-created', { itemId, size: pdfBuffer.length });

    // Upload to blob storage (temp container, 24h expiry).
    // Use the SAS URL so Adobe Sign can fetch the document without auth.
    const fileName = `offer-${itemId}-${Date.now()}.pdf`;
    const upload = await blob.uploadPDF('pdf-temp', fileName, pdfBuffer);
    const tempUrl = upload.sasUrl;

    logger.info('generatePDF-uploaded', { itemId, url: tempUrl });

    // Update Monday with PDF URL
    await monday.updateItemColumn(boardId, itemId, cfg.monday.columns.pdfUrl, { url: tempUrl, text: 'Offer PDF' }).catch(err => {
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
