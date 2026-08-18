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
    const { boardId, itemId, pdfUrl, firstName, lastName, workEmail, supervisor } = queueItem;

    logger.info('sendForSign-start', { itemId });

    // Update Monday: status → "Sent for Signature"
    await monday.updateItemStatus(boardId, itemId, 'Sent for Signature').catch(err => {
      logger.warn('sendForSign-status-update-failed', { itemId, error: err.message });
    });

    // Define 3 signers in serial order
    const signers = [
      {
        email: 'hr@medwatchers.com', // HR Rep
        name: 'HR Representative',
        order: 0
      },
      {
        email: supervisor || 'manager@medwatchers.com', // Manager
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
    await monday.updateItemColumn(boardId, itemId, 'text_agreement', agreementId).catch(err => {
      logger.warn('sendForSign-agreement-id-update-failed', { itemId, error: err.message });
    });

    // Store signer details
    const signerDetails = signers.map((s, idx) => `${idx + 1}. ${s.name} (${s.email})`).join('\n');
    await monday.updateItemColumn(boardId, itemId, 'long_text_signers', signerDetails).catch(err => {
      logger.warn('sendForSign-signers-update-failed', { itemId, error: err.message });
    });

    logger.info('sendForSign-complete', { itemId, agreementId });

    context.res = {
      status: 200,
      body: { itemId, agreementId, signers: signers.length, status: 'Agreement created and sent to signers' }
    };

  } catch (error) {
    logger.error('sendForSign-error', { error: error.message, itemId: queueItem?.itemId });

    // Update Monday: status → "Sign Failed"
    await monday.updateItemStatus(queueItem?.boardId, queueItem?.itemId, 'Sign Failed').catch(() => {});

    throw error;
  }
};
