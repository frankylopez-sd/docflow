'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const blob = require('../../lib/blob');
const monday = require('../../lib/monday');
const { findItemByAgreementId } = require('../uploadToSharePoint');
const { stepHeader, friendlyFieldName } = require('../../lib/util');

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

    // Idempotency: Adobe webhooks redeliver and storage queues are
    // at-least-once. If this hire is already complete, the archive ran —
    // exit successfully without duplicating blobs, updates, or BG checks.
    // Dedupe must be agreement-SPECIFIC: keying on the generic completion
    // comment wedged cards forever when a second agreement got signed (the
    // 2026-08-20 "signed but Monday won't update" incident).
    const alreadyDone = await monday.hasUpdateContaining(itemId, `archived (agreement ${agreementId}`).catch(() => false);
    if (alreadyDone) {
      logger.event('archiveToBlob-already-complete', { itemId, agreementId });
      context.res = { status: 200, body: { itemId, status: 'already complete (idempotent replay)' } };
      return;
    }

    // Concurrency claim: two executions racing in the same second both pass
    // the comment check above (neither comment exists yet). Atomic
    // create-if-not-exists blob is the tie-breaker — exactly one run wins.
    const claimKey = `locks/agreement-${agreementId}.lock`;
    const claimed = await blob.claimOnce('pdf-archive', claimKey).catch(() => true);
    if (!claimed) {
      logger.event('archiveToBlob-claim-lost', { itemId, agreementId });
      context.res = { status: 200, body: { itemId, status: 'another run already claimed this agreement' } };
      return;
    }
    // On any failure below, release the claim so the queue retry can run.
    context._archiveClaim = { container: 'pdf-archive', key: claimKey };

    // Additional guard: check if status is ALREADY done/complete before re-running
    const currentStatus = await monday.readRow(boardId, itemId).then(r =>
      r.columns[cfg.monday.columns.status] || r.byTitle['Onboarding Status']
    ).catch(() => null);
    if (currentStatus && /done|complete|signed|archived/i.test(String(currentStatus))) {
      logger.event('archiveToBlob-status-already-complete', { itemId, agreementId, currentStatus });
      context.res = { status: 200, body: { itemId, status: 'status already final (skipping duplicate)' } };
      return;
    }

    // Update Monday: status → ⑥ Archiving
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.archiving).catch(err => {
      logger.warn('archiveToBlob-status-update-failed', { itemId, error: err.message });
    });

    // Download signed PDF from Adobe
    logger.info('archiveToBlob-downloading-signed', { agreementId });
    const signedPdfBuffer = await adobe.downloadSignedDocument(agreementId);

    if (!signedPdfBuffer || signedPdfBuffer.length === 0) {
      throw new Error('Adobe returned empty signed PDF');
    }

    logger.info('archiveToBlob-downloaded', { agreementId, size: signedPdfBuffer.length });

    // Upload to archive blob (permanent storage, non-SAS URL for Monday).
    // Organized like a filing cabinet: new-hires/Lastname-Firstname/…
    const nameParts = String(employeeName || 'employee').replace(/-/g, ' ').trim().split(/\s+/);
    const folder = nameParts.length > 1
      ? `${nameParts[nameParts.length - 1]}-${nameParts.slice(0, -1).join('-')}`
      : nameParts[0];
    const dateStamp = new Date().toISOString().slice(0, 10);
    const archiveFileName = `new-hires/${folder}/signed-offer-${dateStamp}-${itemId}.pdf`;
    const upload = await blob.uploadPDF('pdf-archive', archiveFileName, signedPdfBuffer);
    const archiveUrl = upload.url;

    logger.info('archiveToBlob-archived', { itemId, url: archiveUrl });

    // Update Monday with signed PDF link
    await monday.updateItemColumn(boardId, itemId, cfg.monday.columns.signedPdfUrl, { url: archiveUrl, text: 'Signed PDF' }).catch(err => {
      logger.warn('archiveToBlob-link-update-failed', { itemId, error: err.message });
    });

    // Attach the signed packet itself — the archive blob is private, so this
    // is the copy HR can actually open and preview from the card.
    await monday.attachFile(
      itemId, cfg.monday.columns.signedFile, signedPdfBuffer,
      `Signed Packet - ${String(employeeName || 'hire').replace(/-/g, ' ')}.pdf`
    );

    // Final status: ⑦ Onboarding Complete + offer column ⑥ Signed & Archived
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.complete).catch(err => {
      logger.warn('archiveToBlob-final-status-update-failed', { itemId, error: err.message });
    });
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.signed).catch(err => {
      logger.warn('archiveToBlob-offer-signed-update-failed', { itemId, error: err.message });
    });

    // SharePoint mirror: hand the signed PDF to the HR-locked site. Silent
    // no-op until SHAREPOINT_ENABLED=true; the consumer posts the link back.
    if (cfg.sharepoint && cfg.sharepoint.enabled) {
      try {
        if (context.bindings) {
          context.bindings.sharepointQueue = JSON.stringify({
            agreementId, itemId: String(itemId), boardId: String(boardId), employeeName,
          });
        }
        logger.event('archiveToBlob-sharepoint-queued', { itemId, agreementId });
      } catch (err) {
        logger.warn('archiveToBlob-sharepoint-queue-failed', { itemId, error: err.message });
      }
    }

    // Downstream kickoff: open the background check and link it to the hire
    await monday.createBackgroundCheck(boardId, itemId, employeeName ? employeeName.replace(/-/g, ' ') : null).catch(err => {
      logger.warn('archiveToBlob-bg-check-create-failed', { itemId, error: err.message });
    });

    // ADP handoff readiness — tell the team exactly what (if anything) is missing
    let adpLine = '';
    try {
      const readiness = await monday.adpReadiness(boardId, itemId);
      adpLine = readiness.complete
        ? `\n\n✅ ADP handoff: all ${readiness.total} required fields are filled — ready for user creation.`
        : `\n\n✋ ADP handoff: ${readiness.filled}/${readiness.total} required fields filled. Missing: ${readiness.missing.map(friendlyFieldName).join(', ')}.`;
    } catch (err) {
      logger.warn('archiveToBlob-adp-readiness-failed', { itemId, error: err.message });
    }

    await monday.logAction(itemId,
      stepHeader(9, '✅ SIGNED & FILED')
      + `WHAT HAPPENED: Signed and filed. The packet is attached to this card, archived (agreement ${agreementId}), and the background check is open.${adpLine}\n\n`
      + `NEXT: nothing — automatic. The manual next-steps checklist posts here next.`,
      `Signed PDF (agreement ${agreementId}) downloaded from Adobe Sign, archived to the pdf-archive container, links + relations written back.`
    ).catch(err => logger.warn('archiveToBlob-notify-failed', { itemId, error: err.message }));

    // Post manual-steps checklist on Done status
    await monday.logAction(itemId,
      stepHeader(10, '🎉 DONE')
      + `WHAT HAPPENED: the automated flow is finished — everything from here is a person's move.\n\n`
      + `📋 NEXT STEPS (manual):\n`
      + `    1. Background check — order from vendor (Checkr/Sterling)\n`
      + `    2. ADP profile — create user account in ADP\n`
      + `    3. IT provisioning — email credentials, create Slack account, set up device\n`
      + `    4. TalentLMS enrollment — add to training courses\n`
      + `    5. Active Employees — add hire to the roster\n\n`
      + `This card is "${cfg.monday.statusLabels.complete}". Check the Signed PDF and agreement links above, then forward to your team.`
    ).catch(err => logger.warn('archiveToBlob-next-steps-failed', { itemId, error: err.message }));

    // Congrats email: the candidate's own copy of the fully-signed letter,
    // attached — their whole record in one place. Only fires when Graph mail
    // is armed; an attachment here is safe (executed copy, nothing revocable).
    try {
      const mailer = require('../../lib/mailer');
      if (mailer.isConfigured()) {
        const row = await monday.readRow(boardId, itemId).catch(() => null);
        const rawTo = row && (row.columns[cfg.monday.formSync.targetColumns.personalEmail]
          || row.columns[cfg.monday.columns.workEmail]);
        const to = typeof rawTo === 'string' ? rawTo : (rawTo && (rawTo.email || rawTo.text)) || null;
        if (to && /@/.test(to)) {
          const cleanName = String(employeeName || '').replace(/-/g, ' ').trim();
          const first = cleanName.split(/\s+/)[0] || 'there';
          const tpl = await monday.getEmailTemplate('congrats').catch(() => null);
          const fill = { firstName: first, fullName: cleanName };
          // EMAIL 2 of 2: thank-you / received confirmation + the signed copy.
          const subject = mailer.renderTemplate((tpl && tpl.subject) || `✅ Received! Your signed paperwork is in, {{firstName}}`, fill);
          const bodyText = mailer.renderTemplate((tpl && tpl.body)
            || `Hi {{firstName}},\n\nThank you — we received everything! Your fully signed paperwork is attached to this email for your records. Keep it somewhere safe.\n\nWhere things stand:\n  ✔ Offer packet — signed and archived\n  • Background check — being ordered (nothing for you to do until you hear from the screening service)\n  • First-day details — coming from your manager soon\n\nWe're thrilled to have you on the team. See you soon!\n\nWarmly,\nThe MedWatchers HR Team`, fill);
          const result = await mailer.sendMail({
            to, subject, body: bodyText,
            attachments: [{ name: `MedWatchers-signed-offer-${dateStamp}.pdf`, content: signedPdfBuffer }],
          });
          if (result.sent) {
            await monday.logAction(itemId,
              stepHeader(9, '🎉 CONFIRMATION SENT')
              + `WHAT HAPPENED: Confirmation sent to ${to} with their signed copy attached.\n\n`
              + `NEXT: nothing — automatic. The candidate now has their own copy for their records.`
            ).catch(() => {});
          }
        }
      }
    } catch (err) {
      logger.warn('archiveToBlob-congrats-email-failed', { itemId, error: err.message });
    }

    logger.info('archiveToBlob-complete', { itemId, archiveUrl });

    context.res = {
      status: 200,
      body: { itemId, archiveUrl, status: 'Signed document archived and onboarding complete' }
    };

  } catch (error) {
    logger.error('archiveToBlob-error', { error: error.message, itemId });

    // Give the claim back so the automatic retry isn't locked out.
    if (context._archiveClaim) {
      await blob.releaseClaim(context._archiveClaim.container, context._archiveClaim.key).catch(() => {});
    }

    // Update Monday: status → "Archive Error" (only when we know which item)
    if (itemId) {
      await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.archiveFailed).catch(() => {});
    }

    throw error;
  }
}

module.exports = processArchive;
module.exports.processArchive = processArchive;
