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

/**
 * Map hire-role signals to the durable template blob in pdf-templates.
 * Precedence: pharmacist → intern → sales → pay class → FLSA status.
 */
function selectTemplate({ adpJobTitle, payClass, flsaStatus, workerType }) {
  const title = String(adpJobTitle || '');
  const cls = String(payClass || '');
  const flsa = String(flsaStatus || '');
  const type = String(workerType || '');

  if (/^pharmacist\b/i.test(title) || /^rph$/i.test(cls)) {
    return process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER_RPH || 'offer-letter-rph.docx';
  }
  if (/intern/i.test(type) || /intern/i.test(title)) {
    return process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER_INTERN || 'offer-letter-paid-intern.docx';
  }
  if (/sales/i.test(title)) {
    return process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER_SALES || 'offer-letter-sales-exempt.docx';
  }
  if (/^clerk$/i.test(cls)) {
    return process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER || 'offer-letter-clerk.docx';
  }
  if (/non-?exempt/i.test(flsa)) {
    return process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER_NON_EXEMPT || 'offer-letter-other-non-exempt.docx';
  }
  if (/exempt/i.test(flsa)) {
    return process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER_EXEMPT || 'offer-letter-other-exempt.docx';
  }
  return process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER || 'offer-letter-clerk.docx';
}

async function processGenerate(context, queueItem) {
  const cfg = config.load();

  // Support both Azure Functions (context + queueItem) and test (queueItem only) signatures
  if (!queueItem && context && typeof context === 'object' && context.boardId) {
    queueItem = context;
    context = { bindings: {} };
  }

  try {
    let { boardId, itemId, firstName, lastName, workEmail, adpJobTitle, adpDepartment, supervisor, payRate, payFrequency, payClass, flsaStatus, workerType, startDate } = queueItem;

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
      payClass = payClass || hire.payClass;
      flsaStatus = flsaStatus || hire.flsaStatus;
      workerType = workerType || hire.workerType;
      startDate = startDate || hire.startDate;
      logger.info('generatePDF-hydrated-from-monday', { itemId });
    }

    // Gate: the letter can only be built if the employer fields are filled.
    // Missing data is a person's fix, not a retry's — stop cleanly, name the
    // gaps on the card, and wait for the checkbox to be re-checked.
    const REQUIRED_FOR_LETTER = {
      firstName: 'First name', lastName: 'Last name', workEmail: 'Work email',
      adpJobTitle: 'Job title', adpDepartment: 'Department', supervisor: 'Supervisor',
      payRate: 'Pay rate', payFrequency: 'Pay frequency',
    };
    const values = { firstName, lastName, workEmail, adpJobTitle, adpDepartment, supervisor, payRate, payFrequency };
    const missingFields = Object.entries(REQUIRED_FOR_LETTER)
      .filter(([key]) => values[key] == null || String(values[key]).trim() === '')
      .map(([, label]) => label);

    if (missingFields.length > 0) {
      logger.warn('generatePDF-missing-fields', { itemId, missing: missingFields });
      await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.missingFields).catch(() => {});
      await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.moreInfo).catch(() => {});
      await monday.logAction(itemId,
        `✋ Can't build the offer letter yet — ${missingFields.length === 1 ? 'one field is' : missingFields.length + ' fields are'} still empty:\n`
        + missingFields.map((f) => `  • ${f}`).join('\n')
        + `\n\nFill ${missingFields.length === 1 ? 'it' : 'them'} in on this card, then check ☑ Generate Docs again and the letter will build right away.`
      ).catch(() => {});
      context.res = { status: 200, body: { itemId, generated: false, missingFields } };
      return; // no throw — retries can't fill in fields, a person can
    }

    // Update Monday: status → ④ Docs In Progress, offer → ② Generating
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.docsInProgress).catch(err => {
      logger.warn('generatePDF-status-update-failed', { itemId, error: err.message });
    });
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.generating).catch(err => {
      logger.warn('generatePDF-offer-status-update-failed', { itemId, error: err.message });
    });

    await monday.logAction(itemId,
      `🛠️ Building ${firstName || 'the new hire'}'s offer letter now — this usually takes about a minute. The next comment will have the review checklist.`
    ).catch(err => logger.warn('generatePDF-start-notify-failed', { itemId, error: err.message }));

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

    // Select the offer-letter template from the hire's role signals.
    // Board vocabulary: payClass ∈ {Clerk, RPH, Management}, flsaStatus ∈
    // {Exempt, Non-Exempt}, workerType ∈ {Full-Time, Part-Time, Temp, Contract}.
    // Intern and Sales letters exist in pdf-templates and are selected once the
    // board grows those values (or via env override).
    const templateKey = selectTemplate({ adpJobTitle, payClass, flsaStatus, workerType });

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

    // HR review gate: the offer stops here as "Offer Ready". Signing is
    // queued by mondayWebhook only when HR flips the offer status to the
    // approval label ("Packaged Approved").
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.ready).catch(err => {
      logger.warn('generatePDF-offer-ready-update-failed', { itemId, error: err.message });
    });

    await monday.logAction(itemId,
      `📄 Offer letter generated for ${firstName} ${lastName} — YOUR MOVE. Open the PDF Document link and review:\n`
      + `  ☐ Name spelled correctly (${firstName} ${lastName})\n`
      + `  ☐ Position & department right (${adpJobTitle} / ${adpDepartment})\n`
      + `  ☐ Compensation & frequency right (${payRate} ${payFrequency})\n`
      + `  ☐ Start date right (${startDate})\n`
      + `  ☐ Supervisor right (${supervisor})\n\n`
      + `Looks good → set Offer Letter Status to "${cfg.monday.offerLabels.approved}" (this sends it automatically).\n`
      + `Something off → fix the field, re-check "Generate Docs" to regenerate. Or "${cfg.monday.offerLabels.denied}" / "${cfg.monday.offerLabels.moreInfo}" to stop.`,
      `Adobe Document Generation merged template "${templateKey}" with the hire record; PDF stored in pdf-temp blob (24h link) and linked on this item.`
    ).catch(err => logger.warn('generatePDF-notify-failed', { itemId, error: err.message }));

    logger.info('generatePDF-awaiting-hr-review', { itemId });

    context.res = {
      status: 200,
      body: { itemId, pdfUrl: tempUrl, status: 'PDF generated — awaiting HR review (Offer Ready)' }
    };

  } catch (error) {
    logger.error('generatePDF-error', { error: error.message, itemId: queueItem?.itemId });

    // Update Monday: status → PDF failed
    const failCfg = config.load();
    await monday.updateItemStatus(queueItem?.boardId, queueItem?.itemId, failCfg.monday.statusLabels.pdfFailed).catch(() => {});
    await monday.updateOfferStatus(queueItem?.boardId, queueItem?.itemId, failCfg.monday.offerLabels.failed).catch(() => {});
    // Notify once (first attempt), not on every automatic retry
    const attempt = context?.bindingData?.dequeueCount;
    if (queueItem?.itemId && (!attempt || Number(attempt) <= 1)) {
      await monday.logAction(queueItem.itemId,
        `❌ Offer letter generation failed. The system retries automatically; if this status stays red, verify the hire fields are complete and re-check "Generate Docs".`,
        `generatePDF error: ${error.message}`
      ).catch(() => {});
    }

    throw error; // Let Azure retry based on maxDequeueCount
  }
}

// Export for Azure Functions (default) and tests (named)
module.exports = processGenerate;
module.exports.processGenerate = processGenerate;
module.exports.selectTemplate = selectTemplate;
