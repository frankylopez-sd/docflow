'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const blob = require('../../lib/blob');
const monday = require('../../lib/monday');
const { findItemByAgreementId } = require('../uploadToSharePoint');

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
    const current = await monday.readRow(boardId, itemId).catch(() => null);
    const alreadyDone = (current && current.columns[cfg.monday.columns.status] === cfg.monday.statusLabels.complete)
      || await monday.hasUpdateContaining(itemId, 'Onboarding paperwork complete').catch(() => false);
    if (alreadyDone) {
      logger.event('archiveToBlob-already-complete', { itemId, agreementId });
      context.res = { status: 200, body: { itemId, status: 'already complete (idempotent replay)' } };
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

    // Final status: ⑦ Onboarding Complete + offer column ⑥ Signed & Archived
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.complete).catch(err => {
      logger.warn('archiveToBlob-final-status-update-failed', { itemId, error: err.message });
    });
    await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.signed).catch(err => {
      logger.warn('archiveToBlob-offer-signed-update-failed', { itemId, error: err.message });
    });

    // Downstream kickoff: open the background check and link it to the hire
    await monday.createBackgroundCheck(boardId, itemId, employeeName ? employeeName.replace(/-/g, ' ') : null).catch(err => {
      logger.warn('archiveToBlob-bg-check-create-failed', { itemId, error: err.message });
    });

    // ADP handoff readiness — tell the team exactly what (if anything) is missing
    let adpLine = '';
    try {
      const readiness = await monday.adpReadiness(boardId, itemId);
      adpLine = readiness.complete
        ? `\n\n🟢 ADP handoff: all ${readiness.total} required fields are filled — ready for user creation.`
        : `\n\n🟡 ADP handoff: ${readiness.filled}/${readiness.total} required fields filled. Missing: ${readiness.missing.join(', ')}.`;
    } catch (err) {
      logger.warn('archiveToBlob-adp-readiness-failed', { itemId, error: err.message });
    }

    await monday.logAction(itemId,
      `✅ Onboarding paperwork complete — all signatures collected, signed offer archived (see Signed PDF link). Background check opened and linked.${adpLine}`,
      `Signed PDF (agreement ${agreementId}) downloaded from Adobe Sign, archived to the pdf-archive container, links + relations written back.`
    ).catch(err => logger.warn('archiveToBlob-notify-failed', { itemId, error: err.message }));

    logger.info('archiveToBlob-complete', { itemId, archiveUrl });

    context.res = {
      status: 200,
      body: { itemId, archiveUrl, status: 'Signed document archived and onboarding complete' }
    };

  } catch (error) {
    logger.error('archiveToBlob-error', { error: error.message, itemId });

    // Update Monday: status → "Archive Error" (only when we know which item)
    if (itemId) {
      await monday.updateItemStatus(boardId, itemId, 'Archive Error').catch(() => {});
    }

    throw error;
  }
}

module.exports = processArchive;
module.exports.processArchive = processArchive;
