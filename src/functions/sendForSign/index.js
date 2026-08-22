'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const monday = require('../../lib/monday');
const { startProgress, stepHeader } = require('../../lib/util');

/**
 * sendForSign: Queue-triggered function that routes PDF to Adobe Sign
 * Serial signing: HR → Manager → Employee (3 signers)
 * Creates agreement and notifies first signer
 */

module.exports = async function (context, queueItem) {
  const cfg = config.load();

  // Tracked so the catch can always stop them. A progress timer is created
  // with setInterval().unref(), so it does NOT die with the invocation — if an
  // op throws between "start" and its finally, the timer leaks and posts
  // "⏳ Ns …" forever (2026-08-20 runaway progress). Stopping in the catch too
  // guarantees cleanup on every path.
  let progress = null;
  let sendProgress = null;

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
      // Idempotency: the docflow-sign queue is at-least-once, and a hung
      // invocation gets its message redelivered after the visibility timeout.
      // Without this guard the candidate is emailed a SECOND welcome packet
      // with a SECOND signing link (2026-08-20 duplicate-send incident). If we
      // already advanced past the send, this is a replay — exit cleanly.
      const offerNow = rowNow && rowNow.columns && rowNow.columns[cfg.monday.columns.offerStatus];
      if (offerNow === cfg.monday.offerLabels.sent || statusNow === cfg.monday.statusLabels.outForSignature) {
        logger.event('sendForSign-send-duplicate-skipped', { itemId, existingAgreement, offerNow, statusNow });
        context.res = { status: 200, body: { itemId, skipped: true, reason: 'already sent (idempotent replay)', agreementId: existingAgreement } };
        return;
      }
      await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.sendingEmail).catch(() => {});
      sendProgress = startProgress((t) => monday.logAction(itemId, t), { phase: 'fetching the signing link from Adobe, then emailing the candidate' });
      let delivered;
      try {
        delivered = await deliverPackage(cfg, {
          boardId, itemId, firstName, lastName, workEmail, agreementId: existingAgreement,
        });
      } finally {
        sendProgress.stop();
      }
      await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.outForSignature)
        .catch((err) => logger.warn('sendForSign-status-update-failed', { itemId, error: err.message }));
      await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.sent)
        .catch((err) => logger.warn('sendForSign-offer-sent-update-failed', { itemId, error: err.message }));
      logger.event('sendForSign-package-delivered', { itemId, agreementId: existingAgreement, emailed: Boolean(delivered.sentTo) });
      context.res = { status: 200, body: { itemId, agreementId: existingAgreement, delivered: true, emailed: Boolean(delivered.sentTo) } };
      return;
    }

    // ── GATE 1 · ④ Package Approved — build once; never mint a second
    // agreement. A silent skip looks identical to a broken system, so always
    // say why nothing happened (2026-08-20: "I hit approve and nothing").
    if (existingAgreement && statusNow === cfg.monday.statusLabels.outForSignature) {
      logger.event('sendForSign-duplicate-skipped', { itemId, existingAgreement });
      await monday.logAction(itemId,
        stepHeader(8, '📤 SIGNING')
        + `ℹ️ Nothing to rebuild — approving again does nothing (that's on purpose).\n\n`
        + `WHY: status is "${cfg.monday.statusLabels.outForSignature}" and this packet was already built AND sent — agreement on file: ${existingAgreement}. Building again would put a SECOND signing packet in the candidate's inbox.\n\n`
        + `YOUR NEXT MOVE: need to send a corrected packet? Select "${cfg.monday.offerLabels.moreInfo}" first, fix the fields (the letter rebuilds itself), then approve again.`
      ).catch(() => {});
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
    // The board must show the machine working, not sit on the human's label.
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.creatingPackage).catch((err) => {
      logger.warn('sendForSign-creating-status-failed', { itemId, error: err.message });
    });
    progress = startProgress((t) => monday.logAction(itemId, t), { phase: 'reading the hire record and re-minting the document link' });

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
    progress.setPhase('collecting the packet documents from the Template Catalog');
    const packetDocs = await monday.getPacketFiles().catch(err => {
      logger.warn('sendForSign-packet-load-failed', { itemId, error: err.message });
      return [];
    });

    progress.setPhase(`uploading ${1 + packetDocs.length} document(s) to Adobe and building the agreement`);
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

    // Direct Adobe Sign link for HR (audit trail / resend / cancel). Requires
    // an Adobe login — this is the internal door, not the candidate's link.
    if (cfg.monday.columns.agreementLink) {
      const manageUrl = `${cfg.adobe.signApiUrl.replace('api.', 'secure.')}/public/agreements/#/agreement/${agreementId}`;
      await monday.updateItemColumn(boardId, itemId, cfg.monday.columns.agreementLink, {
        url: manageUrl, text: 'Open in Adobe Sign',
      }).catch((err) => logger.warn('sendForSign-agreement-link-failed', { itemId, error: err.message }));
    }

    // Store signer details
    const signerDetails = signers.map((s, idx) => `${idx + 1}. ${s.name} (${s.email})`).join('\n');
    await monday.updateItemColumn(boardId, itemId, cfg.monday.columns.signerDetails, { text: signerDetails }).catch(err => {
      logger.warn('sendForSign-signers-update-failed', { itemId, error: err.message });
    });

    const packetLine = packetDocs.length
      ? `\n\nIn the packet (signed together, one session): 1. Offer Letter (custom for ${firstName})${packetDocs.map((d, i) => ` · ${i + 2}. ${d.name.replace(/\.pdf$/i, '')}`).join('')}.`
      : '';
    await monday.logAction(itemId,
      stepHeader(5, '📦 PACKET BUILT')
      + `WHAT HAPPENED: The packet is built. Signing order: ${signers.map(s => s.name).join(' → ')}.${packetLine}\n\n`
      + `YOUR NEXT MOVE: read the email below. Looks right → select "${cfg.monday.offerLabels.sendPackage}" and it goes to ${firstName}.\n`
      + `Something off → "${cfg.monday.offerLabels.moreInfo}"; fix the field and the letter rebuilds itself.`,
      `Adobe Sign agreement ${agreementId} created with ${signers.length} signer(s) and ${1 + packetDocs.length} document(s); no candidate email sent (awaiting the ⑤ Send Package gate).`
    ).catch(err => logger.warn('sendForSign-notify-failed', { itemId, error: err.message }));

    // Post the REAL email (with the real signing link) as a draft only — the
    // Send Package gate is what actually delivers it.
    progress.setPhase('asking Adobe for the candidate\'s direct signing link');
    try {
      await deliverPackage(cfg, {
        boardId, itemId, firstName, lastName, workEmail, agreementId, draftOnly: true,
      });
    } finally {
      progress.stop();
    }

    // Packet is built and the email is on the card: hand the board back to the
    // human with a label that says exactly that.
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.readyToSend).catch((err) => {
      logger.warn('sendForSign-ready-to-send-status-failed', { itemId, error: err.message });
    });

    logger.info('sendForSign-complete', { itemId, agreementId, mode });

    context.res = {
      status: 200,
      body: { itemId, agreementId, signers: signers.length, status: 'Packet built — awaiting the Send Package gate' }
    };

  } catch (error) {
    // Stop any progress timer first — it is unref'd and survives the throw,
    // so without this it posts "⏳ Ns …" forever after a failure.
    if (progress) { try { progress.stop(); } catch (e) { /* noop */ } }
    if (sendProgress) { try { sendProgress.stop(); } catch (e) { /* noop */ } }

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
      const apiBody = require('../../lib/util').apiBodySnippet(error);
      const system = /no PDF link/i.test(error.message) ? 'Monday (missing data on the card)'
        : /auth not configured|refresh|token|401/i.test(String(error.message) + httpCode) ? 'Adobe Sign (authentication)'
        : httpCode ? 'Adobe Sign API' : 'Azure engine (sendForSign)';
      const fix = /no PDF link/i.test(error.message)
        ? `Generate the letter first: fill the hire fields → check ☑ Details Verified → review → then "${failCfg.monday.offerLabels.approved}".`
        : `Fix the cause below, then re-select "${failCfg.monday.offerLabels.approved}" to re-send.`;
      await monday.logAction(queueItem.itemId,
        (queueItem?.mode === 'send' ? stepHeader(7, '❌ SEND FAILED') : stepHeader(5, '❌ PACKET FAILED'))
        + `❌ Sending for signature failed.\n\n`
        + `SYSTEM: ${system}\n`
        + `ERROR: ${error.message}${httpCode ? ` (HTTP ${httpCode})` : ''}${apiBody ? ` — API body: ${apiBody}` : ''}\n\n`
        + `FIX: ${fix} (The system also retries automatically.)`
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
      stepHeader(5, '📦 PACKET BUILT')
      + `⚠️ Adobe hasn't issued the candidate's direct signing link yet.\n\n`
      + `WHY: Adobe's own emails are turned off — our link is the only door, so without it the candidate has NO way in.\n\n`
      + `YOUR NEXT MOVE: wait a minute and re-select "${cfg.monday.offerLabels.approved}" to retry, or grab the signing URL from Adobe Sign (agreement ${agreementId}) and send it by hand.`
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
    + `Congratulations! Welcome to MedWatchers. Here's what's next:\n\n`
    + `1. Sign your offer packet ({{signLink}}) — under 2 minutes\n`
    + `2. Fill out your info form ({{formLink}}) — 3 minutes\n\n`
    + `Once both are done, we'll send your day-one details.\n\n`
    + `Questions? Reply here anytime.\n\n`
    + `The MedWatchers HR Team`, fill);

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
  const reference = `\n\nFor HR reference (do not forward): offer PDF (PDF Document column) · agreement ${agreementId} · this card: ${cardLink}`;
  // The full email body appears EXACTLY ONCE in the thread — the STEP 6
  // preview below. The STEP 7 confirmation refers back to it instead of
  // repeating it (see docs/VOICE_GUIDE.md, "the email appears once").
  const comment = sentTo
    ? stepHeader(7, '📤 SENT')
      + `WHAT HAPPENED: Sent! ${firstName}'s welcome package went to ${sentTo} just now.\n\n`
      + `The email you previewed at STEP 6 was sent verbatim.\nRecipient: ${sentTo}${reference}\n\n`
      + `NEXT: nothing — automatic. ${firstName} signs from that email, and the machine posts here the moment the signed packet lands.`
    : draftOnly
      ? stepHeader(6, '📧 READY TO SEND')
        + `WHAT HAPPENED: this is the exact email ${firstName} will receive the moment you select "${cfg.monday.offerLabels.sendPackage}". Preview only — not sent:\n\n`
        + `${block}${reference}\n\n`
        + `YOUR NEXT MOVE: looks right → select "${cfg.monday.offerLabels.sendPackage}" and it goes to ${firstName}. To change the wording, edit the "package" row on the Email Templates board.\n\n`
        + `WHY THIS MATTERS: this is the last check before anything reaches the candidate — what you read here is word-for-word what goes out.`
      : stepHeader(7, '📤 SEND BY HAND')
        + `WHAT HAPPENED: the packet is ready for ${firstName}, but auto-send is off — nothing has gone out.\n\n`
        + `YOUR NEXT MOVE: copy the exact email previewed at STEP 6 into Outlook and send it to ${firstName} (${workEmail}) yourself — the machine takes over once they sign.${reference}`;
  await monday.logAction(itemId, comment)
    .catch((err) => logger.warn('sendForSign-package-notify-failed', { itemId, error: err.message }));

  return { sentTo, signLink };
}

module.exports.deliverPackage = deliverPackage;
