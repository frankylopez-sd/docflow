'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const blob = require('../../lib/blob');
const monday = require('../../lib/monday');
const { stepHeader } = require('../../lib/util');

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
      // Required: without it the letter would print TODAY as the start date —
      // a wrong date on a signed legal document.
      startDate: 'Start date',
    };
    const values = { firstName, lastName, workEmail, adpJobTitle, adpDepartment, supervisor, payRate, payFrequency, startDate };
    const missingFields = Object.entries(REQUIRED_FOR_LETTER)
      .filter(([key]) => values[key] == null || String(values[key]).trim() === '')
      .map(([, label]) => label);

    if (missingFields.length > 0) {
      logger.warn('generatePDF-missing-fields', { itemId, missing: missingFields });
      await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.missingFields).catch(() => {});
      await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.moreInfo).catch(() => {});
      await monday.logAction(itemId,
        stepHeader(2, 'Hire details')
        + `✋ ${missingFields.length === 1 ? 'One field is' : `${missingFields.length} fields are`} still empty:\n`
        + missingFields.map((f) => `    ${f}`).join('\n')
        + `\n\nYour move\n`
        + `    ✎ fill ${missingFields.length === 1 ? 'it' : 'them'} in, then check ☑ Details Verified. The letter builds right away.`
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
      stepHeader(3, 'Writing letter')
      + `Writing ${firstName || 'the hire'}'s offer letter — about a minute.\n\n`
      + `Next → the finished letter posts here with a five-point checklist.`
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
      startDate,
      generatedDate: new Date().toISOString().split('T')[0],
      // Adobe Sign text tags — Sign converts these into real signature/date
      // fields. Candidate mode: only the hire signs (signer1); serial mode
      // maps HR/Manager/Employee to signers 1/2/3.
      ...(cfg.adobe.signMode === 'serial3'
        ? {
            sigHr: '{{Sig_es_:signer1:signature}}',
            dateHr: '{{Dte_es_:signer1:date}}',
            sigManager: '{{Sig_es_:signer2:signature}}',
            dateManager: '{{Dte_es_:signer2:date}}',
            sigEmployee: '{{Sig_es_:signer3:signature}}',
            dateEmployee: '{{Dte_es_:signer3:date}}',
          }
        : {
            sigHr: '(on file)',
            dateHr: '',
            sigManager: '(on file)',
            dateManager: '',
            sigEmployee: '{{Sig_es_:signer1:signature}}',
            dateEmployee: '{{Dte_es_:signer1:date}}',
          })
    };

    const { startProgress } = require('../../lib/util');
    const progress = startProgress((t) => monday.logAction(itemId, t), { phase: 'picking the right offer-letter template for this role' });

    // Select the offer-letter template from the hire's role signals.
    // Board vocabulary: payClass ∈ {Clerk, RPH, Management}, flsaStatus ∈
    // {Exempt, Non-Exempt}, workerType ∈ {Full-Time, Part-Time, Temp, Contract}.
    // Intern and Sales letters exist in pdf-templates and are selected once the
    // board grows those values (or via env override).
    const templateKey = selectTemplate({ adpJobTitle, payClass, flsaStatus, workerType });

    // Call Adobe PDF Services to merge template
    logger.info('generatePDF-calling-adobe', { itemId, templateKey });
    progress.setPhase(`Adobe is merging the hire's details into "${templateKey}"`);
    let pdfBuffer;
    try {
      pdfBuffer = await adobe.generateOfferLetter(mergeData, { templateKey });
    } catch (err) {
      progress.stop();
      throw err;
    }

    if (!pdfBuffer || pdfBuffer.length === 0) {
      progress.stop();
      throw new Error('Adobe returned empty PDF');
    }
    progress.setPhase('storing the PDF and attaching it to this card');

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

    // Attach the real PDF to the card so HR previews it inline — the storage
    // link expires in 24h, this copy never does.
    const attached = await monday.attachFile(
      itemId, cfg.monday.columns.offerFile, pdfBuffer,
      `Offer Letter - ${firstName} ${lastName}.pdf`
    );
    progress.stop();

    // HR review gate: the offer stops here as "Offer Ready". Signing is
    // queued by mondayWebhook only when HR flips the offer status to the
    // approval label ("Packaged Approved").
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.ready).catch(err => {
      logger.warn('generatePDF-offer-ready-update-failed', { itemId, error: err.message });
    });
    // The macro status must stop saying "Generating" once the letter exists —
    // the card is now waiting on a person, and the board should show that.
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.awaitingReview).catch(err => {
      logger.warn('generatePDF-awaiting-review-status-failed', { itemId, error: err.message });
    });

    // One event, one comment: the letter-ready checklist and the email subject
    // line ship together (the word-for-word email appears once, at step 6).
    let subjectLine = '';
    try {
      const mailer = require('../../lib/mailer');
      const tpl = await monday.getEmailTemplate('package').catch(() => null);
      const previewFill = {
        firstName, lastName, fullName: `${firstName} ${lastName}`,
        formLink: `${cfg.monday.formSync.formUrl}?name=${encodeURIComponent(`${firstName} ${lastName}`)}`,
        signLink: '(direct signing link — inserted automatically at send time)',
      };
      const pvSubject = mailer.renderTemplate((tpl && tpl.subject) || 'Welcome to MedWatchers, {{firstName}} — everything you need is right here! 🎉', previewFill);
      subjectLine = `\n\nEmail subject: ${pvSubject} — the word-for-word email appears at step 6 before anything goes out.`;
    } catch (err) {
      logger.warn('generatePDF-email-preview-failed', { itemId, error: err.message });
    }

    await monday.logAction(itemId,
      stepHeader(3, 'Letter built')
      + `The offer letter is ready. ${attached.attached ? 'It\'s attached to this card — open the 📄 Offer Letter column to read it.' : 'Open the PDF Document link to read it.'}\n\n`
      + `Check these five:\n`
      + `    Name — ${firstName} ${lastName}\n`
      + `    Role — ${adpJobTitle}, ${adpDepartment}\n`
      + `    Pay — ${payRate} ${payFrequency}\n`
      + `    Start — ${startDate}\n`
      + `    Supervisor — ${supervisor}`
      + subjectLine
      + `\n\nYour move\n`
      + `    ✓ all correct → select "${cfg.monday.offerLabels.approved}" — that builds the signing packet and shows you the exact email. Nothing sends yet.\n`
      + `    ✎ something off → fix the field; the letter rebuilds itself. Or "${cfg.monday.offerLabels.denied}" to stop.`,
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
    // Notify once (first attempt) with the FULL diagnosis
    const attempt = context?.bindingData?.dequeueCount;
    if (queueItem?.itemId && (!attempt || Number(attempt) <= 1)) {
      const httpCode = error.response ? error.response.status : null;
      const apiBody = require('../../lib/util').apiBodySnippet(error);
      const system = /Merge data missing/i.test(error.message) ? 'Monday (hire fields incomplete)'
        : /Asset Not Found|documentgeneration|asset/i.test(String(error.message) + (apiBody || '')) ? 'Adobe PDF Services (template/asset)'
        : /blob|storage/i.test(error.message) ? 'Azure storage'
        : httpCode ? 'Adobe PDF Services API' : 'Azure engine (generatePDF)';
      await monday.logAction(queueItem.itemId,
        stepHeader(3, 'Letter failed')
        + `❌ Offer letter generation failed.\n\n`
        + `SYSTEM: ${system}\n`
        + `ERROR: ${error.message}${httpCode ? ` (HTTP ${httpCode})` : ''}${apiBody ? ` — ${apiBody}` : ''}\n\n`
        + `FIX: address the cause above, then re-check ☑ Details Verified. (The system also retries automatically.)`
      ).catch(() => {});
    }

    throw error; // Let Azure retry based on maxDequeueCount
  }
}

// Export for Azure Functions (default) and tests (named)
module.exports = processGenerate;
module.exports.processGenerate = processGenerate;
module.exports.selectTemplate = selectTemplate;
