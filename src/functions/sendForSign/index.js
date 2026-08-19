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

    // HR-approval messages carry only {boardId, itemId} — Monday is the
    // database of record, so hydrate the PDF link and hire fields from it.
    if (!pdfUrl) {
      const link = await monday.getColumnValueJson(boardId, itemId, cfg.monday.columns.pdfUrl);
      pdfUrl = link && link.url;
      if (!pdfUrl) {
        throw new Error(`sendForSign: no PDF link on item ${itemId} (column ${cfg.monday.columns.pdfUrl}) — was the offer generated?`);
      }
    }
    if (!firstName || !lastName || !workEmail) {
      const hire = await monday.fetchHireData(boardId, itemId);
      firstName = firstName || hire.firstName;
      lastName = lastName || hire.lastName;
      workEmail = workEmail || hire.workEmail;
      supervisor = supervisor || hire.supervisor;
      logger.info('sendForSign-hydrated-from-monday', { itemId });
    }

    // Update Monday: status → "Sent for Signature"
    await monday.updateItemStatus(boardId, itemId, 'Sent for Signature').catch(err => {
      logger.warn('sendForSign-status-update-failed', { itemId, error: err.message });
    });

    // Define 3 signers in serial order. The board's supervisor column holds a
    // display name (e.g. "Avani"), not an address — only use it if it is a
    // real email, otherwise route to the manager distribution address.
    const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    const signers = [
      {
        email: 'hr@medwatchers.com', // HR Rep
        name: 'HR Representative',
        order: 0
      },
      {
        email: isEmail(supervisor) ? supervisor : 'manager@medwatchers.com', // Manager
        name: 'Manager',
        order: 1
      },
      {
        email: workEmail, // Employee
        name: `${firstName} ${lastName}`,
        order: 2
      }
    ];

    logger.info('sendForSign-creating-agreement', { itemId, signerCount: signers.length });

    // Create Adobe Sign agreement
    const agreementResult = await adobe.createSigningAgreement({
      documentUrl: pdfUrl,
      fileName: `offer-${firstName}-${lastName}.pdf`,
      signers: signers,
      message: `Please review and sign the offer letter for ${firstName} ${lastName}`,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    const agreementId = agreementResult.id;
    logger.info('sendForSign-agreement-created', { itemId, agreementId });

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

    await monday.postUpdate(itemId,
      `✉️ Offer sent for signature (agreement ${agreementId}). Signing order: ${signers.map(s => s.name).join(' → ')}.`
    ).catch(err => logger.warn('sendForSign-notify-failed', { itemId, error: err.message }));

    logger.info('sendForSign-complete', { itemId, agreementId });

    context.res = {
      status: 200,
      body: { itemId, agreementId, signers: signers.length, status: 'Agreement created and sent to signers' }
    };

  } catch (error) {
    logger.error('sendForSign-error', { error: error.message, itemId: queueItem?.itemId });

    // Update Monday: status → "Sign Failed"
    await monday.updateItemStatus(queueItem?.boardId, queueItem?.itemId, 'Sign Failed').catch(() => {});
    // Notify once (first attempt), not on every automatic retry
    const attempt = context?.bindingData?.dequeueCount;
    if (queueItem?.itemId && (!attempt || Number(attempt) <= 1)) {
      await monday.postUpdate(queueItem.itemId,
        `❌ Sending for signature failed: ${error.message}. The system retries automatically; to re-trigger manually, set Offer Letter Status back to "Packaged Approved".`
      ).catch(() => {});
    }

    throw error;
  }
};
