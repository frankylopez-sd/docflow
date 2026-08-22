'use strict';
/**
 * reconcileIntake: 10-minute self-healing sweep for missed ATS webhooks.
 *
 * Failure it heals: HR marks a candidate "Hired (Closed)" while the app is
 * mid-deploy → the atsSync webhook bounces → the candidate never lands on the
 * Onboarding board. Silent loss. This timer scans every ATS intake board for
 * items sitting at the hired label, checks whether an Onboarding item already
 * links them (same relation check atsSync does), and imports any that were
 * missed via processHiredCandidate({ caughtUp: true }) — which posts an honest
 * "I caught it on my sweep" line on the hire card.
 *
 * Safety rails: max 10 catch-ups per run, per-item try/catch (one bad row
 * never blocks the rest), and processHiredCandidate is idempotent (relation
 * dedupe + 'Imported from' comment marker), so racing a live webhook is safe.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const { processHiredCandidate } = require('../atsSync');

const MAX_CATCHUPS_PER_RUN = 10;

/** Items on one ATS board whose status column = the hired label. */
async function findHiredItems(atsBoardId) {
  const cfg = config.load();
  const ats = cfg.monday.atsIntake;
  const query = `
    query ($boardId: ID!, $columnId: String!, $value: String!) {
      items_page_by_column_values (
        board_id: $boardId,
        columns: [{column_id: $columnId, column_values: [$value]}],
        limit: 100
      ) {
        items { id name }
      }
    }`;
  const data = await monday._gql(query, {
    boardId: String(atsBoardId),
    columnId: ats.statusColumn,
    value: ats.hiredLabel,
  }, 'monday-find-hired-ats');
  return (data.items_page_by_column_values && data.items_page_by_column_values.items) || [];
}

/** Is this ATS row already linked from an Onboarding item? (atsSync's check) */
async function alreadyOnboarded(atsItemId, candidateName, relationColumn) {
  const cfg = config.load();
  const matches = await monday.findItemsByName(cfg.monday.onboardingBoardId, candidateName);
  for (const m of matches) {
    const rel = await monday.getColumnValueJson(cfg.monday.onboardingBoardId, m.id, relationColumn).catch(() => null);
    const linked = rel && (rel.linkedPulseIds || []).map((p) => String(p.linkedPulseId || p)).concat((rel.item_ids || []).map(String));
    if (linked && linked.includes(String(atsItemId))) return true;
  }
  return false;
}

/** Core sweep (exported for tests). @returns {Promise<Object>} run summary */
async function reconcileHiredCandidates() {
  const cfg = config.load();
  const ats = cfg.monday.atsIntake;
  const summary = { scanned: 0, alreadyLinked: 0, caughtUp: 0, failed: 0, capped: false };
  const seen = new Set(); // Monday item ids are globally unique — one shot per item per run

  for (const [atsBoardId, boardCfg] of Object.entries(ats.boards)) {
    let hired;
    try {
      hired = await findHiredItems(atsBoardId);
    } catch (err) {
      logger.error('reconcile-intake-board-scan-failed', err, { atsBoardId, board: boardCfg.name });
      summary.failed++;
      continue;
    }

    for (const item of hired) {
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      summary.scanned++;
      try {
        const linked = await alreadyOnboarded(item.id, String(item.name || '').trim(), boardCfg.relationColumn);
        if (linked) {
          summary.alreadyLinked++;
          continue;
        }
        if (summary.caughtUp >= MAX_CATCHUPS_PER_RUN) {
          summary.capped = true;
          logger.warn('reconcile-intake-cap-reached', { cap: MAX_CATCHUPS_PER_RUN, atsBoardId });
          continue; // keep counting scanned/linked, but import no more this run
        }
        const result = await processHiredCandidate(atsBoardId, item.id, { caughtUp: true });
        if (result.deduped) summary.alreadyLinked++;
        else summary.caughtUp++;
      } catch (err) {
        // Never let one bad row poison the sweep — log and move on.
        summary.failed++;
        logger.error('reconcile-intake-item-failed', err, { atsBoardId, atsItemId: item.id, name: item.name });
      }
    }
  }

  logger.event('reconcile-intake-run', summary);
  return summary;
}

module.exports = async function (context, timer) {
  if (timer && timer.isPastDue) logger.warn('reconcile-intake-past-due');
  await reconcileHiredCandidates();
};

module.exports.reconcileHiredCandidates = reconcileHiredCandidates;
module.exports.findHiredItems = findHiredItems;
