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

    logger.info('sendForSign-start', { itemId });

    // Duplicate-send guard: queue redelivery / double-approval minted two live
    // agreements one second apart (2026-08-20). If this card is already out
    // for signature with an agreement on file, do NOT mint another.
    const existingAgreement = await monday.getColumnValueJson(boardId, itemId, cfg.monday.columns.agreementId)
      .then((v) => (typeof v === 'string' ? v : (v && (v.text || v.value))) || null)
      .catch(() => null);
    const rowNow = await monday.readRow(boardId, itemId).catch(() => null);
    const statusNow = rowNow && rowNow.columns && rowNow.columns[cfg.monday.columns.status];
    if (existingAgreement && statusNow === cfg.monday.statusLabels.outForSignature) {
      logger.event('sendForSign-duplicate-skipped', { itemId, existingAgreement });
      context.res = { status: 200, body: { itemId, skipped: true, reason: 'already out for signature', agreementId: existingAgreement } };
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
    if (!firstName || !lastName || !workEmail) {
      const hire = await monday.fetchHireData(boardId, itemId);
      firstName = firstName || hire.firstName;
      lastName = lastName || hire.lastName;
      workEmail = workEmail || hire.workEmail;
      supervisor = supervisor || hire.supervisor;
      logger.info('sendForSign-hydrated-from-monday', { itemId });
    }

    // Update Monday: status → ⑤ Out for Signature
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.outForSignature).catch(err => {
      logger.warn('sendForSign-status-update-failed', { itemId, error: err.message });
    });

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

    // Offer lifecycle: mark as sent
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.sent).catch(err => {
      logger.warn('sendForSign-offer-sent-update-failed', { itemId, error: err.message });
    });

    const packetLine = packetDocs.length
      ? `\n\n📑 In the packet (signed together, one session): 1. Offer Letter (custom for ${firstName})${packetDocs.map((d, i) => ` · ${i + 2}. ${d.name.replace(/\.pdf$/i, '')}`).join('')}.`
      : '';
    await monday.logAction(itemId,
      `✉️ ${packetDocs.length ? 'Hire packet' : 'Offer'} is out for signature. Signing order: ${signers.map(s => s.name).join(' → ')}. `
      + `Nothing to do — this item updates automatically as each person signs.${packetLine}`,
      `Adobe Sign agreement ${agreementId} created with ${signers.length} serial signers and ${1 + packetDocs.length} document(s); completion webhook + 30-min poller are watching it.`
    ).catch(err => logger.warn('sendForSign-notify-failed', { itemId, error: err.message }));

    // The candidate package: one email with everything the candidate needs —
    // including their DIRECT Adobe signing link, so our email is the single
    // front door (no hunting for the separate Adobe notification). Wording is
    // team-editable on the Email Templates board; when Graph mail is armed it
    // sends automatically, otherwise HR gets a ready-to-send draft.
    const mailer = require('../../lib/mailer');
    const cardLink = `https://medwatchers.monday.com/boards/${boardId}/pulses/${itemId}`;
    const signLink = await adobe.getSigningUrl(agreementId).catch(() => null);
    const tpl = await monday.getEmailTemplate('package').catch(() => null);
    const fill = {
      firstName, lastName, fullName: `${firstName} ${lastName}`,
      signLink: signLink || 'watch for the email from Adobe Sign — it arrives within a minute',
    };
    const pkgSubject = mailer.renderTemplate((tpl && tpl.subject) || 'Your MedWatchers offer is on its way, {{firstName}}! ✍️', fill);
    const pkgBody = mailer.renderTemplate((tpl && tpl.body)
      || `Hi {{firstName}},\n\n`
      + `Great news — your official offer letter is ready for you!\n\n`
      + `👉 Review and sign it here: {{signLink}}\n\n`
      + `What happens next:\n`
      + `  1. Sign right on your phone or computer (takes under a minute).\n`
      + `  2. A background check consent request will follow — nothing to do until it arrives.\n`
      + `  3. Once everything's signed, we'll email you a copy of everything plus your first-day details.\n\n`
      + `Questions anytime — just reply here. We can't wait!\n\n`
      + `Warmly,\nThe MedWatchers HR Team`, fill);

    let pkgSentTo = null;
    if (mailer.isConfigured()) {
      const personal = await monday.getColumnValueJson(boardId, itemId, cfg.monday.formSync.targetColumns.personalEmail).catch(() => null);
      const to = (personal && (personal.email || personal.text)) || workEmail;
      if (to && /@/.test(String(to))) {
        try {
          const result = await mailer.sendMail({ to, subject: pkgSubject, body: pkgBody });
          if (result.sent) pkgSentTo = to;
        } catch (err) {
          logger.warn('sendForSign-package-email-failed', { itemId, error: err.message });
        }
      }
    }

    const pkgBlock = `— — — — — — — — — —\nSubject: ${pkgSubject}\n\n${pkgBody}\n— — — — — — — — — —`;
    await monday.logAction(itemId, pkgSentTo
      ? `📦 Candidate package emailed automatically to ${pkgSentTo}. Copy for the record:\n\n`
        + `${pkgBlock}\n\n`
        + `🔗 For HR reference (do not forward): offer PDF ${pdfUrl ? '(PDF Document column)' : ''} · agreement ${agreementId} · this card: ${cardLink}`
      : `📦 Candidate package — ready to send to ${firstName}:\n\n`
        + `${pkgBlock}\n\n`
        + `🔗 For HR reference (do not forward): offer PDF ${pdfUrl ? '(PDF Document column)' : ''} · agreement ${agreementId} · this card: ${cardLink}`
    ).catch(err => logger.warn('sendForSign-package-notify-failed', { itemId, error: err.message }));

    logger.info('sendForSign-complete', { itemId, agreementId });

    context.res = {
      status: 200,
      body: { itemId, agreementId, signers: signers.length, status: 'Agreement created and sent to signers' }
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
