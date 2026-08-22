'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const { WebhookError, validateSignature } = require('../../lib/webhookErrors');
const { stepHeader } = require('../../lib/util');

/**
 * atsSync: when a candidate on an ATS board (RPH-ATS / Clerk-ATS) is set to
 * the hired status, create their Onboarding item and LINK it to the ATS row —
 * the Onboarding board's mirror columns (names, email, phone, start date,
 * license, location) populate themselves through that link. The welcome
 * blast then fires automatically on the new item.
 */

async function handleAtsSync(req) {
  const cfg = config.load();
  const body = req.body || {};

  // Monday URL-verification handshake
  if (body.challenge) {
    return { status: 200, body: { challenge: body.challenge } };
  }

  // Validate the signed Monday webhook JWT (same gate as the other receivers)
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || null;
  try {
    validateSignature(auth, cfg.monday.signingSecret);
  } catch (err) {
    if (err instanceof WebhookError) {
      err.log({ requestPath: '/api/atsSync' });
      return { status: err.response.status, body: err.response.body };
    }
    throw err;
  }

  const ats = cfg.monday.atsIntake;
  const event = body.event || {};
  const atsItemId = event.pulseId || event.itemId;
  const atsBoardId = String(event.boardId || '');
  const boardCfg = ats.boards[atsBoardId];

  // STRICT gate: status-column change on a known ATS board, to the hired label
  const isColumnEvent = event.type === 'update_column_value' || event.type === 'change_column_value';
  const label = (event.value && event.value.label && (event.value.label.text || event.value.label))
    || (typeof event.value === 'string' ? event.value : null);

  if (!atsItemId || !boardCfg || !isColumnEvent || event.columnId !== ats.statusColumn) {
    return { status: 200, body: { ignored: true, reason: 'not an ATS status event' } };
  }
  if (label !== ats.hiredLabel) {
    return { status: 200, body: { ignored: true, reason: `status is not "${ats.hiredLabel}"` } };
  }

  /** Pull a usable email string out of an ATS row's email column. */
  const atsRowEmail = (row, colId) => {
    if (!colId) return null;
    const v = row.columns[colId];
    if (!v) return null;
    if (typeof v === 'string') return v;
    return v.email || v.text || null;
  };

  // Read the candidate from the ATS board
  const atsRow = await monday.readRow(atsBoardId, atsItemId);
  const candidateName = String(atsRow.name || '').trim();
  logger.info('atsSync-hired-detected', { atsBoardId, atsItemId, candidateName, source: boardCfg.name });

  // Idempotency: if an Onboarding item already links this ATS row, skip.
  // (Exact-name matches without the link get linked instead of duplicated.)
  const matches = await monday.findItemsByName(cfg.monday.onboardingBoardId, candidateName);
  for (const m of matches) {
    const rel = await monday.getColumnValueJson(cfg.monday.onboardingBoardId, m.id, boardCfg.relationColumn).catch(() => null);
    const linked = rel && (rel.linkedPulseIds || []).map((p) => String(p.linkedPulseId || p)).concat((rel.item_ids || []).map(String));
    if (linked && linked.includes(String(atsItemId))) {
      logger.event('atsSync-already-imported', { atsItemId, onboardingItemId: m.id });
      return { status: 200, body: { imported: true, deduped: true, onboardingItemId: m.id } };
    }
  }

  let onboardingItemId;
  // NAMESAKE PROTECTION: a name is not an identity. Two real people share
  // "John Smith" often enough that linking by name alone would overwrite the
  // first John's pay, title and contact details with the second John's.
  // Identity = email; the name only narrows the search.
  const sameName = matches.filter((m) => m.name.trim().toLowerCase() === candidateName.toLowerCase());
  const atsEmailRaw = (boardCfg.copy && atsRowEmail(atsRow, boardCfg.copy.email)) || null;
  const atsEmail = atsEmailRaw ? String(atsEmailRaw).trim().toLowerCase() : null;
  let exact = null;
  let namesakeWarning = null;

  for (const m of sameName) {
    const existingEmail = await monday.getColumnValueJson(
      cfg.monday.onboardingBoardId, m.id, cfg.monday.formSync.targetColumns.personalEmail
    ).catch(() => null);
    const existing = existingEmail && String(existingEmail.email || existingEmail.text || '').trim().toLowerCase();
    if (atsEmail && existing && existing === atsEmail) { exact = m; break; }   // same person
    if (atsEmail && existing && existing !== atsEmail) continue;               // different person
    if (!atsEmail || !existing) exact = exact || m;                            // can't tell — reuse, but warn
  }
  if (sameName.length > 0 && !exact) {
    namesakeWarning = stepHeader(1, 'Namesake check')
      + `⚠️ Heads up — another hire on this board is also named "${candidateName}".\n\n`
      + `WHY: the other card carries a different email address — this is a separate new card for the person whose email is ${atsEmail || '(none on the ATS record)'}.\n\n`
      + `Your move\n`
      + `    → confirm you're working on the right card before going further — both look identical in lists; tell them apart by Personal Email`;
  } else if (exact && sameName.length > 1) {
    // Several cards carry this name — say which one we touched and why.
    namesakeWarning = stepHeader(1, 'Namesake check')
      + `⚠️ Heads up — ${sameName.length} cards on this board are named "${candidateName}".\n\n`
      + `WHY: this ATS record was linked to the card whose Personal Email matches (${atsEmail || 'no email available, so the first match was used'}).\n\n`
      + `Your move\n`
      + `    → double-check you're on the right card before approving anything — in lists they look identical; Personal Email tells them apart`;
  }

  const roleColumns = {
    [boardCfg.relationColumn]: { item_ids: [Number(atsItemId)] },
    [cfg.monday.columns.jobTitle]: { labels: [boardCfg.jobTitle] },
    [cfg.monday.columns.payClass]: { labels: [boardCfg.payClass] },
  };

  // Copy real candidate data from the ATS row onto the hire record
  const copy = boardCfg.copy || {};
  const tc = cfg.monday.formSync.targetColumns;
  const atsGet = (colId) => {
    const v = atsRow.columns[colId];
    return v != null && v !== '' && typeof v !== 'object' ? v : null;
  };
  const email = atsGet(copy.email);
  if (email) roleColumns[tc.personalEmail] = { email, text: email };
  const phoneDigits = String(atsGet(copy.phone) || '').replace(/\D/g, '');
  if (phoneDigits) roleColumns[tc.mobilePhone] = { phone: phoneDigits, countryShortName: 'US' };
  const startDate = atsGet(copy.startDate);
  if (startDate) roleColumns[tc.startDate] = { date: String(startDate).slice(0, 10) };

  if (exact) {
    // Hire already exists (e.g. created manually) — link it instead of duplicating
    onboardingItemId = exact.id;
    await monday.updateItemColumns(cfg.monday.onboardingBoardId, onboardingItemId, roleColumns);
    logger.event('atsSync-linked-existing', { atsItemId, onboardingItemId });
  } else {
    const mutation = `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON) {
        create_item (board_id: $boardId, group_id: "topics", item_name: $itemName, column_values: $columnValues, create_labels_if_missing: true) {
          id
        }
      }`;
    const data = await monday._gql(mutation, {
      boardId: String(cfg.monday.onboardingBoardId),
      itemName: candidateName,
      columnValues: JSON.stringify(roleColumns),
    }, 'monday-ats-create-hire');
    onboardingItemId = data.create_item && data.create_item.id;
    if (!onboardingItemId) throw new Error('atsSync: create_item returned no id');
    logger.event('atsSync-created-hire', { atsItemId, onboardingItemId });
  }

  // Audit trail on both sides. Dedupe: Monday redelivers on timeout and the
  // "Imported from" comment posted 3× in a live run — post it exactly once.
  const alreadyNoted = await monday.hasUpdateContaining(onboardingItemId, 'Imported from').catch(() => false);
  if (!alreadyNoted) {
    await monday.logAction(onboardingItemId,
      stepHeader(1, 'Imported')
      + `Imported from ${boardCfg.name} — marked "${ats.hiredLabel}" · role preset ${boardCfg.jobTitle} (${boardCfg.payClass}). The ATS record is linked; names, email, phone and dates mirror in automatically.\n\n`
      + `Next → the welcome comment with the hire-field checklist posts here.`,
      `ATS item ${atsItemId} (board ${atsBoardId}) linked via ${boardCfg.relationColumn}; job title + pay class preset from the source board.`
    ).catch((err) => logger.warn('atsSync-onboarding-log-failed', { onboardingItemId, error: err.message }));
  }

  if (namesakeWarning) {
    logger.event('atsSync-namesake-warning', { onboardingItemId, candidateName, atsEmail });
    await monday.logAction(onboardingItemId, namesakeWarning)
      .catch((err) => logger.warn('atsSync-namesake-log-failed', { onboardingItemId, error: err.message }));
  }

  await monday.logAction(atsItemId,
    stepHeader(1, 'Onboarding started')
    + `Onboarding started for ${candidateName} — their Onboarding record was created and linked automatically.\n\n`
    + `Next → the welcome packet is prepared on their Onboarding card.`,
    `Onboarding item ${onboardingItemId} created/linked on board ${cfg.monday.onboardingBoardId} by atsSync.`
  ).catch((err) => logger.warn('atsSync-ats-log-failed', { atsItemId, error: err.message }));

  return { status: 200, body: { imported: true, onboardingItemId, candidateName, source: boardCfg.name } };
}

module.exports = async function (context, req) {
  try {
    const result = await handleAtsSync(req);
    context.res = { status: result.status, headers: { 'Content-Type': 'application/json' }, body: result.body };
  } catch (error) {
    logger.error('atsSync-error', { error: error.message });
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: 'ATS sync failed' } };
  }
};
module.exports.handleAtsSync = handleAtsSync;
