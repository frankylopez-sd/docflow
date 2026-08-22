'use strict';
/**
 * nudgeSweep: the DocFlow reminder engine. One hourly timer (:15) scans the
 * Onboarding board for stalled hires and nudges the right party — candidate
 * nudges as warm branded emails from MedWatchers HR, HR nudges as card
 * comments in the DocFlow voice. Staleness is measured from the timestamps
 * of the marker comments the pipeline already posts ("went out",
 * "I built the packet", "archived (agreement "), falling back to the card's
 * last activity.
 *
 * Scenarios:
 *   GHOST              ⑤ Sent >48h, signing link never clicked  → nudge email
 *   GHOST ESCALATION   ⑤ Sent >96h, still no click              → HR comment only
 *   CLICKED-NOT-SIGNED ⑤ Sent >24h, clicked but unsigned        → "almost there" email
 *   FORM GHOST         ⑥ Form Pending >72h                      → form-only reminder email
 *   LAPSE              Offer Expires passed, still ⑤ Sent       → narrate + cancel Adobe agreement
 *   HR STALL           ④ Review >2 business days                → HR comment
 *   READY-NOT-SENT     ⑥ Ready to Send >24h                     → HR comment
 *   FIELDS IDLE        ①/② >72h with required fields empty      → HR comment
 *
 * Anti-spam rails (non-negotiable):
 *   - Opt-out checkbox (cfg.monday.columns.noReminders): checked → no nudges
 *     of any kind for that card. Only the LAPSE narration still posts.
 *   - Every nudge type fires ONCE per hire — deduped on the verbatim needle
 *     phrase kept inside the comment (see NEEDLES).
 *   - Max 3 candidate emails per hire, ever, from this sweep.
 *   - Max 20 actions per run; per-item try/catch so one bad row never blocks.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const adobe = require('../../lib/adobe');
const mailer = require('../../lib/mailer');
const { stepHeader, trackedLink } = require('../../lib/util');

// Dedupe needles — each appears VERBATIM inside its comment. Never reword.
const NEEDLES = {
  signReminder: 'nudge: signing reminder sent',
  hrEscalation: 'nudge: HR escalation posted',
  almostThere: 'nudge: almost-there reminder sent',
  formReminder: 'nudge: form reminder sent',
  lapsed: 'nudge: offer lapsed',
  reviewStall: 'nudge: review stall noted',
  readyNotSent: 'nudge: ready-not-sent noted',
  fieldsIdle: 'nudge: fields idle noted',
};

// The needles that represent a candidate EMAIL (counted against the budget).
const CANDIDATE_EMAIL_NEEDLES = [NEEDLES.signReminder, NEEDLES.almostThere, NEEDLES.formReminder];

const MAX_ACTIONS_PER_RUN = 20;

// Click needles posted by trackClick — measured, never guessed.
const CLICKED_SIGN = 'clicked the signing link';

function _num(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

/** Env-tunable thresholds (hours unless noted). */
function thresholds() {
  return {
    ghostHours: _num('DOCFLOW_NUDGE_GHOST_HOURS', 48),
    escalateHours: _num('DOCFLOW_NUDGE_ESCALATE_HOURS', 96),
    clickedHours: _num('DOCFLOW_NUDGE_CLICKED_HOURS', 24),
    formHours: _num('DOCFLOW_NUDGE_FORM_HOURS', 72),
    hrStallBusinessDays: _num('DOCFLOW_NUDGE_HR_STALL_BUSINESS_DAYS', 2),
    readyHours: _num('DOCFLOW_NUDGE_READY_HOURS', 24),
    fieldsHours: _num('DOCFLOW_NUDGE_FIELDS_HOURS', 72),
    maxCandidateEmails: _num('DOCFLOW_NUDGE_MAX_EMAILS', 3),
  };
}

/** Whole business days (Mon–Fri) elapsed between two epoch-ms instants. */
function businessDaysBetween(startMs, endMs) {
  if (!startMs || !endMs || endMs <= startMs) return 0;
  const DAY = 24 * 60 * 60 * 1000;
  let count = 0;
  for (let t = startMs; t + DAY <= endMs; t += DAY) {
    const day = new Date(t + DAY).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function _isChecked(v) {
  if (!v) return false;
  if (typeof v === 'object') return v.checked === true || v.checked === 'true';
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try { return _isChecked(JSON.parse(v)); } catch (_) { return false; }
  }
  return v === true || v === 'true' || v === 'v' || v === '✓';
}

/** Pull an email address out of a column value (object, JSON string, or plain). */
function _emailOf(v) {
  if (!v) return null;
  if (typeof v === 'object') return v.email || v.text || null;
  const s = String(v).trim();
  if (s.startsWith('{')) {
    try { return _emailOf(JSON.parse(s)); } catch (_) { /* fall through */ }
  }
  return /@/.test(s) ? s.split(/\s+/)[0] : null;
}

/** End-of-day epoch ms for a date column value ('YYYY-MM-DD' or {date}). */
function _dateEndMs(v) {
  const raw = v && typeof v === 'object' ? v.date : v;
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T23:59:59Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Preferred recipient: personal email first, work email fallback. */
function _recipientOf(row) {
  const cfg = config.load();
  return _emailOf(row.columns[cfg.monday.formSync.targetColumns.personalEmail])
    || _emailOf(row.columns[cfg.monday.columns.workEmail])
    || null;
}

/** The candidate's signing link: agreement-link column first, then Adobe. */
async function _signingLinkFor(row) {
  const cfg = config.load();
  if (cfg.monday.columns.agreementLink) {
    const v = await monday.getColumnValueJson(row.boardId, row.itemId, cfg.monday.columns.agreementLink).catch(() => null);
    if (v && v.url) return v.url;
  }
  const agreementId = row.columns[cfg.monday.columns.agreementId];
  if (agreementId && typeof agreementId === 'string' && agreementId.trim()) {
    return adobe.getSigningUrl(agreementId.trim(), { attempts: 1, delayMs: 0 }).catch(() => null);
  }
  return null;
}

/**
 * Scan the Onboarding board (items_page, limit 100) into light summaries.
 * Client-side filtering keeps the query simple and complexity-cheap.
 */
async function scanBoard() {
  const cfg = config.load();
  const c = cfg.monday.columns;
  const query = `
    query ($boardId: [ID!]) {
      boards (ids: $boardId) {
        items_page (limit: 100) {
          items {
            id
            name
            updated_at
            column_values (ids: ["${c.status}", "${c.offerStatus}"]) { id text }
          }
        }
      }
    }`;
  const data = await monday._gql(query, { boardId: [String(cfg.monday.onboardingBoardId)] }, 'nudge-scan-board');
  const items = (data.boards && data.boards[0] && data.boards[0].items_page && data.boards[0].items_page.items) || [];
  return items.map((i) => {
    const cvText = (id) => {
      const cv = (i.column_values || []).find((x) => x.id === id);
      return (cv && cv.text) || '';
    };
    return {
      id: String(i.id),
      name: i.name,
      updatedAt: i.updated_at ? Date.parse(i.updated_at) : null,
      status: cvText(c.status),
      offerStatus: cvText(c.offerStatus),
    };
  });
}

/** One action's worth of budget; flips summary.capped when spent. */
function _takeAction(summary) {
  if (summary.actions >= MAX_ACTIONS_PER_RUN) {
    summary.capped = true;
    return false;
  }
  summary.actions++;
  return true;
}

/**
 * Send one candidate nudge email + post the HR-facing card comment carrying
 * the needle. Mail disarmed / missing recipient still posts the comment (with
 * the honest outcome line) so the needle dedupes future runs either way.
 */
async function _sendCandidateNudge({ item, row, needle, step, stepName, eventLine, subject, bodyText, summary }) {
  const to = _recipientOf(row);
  let outcomeLine;
  if (!to) {
    outcomeLine = 'Nudge email: not sent (no personal or work email on the card).';
  } else {
    const res = await mailer.sendMail({ to, subject, body: bodyText });
    if (res.sent) {
      outcomeLine = `Nudge sent to ${to} ✓`;
      summary.emails++;
    } else {
      outcomeLine = `Nudge email: not sent (${res.reason || 'mail disarmed'}).`;
    }
  }
  await monday.logAction(item.id,
    stepHeader(step, stepName)
    + `${eventLine}\n`
    + `${outcomeLine}\n\n`
    + `(${needle})\n\n`
    + `Next → if nothing moves, I escalate here instead of emailing again.`,
    `nudgeSweep: ${needle}; recipient=${to || 'none'}`);
  summary.nudged++;
}

/** Process one watched hire card. Throws bubble to the per-item catch. */
async function processItem(item, summary) {
  const cfg = config.load();
  const sl = cfg.monday.statusLabels;
  const ol = cfg.monday.offerLabels;
  const cols = cfg.monday.columns;
  const th = thresholds();
  const now = Date.now();

  const row = await monday.readRow(cfg.monday.onboardingBoardId, item.id);
  const firstName = (row.columns[cols.firstName] && typeof row.columns[cols.firstName] === 'string'
    ? row.columns[cols.firstName] : String(item.name || '').split(/\s+/)[0]) || 'there';

  // One fetch of the update thread powers every dedupe + timing decision.
  const updates = await monday.listUpdates(item.id);
  const has = (needle) => updates.some((u) => u.text.includes(needle));
  const newest = (needle) => {
    let best = null;
    for (const u of updates) {
      if (u.text.includes(needle) && u.createdAt && (!best || u.createdAt > best)) best = u.createdAt;
    }
    return best;
  };
  const hoursSince = (ms) => (ms ? (now - ms) / 3600000 : null);

  const optOut = _isChecked(row.columns[cols.noReminders]);

  // ── LAPSE: allowed even with opt-out — it's narration, not a nudge. ──────
  if (item.status === sl.outForSignature) {
    const expiresMs = _dateEndMs(row.columns[cols.offerExpires]);
    if (expiresMs && now > expiresMs && !has(NEEDLES.lapsed)) {
      if (!_takeAction(summary)) return;
      const agreementId = row.columns[cols.agreementId];
      let cancelLine = 'There was no Adobe agreement id on the card, so nothing to cancel on Adobe\'s side.';
      if (agreementId && typeof agreementId === 'string' && agreementId.trim()) {
        try {
          await adobe.cancelAgreement(agreementId.trim(), 'Offer expired — cancelled by DocFlow nudge sweep');
          cancelLine = 'I cancelled the Adobe agreement so the old link can\'t be signed late.';
        } catch (err) {
          cancelLine = `I couldn't cancel the Adobe agreement (${err.message}) — the old link may still work.`;
          logger.warn('nudge-lapse-cancel-failed', { itemId: item.id, agreementId, error: err.message });
        }
      }
      await monday.logAction(item.id,
        stepHeader(8, 'Offer lapsed')
        + `🕐 The offer lapsed — the "Offer Expires" date passed and Francisco never signed.\n`
        + `${cancelLine}\n`
        + `I changed nothing else — the status stays where it is; what happens next is yours.\n\n`
        + `(${NEEDLES.lapsed})\n\n`
        + `Over to you\n`
        + `    ✓ Still hiring → set a new "Offer Expires" date and restart the send from "${ol.approved}"\n`
        + `    ✎ Withdrawing → select "${ol.denied}" and I stand down`,
        `nudgeSweep: ${NEEDLES.lapsed}; agreementId=${agreementId || 'none'}`);
      summary.lapsed++;
      return; // a lapsed offer gets no further nudging
    }
    if (expiresMs && now > expiresMs) return; // lapsed + already narrated: quiet
  }

  if (optOut) {
    summary.skippedOptOut++;
    logger.info('nudge-skip-opt-out', { itemId: item.id });
    return;
  }

  const emailsSoFar = CANDIDATE_EMAIL_NEEDLES.filter(has).length;
  const emailBudgetLeft = emailsSoFar < th.maxCandidateEmails;

  // ── ⑤ Sent: GHOST / CLICKED-NOT-SIGNED / ESCALATION ─────────────────────
  if (item.status === sl.outForSignature) {
    const sentAt = newest('went out') || item.updatedAt;
    const h = hoursSince(sentAt);
    const clicked = has(CLICKED_SIGN);

    if (clicked) {
      if (h != null && h >= th.clickedHours && !has(NEEDLES.almostThere)) {
        if (!emailBudgetLeft) { summary.emailBudgetBlocked++; return; }
        if (!_takeAction(summary)) return;
        const rawLink = await _signingLinkFor(row);
        const link = rawLink ? trackedLink(item.id, 'sign', rawLink) : null;
        await _sendCandidateNudge({
          item, row, summary,
          needle: NEEDLES.almostThere,
          step: 8, stepName: 'Candidate activity',
          eventLine: `${firstName} opened the signing link ${Math.round(h)}h ago but hasn't signed. I sent the "you're almost there" note.`,
          subject: `You're almost there, ${firstName} — one signature to go`,
          bodyText:
            `Hi ${firstName},\n\n`
            + `We saw you opened your offer packet — you're almost there! All that's left is the signature itself, and it takes less than two minutes.\n\n`
            + (link ? `${link}\n\n` : `Reply to this email and we'll send you a fresh signing link right away.\n\n`)
            + `If anything in the packet gave you pause, just reply — a real person on the HR team reads every message.\n\n`
            + `Warmly,\nThe MedWatchers HR Team`,
        });
      }
      return;
    }

    // Never clicked.
    if (h != null && h >= th.escalateHours) {
      if (has(NEEDLES.hrEscalation)) return;
      if (!_takeAction(summary)) return;
      await monday.logAction(item.id,
        stepHeader(8, 'Candidate quiet')
        + `⚠️ ${firstName} hasn't clicked the signing link since it went out — ${Math.round(h)}h and counting.\n`
        + `I'm done emailing the candidate from here; a third machine email helps nobody.\n\n`
        + `(${NEEDLES.hrEscalation})\n\n`
        + `Over to you\n`
        + `    → reach out directly — a call or text lands where email hasn't`,
        `nudgeSweep: ${NEEDLES.hrEscalation}; hoursSinceSend=${Math.round(h)}`);
      summary.nudged++;
      return;
    }

    if (h != null && h >= th.ghostHours && !has(NEEDLES.signReminder)) {
      if (!emailBudgetLeft) { summary.emailBudgetBlocked++; return; }
      if (!_takeAction(summary)) return;
      const rawLink = await _signingLinkFor(row);
      const link = rawLink ? trackedLink(item.id, 'sign', rawLink) : null;
      await _sendCandidateNudge({
        item, row, summary,
        needle: NEEDLES.signReminder,
        step: 8, stepName: 'Candidate quiet',
        eventLine: `${Math.round(h)}h since the packet went out and ${firstName} hasn't opened the signing link. I sent a gentle reminder.`,
        subject: `Your offer from MedWatchers is waiting, ${firstName}`,
        bodyText:
          `Hi ${firstName},\n\n`
          + `Just a friendly note — your offer packet is waiting for your signature. It only takes a couple of minutes, and we'd love to get you started.\n\n`
          + (link ? `${link}\n\n` : `Reply to this email and we'll send you a fresh signing link right away.\n\n`)
          + `If anything is unclear or the link gives you trouble, just reply — a real person on the HR team will help.\n\n`
          + `Warmly,\nThe MedWatchers HR Team`,
      });
    }
    return;
  }

  // ── ⑥ Form Pending: FORM GHOST ───────────────────────────────────────────
  if (item.status === sl.signedFormPending) {
    const anchoredAt = newest('archived (agreement ') || item.updatedAt;
    const h = hoursSince(anchoredAt);
    if (h != null && h >= th.formHours && !has(NEEDLES.formReminder)) {
      if (!emailBudgetLeft) { summary.emailBudgetBlocked++; return; }
      if (!_takeAction(summary)) return;
      const link = trackedLink(item.id, 'form', cfg.monday.formSync.formUrl);
      await _sendCandidateNudge({
        item, row, summary,
        needle: NEEDLES.formReminder,
        step: 9, stepName: 'Form pending',
        eventLine: `The signed packet landed but the info form is still open after ${Math.round(h)}h. I sent a form-only reminder.`,
        subject: `One quick form and you're all set, ${firstName}`,
        bodyText:
          `Hi ${firstName},\n\n`
          + `Your signed offer is safely in — welcome aboard! One small thing is still open: the short new-hire info form. It takes about three minutes.\n\n`
          + `${link}\n\n`
          + `Questions about any of it? Just reply and we'll walk you through.\n\n`
          + `Warmly,\nThe MedWatchers HR Team`,
      });
    }
    return;
  }

  // ── ④ Review: HR STALL (business days) ──────────────────────────────────
  if (item.status === sl.awaitingReview) {
    const anchoredAt = item.updatedAt;
    const bd = anchoredAt ? businessDaysBetween(anchoredAt, now) : 0;
    if (bd >= th.hrStallBusinessDays && !has(NEEDLES.reviewStall)) {
      if (!_takeAction(summary)) return;
      await monday.logAction(item.id,
        stepHeader(3, 'Letter waiting on review')
        + `The letter is built and waiting on your review — ${bd} business days now.\n`
        + `Nothing moves until the gate opens.\n\n`
        + `(${NEEDLES.reviewStall})\n\n`
        + `Over to you\n`
        + `    ✓ Looks right → select "${ol.approved}"\n`
        + `    ✎ Something off → "${ol.moreInfo}" — fix the field, I rebuild the letter`,
        `nudgeSweep: ${NEEDLES.reviewStall}; businessDays=${bd}`);
      summary.nudged++;
    }
    return;
  }

  // ── ①/② Welcome / Waiting: FIELDS IDLE ──────────────────────────────────
  if (item.status === sl.welcome || item.status === sl.awaitingInfo) {
    const h = hoursSince(item.updatedAt);
    if (h != null && h >= th.fieldsHours && !has(NEEDLES.fieldsIdle)) {
      const readiness = await monday.adpReadiness(cfg.monday.onboardingBoardId, item.id);
      if (!readiness.complete) {
        if (!_takeAction(summary)) return;
        await monday.logAction(item.id,
          stepHeader(2, 'Hire details idle')
          + `Momentum dies fast — ${readiness.missing.length} fields are still empty on this card after ${Math.round(h)}h.\n`
          + `The letter builds itself the moment they're filled.\n\n`
          + `(${NEEDLES.fieldsIdle})\n\n`
          + `Over to you\n`
          + `    ✎ Fill the empty fields → I take it from there`,
          `nudgeSweep: ${NEEDLES.fieldsIdle}; missing=${readiness.missing.join(',')}`);
        summary.nudged++;
      }
    }
    // fall through: an idle card can also be Ready-to-Send (different column)
  }

  // ── ⑥ Ready to Send: READY-NOT-SENT (offer status column) ───────────────
  if (item.offerStatus === ol.readyToSend) {
    const anchoredAt = newest('I built the packet') || item.updatedAt;
    const h = hoursSince(anchoredAt);
    if (h != null && h >= th.readyHours && !has(NEEDLES.readyNotSent)) {
      if (!_takeAction(summary)) return;
      await monday.logAction(item.id,
        stepHeader(6, 'Packet waiting to send')
        + `The packet is built and waiting — ${Math.round(h)}h now, and the candidate doesn't know yet.\n`
        + `The preview above is word-for-word what goes out.\n\n`
        + `(${NEEDLES.readyNotSent})\n\n`
        + `Over to you\n`
        + `    ✓ Send it → select "${ol.sendPackage}"\n`
        + `    ✎ Something off → "${ol.moreInfo}" — fix the field, I rebuild`,
        `nudgeSweep: ${NEEDLES.readyNotSent}; hoursWaiting=${Math.round(h)}`);
      summary.nudged++;
    }
  }
}

/**
 * Core sweep (exported for tests). Pass {items} to skip the board scan.
 * @returns {Promise<Object>} run summary
 */
async function runNudgeSweep(opts = {}) {
  const cfg = config.load();
  const sl = cfg.monday.statusLabels;
  const ol = cfg.monday.offerLabels;
  const summary = {
    scanned: 0, watched: 0, nudged: 0, emails: 0, lapsed: 0,
    skippedOptOut: 0, emailBudgetBlocked: 0, failed: 0, actions: 0, capped: false,
  };

  let items = opts.items;
  if (!items) {
    try {
      items = await scanBoard();
    } catch (err) {
      logger.error('nudge-sweep-scan-failed', err, {});
      summary.failed++;
      logger.event('nudge-sweep-run', summary);
      return summary;
    }
  }

  const watchedStatuses = [sl.outForSignature, sl.signedFormPending, sl.awaitingReview, sl.welcome, sl.awaitingInfo];

  for (const item of items) {
    summary.scanned++;
    const watched = watchedStatuses.includes(item.status) || item.offerStatus === ol.readyToSend;
    if (!watched) continue;
    summary.watched++;
    if (summary.capped) continue; // budget spent — keep counting, act no more
    try {
      await processItem(item, summary);
    } catch (err) {
      // One bad row never poisons the sweep.
      summary.failed++;
      logger.error('nudge-sweep-item-failed', err, { itemId: item.id, name: item.name });
    }
  }

  logger.event('nudge-sweep-run', summary);
  return summary;
}

module.exports = async function (context, timer) {
  if (timer && timer.isPastDue) logger.warn('nudge-sweep-past-due');
  await runNudgeSweep();
};

module.exports.runNudgeSweep = runNudgeSweep;
module.exports.scanBoard = scanBoard;
module.exports.processItem = processItem;
module.exports.businessDaysBetween = businessDaysBetween;
module.exports.NEEDLES = NEEDLES;
module.exports.MAX_ACTIONS_PER_RUN = MAX_ACTIONS_PER_RUN;
