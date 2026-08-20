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
    // The macro status must stop saying "Generating" once the letter exists —
    // the card is now waiting on a person, and the board should show that.
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.awaitingReview).catch(err => {
      logger.warn('generatePDF-awaiting-review-status-failed', { itemId, error: err.message });
    });

    await monday.logAction(itemId,
      `📄 Offer letter generated for ${firstName} ${lastName} — YOUR MOVE. Open the PDF Document link and review:\n`
      + `  ☐ Name spelled correctly (${firstName} ${lastName})\n`
      + `  ☐ Position & department right (${adpJobTitle} / ${adpDepartment})\n`
      + `  ☐ Compensation & frequency right (${payRate} ${payFrequency})\n`
      + `  ☐ Start date right (${startDate})\n`
      + `  ☐ Supervisor right (${supervisor})\n\n`
      + `📍 Where it lives: this draft is in Azure storage (24h link) · the template came from the team-editable Template Catalog · once signed, the final lives in Adobe Sign AND archives to new-hires/${lastName}-${firstName}.\n\n`
      + `Looks good → select "${cfg.monday.offerLabels.approved}" — ONE click sends everything in one go: the signing packet (this letter + every Active packet document on the Template Catalog) goes to Adobe, and the candidate's package email goes out with the direct signing link inside.\n`
      + `Something off → fix the field, re-check "Generate Docs" to regenerate. Or "${cfg.monday.offerLabels.denied}" / "${cfg.monday.offerLabels.moreInfo}" to stop.`,
      `Adobe Document Generation merged template "${templateKey}" with the hire record; PDF stored in pdf-temp blob (24h link) and linked on this item.`
    ).catch(err => logger.warn('generatePDF-notify-failed', { itemId, error: err.message }));

    // Email-1 preview: show HR the EXACT welcome email that will go out on
    // ④ Approve, right next to the PDF checklist — approve = send, no surprises.
    try {
      const mailer = require('../../lib/mailer');
      const tpl = await monday.getEmailTemplate('package').catch(() => null);
      const previewFill = {
        firstName, lastName, fullName: `${firstName} ${lastName}`,
        formLink: `${cfg.monday.formSync.formUrl}?name=${encodeURIComponent(`${firstName} ${lastName}`)}`,
        signLink: '(direct signing link — inserted automatically at send time)',
      };
      const pvSubject = mailer.renderTemplate((tpl && tpl.subject) || 'Welcome to MedWatchers, {{firstName}} — everything you need is right here! 🎉', previewFill);
      const pvBody = mailer.renderTemplate((tpl && tpl.body)
        || `Hi {{firstName}},\n\n`
        + `Congratulations and welcome to the MedWatchers family! Everything you need to make it official is in this one email:\n\n`
        + `1️⃣ Sign your offer packet (offer letter + onboarding documents, one sitting, under 2 minutes):\n{{signLink}}\n\n`
        + `2️⃣ Fill out your quick info form (3 minutes — contact info, emergency contact, start availability):\n{{formLink}}\n\n`
        + `That's it! Once both are done we'll confirm by email and get your first day ready.\n\n`
        + `Questions anytime — just reply here. We can't wait!\n\n`
        + `Warmly,\nThe MedWatchers HR Team`, previewFill);
      await monday.logAction(itemId,
        `📧 EMAIL PREVIEW — this is exactly what ${firstName} will receive when you select "${cfg.monday.offerLabels.approved}":\n\n`
        + `— — — — — — — — — —\nSubject: ${pvSubject}\n\n${pvBody}\n— — — — — — — — — —\n\n`
        + `Want different wording? Edit the "package" row on the Email Templates board, then re-check ☑ Generate Docs to refresh this preview.`
      ).catch(() => {});
    } catch (err) {
      logger.warn('generatePDF-email-preview-failed', { itemId, error: err.message });
    }

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
      const apiBody = error.response && error.response.data ? JSON.stringify(error.response.data).slice(0, 300) : null;
      const system = /Merge data missing/i.test(error.message) ? 'Monday (hire fields incomplete)'
        : /Asset Not Found|documentgeneration|asset/i.test(String(error.message) + (apiBody || '')) ? 'Adobe PDF Services (template/asset)'
        : /blob|storage/i.test(error.message) ? 'Azure storage'
        : httpCode ? 'Adobe PDF Services API' : 'Azure engine (generatePDF)';
      await monday.logAction(queueItem.itemId,
        `❌ Offer letter generation failed.\n\n`
        + `SYSTEM: ${system}\n`
        + `EXACT ERROR: ${error.message}${httpCode ? `\nHTTP CODE: ${httpCode}` : ''}${apiBody ? `\nAPI RESPONSE: ${apiBody}` : ''}\n\n`
        + `FIX: address the cause above, then re-check ☑ Generate Docs. (The system also retries automatically.)`
      ).catch(() => {});
    }

    throw error; // Let Azure retry based on maxDequeueCount
  }
}

// Export for Azure Functions (default) and tests (named)
module.exports = processGenerate;
module.exports.processGenerate = processGenerate;
module.exports.selectTemplate = selectTemplate;
