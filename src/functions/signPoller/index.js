'use strict';
/**
 * signPoller: 30-min fallback for missed Adobe webhooks. Scans the
 * onboarding board for items still in "Sent for Sign", asks Adobe for the
 * live agreement status, and enqueues archiving for anything SIGNED.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const adobe = require('../../lib/adobe');

/** Items on the onboarding board whose status column = "Sent for Sign". */
async function findPendingItems() {
  const cfg = config.load();
  const query = `
    query ($boardId: ID!, $columnId: String!, $value: String!) {
      items_page_by_column_values (
        board_id: $boardId,
        columns: [{column_id: $columnId, column_values: [$value]}],
        limit: 100
      ) {
        items {
          id
          name
          column_values { id text }
        }
      }
    }`;
  const data = await monday._gql(query, {
    boardId: String(cfg.monday.onboardingBoardId),
    columnId: cfg.monday.columns.status,
    value: cfg.monday.statusLabels.outForSignature,
  }, 'monday-find-pending-sign');

  const items = (data.items_page_by_column_values && data.items_page_by_column_values.items) || [];
  return items.map((item) => {
    const agreementCol = (item.column_values || []).find((cv) => cv.id === cfg.monday.columns.agreementId);
    return { itemId: item.id, name: item.name, agreementId: agreementCol ? agreementCol.text : null };
  }).filter((i) => i.agreementId);
}

/** Core (exported for tests). @returns queue messages for completed agreements */
async function pollPendingAgreements() {
  const cfg = config.load();

  // No Sign credential configured -> nothing can be polled; stay quiet
  // instead of erroring every 30 minutes.
  if (!cfg.adobe.signIntegrationKey && !cfg.adobe.signRefreshToken) {
    logger.event('sign-poller-skipped', { reason: 'no Adobe Sign credential configured' });
    return [];
  }

  const pending = await findPendingItems();
  const completed = [];

  for (const item of pending) {
    try {
      const status = await adobe.getAgreementStatus(item.agreementId);
      if (status.status === 'SIGNED') {
        completed.push({
          agreementId: item.agreementId,
          itemId: item.itemId,
          boardId: cfg.monday.onboardingBoardId,
          employeeName: item.name,
          signers: status.signers,
          source: 'signPoller',
          receivedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.error('sign-poller-status-check-failed', err, {
        itemId: item.itemId, agreementId: item.agreementId,
      });
    }
  }

  logger.event('sign-poller-run', { pending: pending.length, completed: completed.length });
  return completed;
}

module.exports = async function (context, timer) {
  if (timer && timer.isPastDue) logger.warn('sign-poller-past-due');
  const completed = await pollPendingAgreements();
  if (completed.length) {
    context.bindings.archiveQueue = completed.map((m) => JSON.stringify(m));
  }
};

module.exports.pollPendingAgreements = pollPendingAgreements;
module.exports.findPendingItems = findPendingItems;
