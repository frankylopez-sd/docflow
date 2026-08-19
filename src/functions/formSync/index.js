'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const { WebhookError, validateSignature } = require('../../lib/webhookErrors');

/**
 * formSync: syncs a welcome-form submission onto the matching Onboarding
 * hire record. Triggered by a Monday webhook on the form-response board
 * (item created = form submitted). Monday is the database of record — the
 * submission row is read fresh and mapped onto the hire's columns.
 */

// Form time-zone labels are short ("MST - Mountain"); the Onboarding board
// uses the full ADP vocabulary. Map by prefix code.
const TIMEZONE_MAP = {
  PST: 'PST - Pacific Standard Time',
  MST: 'MST - Mountain Standard Time',
  CST: 'CST - Central Standard Time',
  EST: 'EST - Eastern Standard Time',
  HST: 'HST - Hawaiian Standard Time',
  PRSJU: 'PRSJU - San Juan Puerto Rico',
};

function normalizePhone(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

async function handleFormSync(req) {
  const cfg = config.load();
  const body = req.body || {};

  // Monday URL-verification handshake
  if (body.challenge) {
    return { status: 200, body: { challenge: body.challenge } };
  }

  // Validate the signed Monday webhook JWT (same gate as mondayWebhook)
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || null;
  try {
    validateSignature(auth, cfg.monday.signingSecret);
  } catch (err) {
    if (err instanceof WebhookError) {
      err.log({ requestPath: '/api/formSync' });
      return { status: err.response.status, body: err.response.body };
    }
    throw err;
  }

  const event = body.event || {};
  const itemId = event.pulseId || event.itemId;
  const eventBoardId = String(event.boardId || '');

  // STRICT gate: only item-creation events from the form-response board.
  // event.boardId is caller-supplied — it must match the pinned board exactly.
  const isCreate = event.type === 'create_pulse' || event.type === 'create_item';
  if (!itemId || !isCreate || eventBoardId !== String(cfg.monday.formSync.boardId)) {
    return { status: 200, body: { ignored: true, reason: 'not a form-board submission event' } };
  }

  const fc = cfg.monday.formSync.formColumns;
  const tc = cfg.monday.formSync.targetColumns;

  // Read the submission row
  const row = await monday.readRow(eventBoardId, itemId);
  const candidateName = String(row.name || '').trim();
  const get = (colId) => {
    const v = row.columns[colId];
    return v != null && v !== '' && typeof v !== 'object' ? v : null;
  };

  logger.info('formSync-submission-received', { itemId, candidateName });

  // Match the hire on the Onboarding board by name
  const matches = await monday.findItemsByName(cfg.monday.onboardingBoardId, candidateName);
  if (matches.length === 0) {
    logger.warn('formSync-no-hire-match', { candidateName, formItemId: itemId });
    await monday.postUpdate(itemId,
      `⚠️ Form sync: no matching hire named "${candidateName}" found on the Onboarding board. Link this submission manually.`
    ).catch(() => {});
    return { status: 200, body: { synced: false, reason: 'no matching hire', candidateName } };
  }
  if (matches.length > 1) {
    logger.warn('formSync-ambiguous-hire-match', { candidateName, count: matches.length });
    await monday.postUpdate(itemId,
      `⚠️ Form sync: ${matches.length} hires match "${candidateName}" on the Onboarding board — not syncing automatically. Resolve manually.`
    ).catch(() => {});
    return { status: 200, body: { synced: false, reason: 'ambiguous match', candidateName } };
  }

  const hireId = matches[0].id;

  // Idempotency: Monday redelivers webhooks on timeout. If this submission's
  // email is already on the hire, the sync already ran — do not repeat writes
  // or re-post the notification update.
  const submittedEmail = get(fc.personalEmail);
  if (submittedEmail) {
    const existing = await monday.getColumnValueJson(cfg.monday.onboardingBoardId, hireId, tc.personalEmail);
    if (existing && existing.email && existing.email.toLowerCase() === submittedEmail.toLowerCase()) {
      logger.event('formSync-already-synced', { formItemId: itemId, hireId });
      return { status: 200, body: { synced: true, hireId, deduped: true } };
    }
  }

  // Build the column writes (only fields the candidate actually provided)
  const values = {};
  const preferredFirst = get(fc.preferredFirst);
  if (preferredFirst) values[tc.preferredFirst] = preferredFirst;

  const email = get(fc.personalEmail);
  if (email) values[tc.personalEmail] = { email, text: email };

  const phone = normalizePhone(get(fc.mobilePhone));
  if (phone) values[tc.mobilePhone] = { phone, countryShortName: 'US' };

  // Location: copy the raw value JSON (contains lat/lng/address from the form)
  const address = await monday.getColumnValueJson(eventBoardId, itemId, fc.homeAddress);
  if (address && (address.address || address.lat)) values[tc.homeAddress] = address;

  const livedIn = get(fc.livedInState);
  if (livedIn) values[tc.livedInState] = { labels: [livedIn] };

  const tzShort = get(fc.timeZone);
  if (tzShort) {
    const code = String(tzShort).split(' ')[0].toUpperCase();
    values[tc.timeZone] = { labels: [TIMEZONE_MAP[code] || tzShort] };
  }

  const startDate = get(fc.startDate);
  if (startDate) values[tc.startDate] = { date: startDate };

  const emName = get(fc.emergencyName);
  if (emName) values[tc.emergencyName] = emName;

  const emPhone = normalizePhone(get(fc.emergencyPhone));
  if (emPhone) values[tc.emergencyPhone] = { phone: emPhone, countryShortName: 'US' };

  await monday.updateItemColumns(cfg.monday.onboardingBoardId, hireId, values);

  // Visible trail on the hire record (notifies subscribers)
  const notes = get(fc.notes);
  await monday.postUpdate(hireId,
    `📥 Welcome form received from ${candidateName}. Contact info, address, emergency contact and availability synced.`
    + (notes ? `\n\nCandidate notes: ${notes}` : '')
  ).catch((err) => logger.warn('formSync-update-post-failed', { hireId, error: err.message }));

  logger.event('formSync-complete', { formItemId: itemId, hireId, fields: Object.keys(values).length });
  return { status: 200, body: { synced: true, hireId, fields: Object.keys(values).length } };
}

module.exports = async function (context, req) {
  try {
    const result = await handleFormSync(req);
    context.res = { status: result.status, headers: { 'Content-Type': 'application/json' }, body: result.body };
  } catch (error) {
    logger.error('formSync-error', { error: error.message });
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: 'form sync failed' } };
  }
};
module.exports.handleFormSync = handleFormSync;
