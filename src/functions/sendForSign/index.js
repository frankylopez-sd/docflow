'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const monday = require('../../lib/monday');

/**
 * sendForSign: Queue-triggered function that routes PDF to Adobe Sign
 * Serial signing: HR → Manager → Employee (3 signers)
 * Creates agreement and notifies first signer
 */

module.exports = async function (context, queueItem) {
  const cfg = config.load();

  try {
    let { boardId, itemId, pdfUrl, firstName, lastName, workEmail, supervisor } = queueItem;

    // TWO HUMAN GATES: mode 'prep' (④ Approve Package) builds the Adobe packet
    // and posts the REAL email for HR to read — nothing leaves the building.
    // Mode 'send' (⑤ Send Package) is the actual send button. Legacy messages
    // with no mode only ever prep, so an old queue item can't surprise-send.
    const mode = queueItem.mode === 'send' ? 'send' : 'prep';

    logger.info('sendForSign-start', { itemId, mode });

    const existingAgreement = await monday.getColumnValueJson(boardId, itemId, cfg.monday.columns.agreementId)
      .then((v) => (typeof v === 'string' ? v : (v && (v.text || v.value))) || null)
      .catch(() => null);
    const rowNow = await monday.readRow(boardId, itemId).catch(() => null);
    const statusNow = rowNow && rowNow.columns && rowNow.columns[cfg.monday.columns.status];

    if (!firstName || !lastName || !workEmail) {
      const hire = await monday.fetchHireData(boardId, itemId);
      firstName = firstName || hire.firstName;
      lastName = lastName || hire.lastName;
      workEmail = workEmail || hire.workEmail;
      supervisor = supervisor || hire.supervisor;
      logger.info('sendForSign-hydrated-from-monday', { itemId });
    }

    // ── GATE 2 · ⑤ Send Package — the packet exists, email it to the candidate.
    if (mode === 'send') {
      if (!existingAgreement) {
        throw new Error(`sendForSign: no Adobe agreement on item ${itemId} — select "${cfg.monday.offerLabels.approved}" first to build the packet.`);
      }
      const delivered = await deliverPackage(cfg, {
        boardId, itemId, firstName, lastName, workEmail, agreementId: existingAgreement,
      });
      await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.outForSignature)
        .catch((err) => logger.warn('sendForSign-status-update-failed', { itemId, error: err.message }));
      await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.sent)
        .catch((err) => logger.warn('sendForSign-offer-sent-update-failed', { itemId, error: err.message }));
      logger.event('sendForSign-package-delivered', { itemId, agreementId: existingAgreement, emailed: Boolean(delivered.sentTo) });
      context.res = { status: 200, body: { itemId, agreementId: existingAgreement, delivered: true, emailed: Boolean(delivered.sentTo) } };
      return;
    }

    // ── GATE 1 · ④ Approve Package — build once; never mint a second agreement.
    if (existingAgreement && statusNow === cfg.monday.statusLabels.outForSignature) {
      logger.event('sendForSign-duplicate-skipped', { itemId, existingAgreement });
      context.res = { status: 200, body: { itemId, skipped: true, reason: 'already out for signature', agreementId: existingAgreement } };
      return;
    }
    if (existingAgreement) {
      // Re-approved before sending: refresh the draft against the same packet.
      await deliverPackage(cfg, {
        boardId, itemId, firstName, lastName, workEmail, agreementId: existingAgreement, draftOnly: true,
      });
      context.res = { status: 200, body: { itemId, agreementId: existingAgreement, reused: true } };
      return;
    }

    // HR-approval messages carry only {boardId, itemId} — Monday is the
    // database of record, so hydrate the PDF link and hire fields from it.
    if (!pdfUrl) {
      const link = await monday.getColumnValueJson(boardId, itemId, cfg.monday.columns.pdfUrl);
      pdfUrl = link && link.url;
      if (!pdfUrl) {
        throw new Error(`sendForSign: no PDF link on item ${itemId} (column ${cfg.monday.columns.pdfUrl}) — was the offer generated?`);
      }
    }

    // Stored SAS links expire after 24h and HR review is human-paced — a
    // Friday letter approved Monday would 403. Re-mint a fresh link from the
    // same blob at send time so approval age never matters.
    try {
      const blobLib = require('../../lib/blob');
      const path = new URL(pdfUrl).pathname.split('/').filter(Boolean); // [container, ...key]
      if (path.length >= 2) {
        pdfUrl = await blobLib.freshSasUrl(path[0], path.slice(1).join('/'));
        logger.info('sendForSign-sas-reminted', { itemId });
      }
    } catch (err) {
      logger.warn('sendForSign-sas-remint-failed-using-stored', { itemId, error: err.message });
    }
    // Signers by mode: 'candidate' sends straight to the new hire (Adobe
    // emails them the document, one signature completes it); 'serial3' runs
    // the HR -> Manager -> Employee chain.
    const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    const signers = cfg.adobe.signMode === 'serial3'
      ? [
          { email: 'hr@medwatchers.com', name: 'HR Representative', order: 0 },
          { email: isEmail(supervisor) ? supervisor : 'manager@medwatchers.com', name: 'Manager', order: 1 },
          { email: workEmail, name: `${firstName} ${lastName}`, order: 2 },
        ]
      : [
          { email: workEmail, name: `${firstName} ${lastName}`, order: 0 },
        ];

    // Signing packet: team-managed catalog rows (policies, consent forms)
    // ride in the same agreement behind the custom offer letter — one signing
    // session, one combined signed PDF back. Empty catalog = offer only.
    const packetDocs = await monday.getPacketFiles().catch(err => {
      logger.warn('sendForSign-packet-load-failed', { itemId, error: err.message });
      return [];
    });

    logger.info('sendForSign-creating-agreement', { itemId, signerCount: signers.length, packetDocs: packetDocs.length });

    // Create Adobe Sign agreement
    const agreementResult = await adobe.createSigningAgreement({
      documentUrl: pdfUrl,
      fileName: `offer-${firstName}-${lastName}.pdf`,
      signers: signers,
      message: `Please review and sign the ${packetDocs.length ? 'hire packet' : 'offer letter'} for ${firstName} ${lastName}`,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      extraDocuments: packetDocs,
    });

    const agreementId = agreementResult.id;
    logger.info('sendForSign-agreement-created', { itemId, agreementId });

    // Make sure Adobe pings us on completion (idempotent — 409 means it exists)
    await adobe.ensureWebhook().catch(err => {
      logger.warn('sendForSign-webhook-ensure-failed', { error: err.message, note: 'signPoller remains the fallback' });
    });

    // Store agreement ID in Monday
    await monday.updateItemColumn(boardId, itemId, cfg.monday.columns.agreementId, agreementId).catch(err => {
      logger.warn('sendForSign-agreement-id-update-failed', { itemId, error: err.message });
    });

    // Store signer details
    const signerDetails = signers.map((s, idx) => `${idx + 1}. ${s.name} (${s.email})`).join('\n');
    await monday.updateItemColumn(boardId, itemId, cfg.monday.columns.signerDetails, { text: signerDetails }).catch(err => {
      logger.warn('sendForSign-signers-update-failed', { itemId, error: err.message });
    });

    const packetLine = packetDocs.length
      ? `\n\n📑 In the packet (signed together, one session): 1. Offer Letter (custom for ${firstName})${packetDocs.map((d, i) => ` · ${i + 2}. ${d.name.replace(/\.pdf$/i, '')}`).join('')}.`
      : '';
    await monday.logAction(itemId,
      `📦 Packet built and ready — nothing has been sent yet. Signing order: ${signers.map(s => s.name).join(' → ')}.${packetLine}\n\n`
      + `YOUR MOVE: read the exact email in the next comment. Looks right → select "${cfg.monday.offerLabels.sendPackage}" and it goes out to ${firstName} immediately. Something off → "${cfg.monday.offerLabels.moreInfo}", fix the fields, and the letter rebuilds itself.`,
      `Adobe Sign agreement ${agreementId} created with ${signers.length} signer(s) and ${1 + packetDocs.length} document(s); no candidate email sent (awaiting the ⑤ Send Package gate).`
    ).catch(err => logger.warn('sendForSign-notify-failed', { itemId, error: err.message }));

    // Post the REAL email (with the real signing link) as a draft only — the
    // ⑤ Send Package gate is what actually delivers it.
    await deliverPackage(cfg, {
      boardId, itemId, firstName, lastName, workEmail, agreementId, draftOnly: true,
    });

    logger.info('sendForSign-complete', { itemId, agreementId, mode });

    context.res = {
      status: 200,
      body: { itemId, agreementId, signers: signers.length, status: 'Packet built — awaiting the Send Package gate' }
    };

  } catch (error) {
    logger.error('sendForSign-error', { error: error.message, itemId: queueItem?.itemId });

    // Update Monday: status → sign failed
    const failCfg = config.load();
    await monday.updateItemStatus(queueItem?.boardId, queueItem?.itemId, failCfg.monday.statusLabels.signFailed).catch(() => {});
    await monday.updateOfferStatus(queueItem?.boardId, queueItem?.itemId, failCfg.monday.offerLabels.failed).catch(() => {});
    // Notify once (first attempt) with the FULL diagnosis — system, exact
    // error, response code, and the precise fix. No guessing allowed.
    const attempt = context?.bindingData?.dequeueCount;
    if (queueItem?.itemId && (!attempt || Number(attempt) <= 1)) {
      const httpCode = error.response ? error.response.status : null;
      const apiBody = error.response && error.response.data ? JSON.stringify(error.response.data).slice(0, 300) : null;
      const system = /no PDF link/i.test(error.message) ? 'Monday (missing data on the card)'
        : /auth not configured|refresh|token|401/i.test(String(error.message) + httpCode) ? 'Adobe Sign (authentication)'
        : httpCode ? 'Adobe Sign API' : 'Azure engine (sendForSign)';
      const fix = /no PDF link/i.test(error.message)
        ? `Generate the letter first: fill the hire fields → check ☑ Generate Docs → review → then "${failCfg.monday.offerLabels.approved}".`
        : `Fix the cause below, then re-select "${failCfg.monday.offerLabels.approved}" to re-send.`;
      await monday.logAction(queueItem.itemId,
        `❌ Sending for signature failed.\n\n`
        + `SYSTEM: ${system}\n`
        + `EXACT ERROR: ${error.message}${httpCode ? `\nHTTP CODE: ${httpCode}` : ''}${apiBody ? `\nAPI RESPONSE: ${apiBody}` : ''}\n\n`
        + `FIX: ${fix}\n\n(The system also retries automatically.)`
      ).catch(() => {});
    }

    throw error;
  }
};

/**
 * Compose EMAIL 1 (welcome + signing link + info form) and either send it or
 * post it as a draft for HR. Used by both gates: ④ Approve Package always
 * drafts (draftOnly), ⑤ Send Package actually sends when Graph mail is armed.
 * @returns {Promise<{sentTo:string|null, signLink:string|null}>}
 */
async function deliverPackage(cfg, opts) {
  const { boardId, itemId, firstName, lastName, workEmail, agreementId, draftOnly } = opts;
  const mailer = require('../../lib/mailer');
  const cardLink = `https://medwatchers.monday.com/boards/${boardId}/pulses/${itemId}`;

  // Adobe's own emails are suppressed — OUR link is the only door, so poll
  // harder for it and shout on the card if it can't be fetched.
  const signLink = await adobe.getSigningUrl(agreementId, { attempts: 10, delayMs: 2000 }).catch(() => null);
  if (!signLink) {
    await monday.logAction(itemId,
      `⚠️ Heads-up: Adobe hasn't issued the direct signing link yet, and Adobe's own emails are turned off — so the candidate would have NO way in. Wait a minute and re-select "${cfg.monday.offerLabels.approved}" to retry, or grab the signing URL from Adobe Sign (agreement ${agreementId}) and send it by hand.`
    ).catch(() => {});
  }

  const tpl = await monday.getEmailTemplate('package').catch(() => null);
  const formLink = `${cfg.monday.formSync.formUrl}?name=${encodeURIComponent(`${firstName} ${lastName}`)}`;
  const fill = {
    firstName, lastName, fullName: `${firstName} ${lastName}`, formLink,
    signLink: signLink || '(signing link pending — HR will follow up shortly)',
  };
  const subject = mailer.renderTemplate((tpl && tpl.subject) || 'Welcome to MedWatchers, {{firstName}} — everything you need is right here! 🎉', fill);
  const body = mailer.renderTemplate((tpl && tpl.body)
    || `Hi {{firstName}},\n\n`
    + `Congratulations and welcome to the MedWatchers family! Everything you need to make it official is in this one email:\n\n`
    + `1️⃣ Sign your offer packet (offer letter + onboarding documents, one sitting, under 2 minutes):\n{{signLink}}\n\n`
    + `2️⃣ Fill out your quick info form (3 minutes — contact info, emergency contact, start availability):\n{{formLink}}\n\n`
    + `That's it! Once both are done we'll confirm by email and get your first day ready.\n\n`
    + `Questions anytime — just reply here. We can't wait!\n\n`
    + `Warmly,\nThe MedWatchers HR Team`, fill);

  let sentTo = null;
  if (!draftOnly && mailer.isConfigured()) {
    const personal = await monday.getColumnValueJson(boardId, itemId, cfg.monday.formSync.targetColumns.personalEmail).catch(() => null);
    const to = (personal && (personal.email || personal.text)) || workEmail;
    if (to && /@/.test(String(to))) {
      try {
        const result = await mailer.sendMail({ to, subject, body });
        if (result.sent) sentTo = to;
      } catch (err) {
        logger.warn('sendForSign-package-email-failed', { itemId, error: err.message });
      }
    }
  }

  const block = `— — — — — — — — — —\nSubject: ${subject}\n\n${body}\n— — — — — — — — — —`;
  const reference = `\n\n🔗 For HR reference (do not forward): offer PDF (PDF Document column) · agreement ${agreementId} · this card: ${cardLink}`;
  const headline = sentTo
    ? `📤 Sent! ${firstName}'s welcome package went to ${sentTo} just now. Copy for the record:\n\n`
    : draftOnly
      ? `📧 THE EXACT EMAIL — this is what ${firstName} receives the moment you select "${cfg.monday.offerLabels.sendPackage}". Nothing has been sent yet:\n\n`
      : `📦 Ready to send to ${firstName} — auto-send is off, so copy this into Outlook and send it yourself:\n\n`;
  await monday.logAction(itemId, `${headline}${block}${reference}`)
    .catch((err) => logger.warn('sendForSign-package-notify-failed', { itemId, error: err.message }));

  return { sentTo, signLink };
}

module.exports.deliverPackage = deliverPackage;
