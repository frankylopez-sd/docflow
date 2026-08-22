'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const { WebhookError, validateSignature } = require('../../lib/webhookErrors');
const { stepHeader } = require('../../lib/util');

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

/**
 * Candidates typo their own answers. Validate everything before it touches
 * the hire record: valid fields sync, invalid ones are skipped and reported —
 * never write garbage onto the board.
 */

// A normalized phone must be exactly 10 US digits (11 with a leading 1 is
// fine — strip the country code). Anything else is not a dialable US number.
function validUsPhone(text) {
  let digits = normalizePhone(text);
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function validEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(text || '').trim());
}

// US states + DC + territories: full names and 2-letter codes both accepted.
// The board's "State Lived In" dropdown stores whatever label the form sends
// (codes today), so we validate plausibility and pass the value through as-is.
const US_STATE_CODES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands',
  AS: 'American Samoa', MP: 'Northern Mariana Islands',
};
const US_STATE_NAMES = new Set(Object.values(US_STATE_CODES).map((n) => n.toLowerCase()));

function validUsState(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (US_STATE_CODES[t.toUpperCase()]) return true;
  return US_STATE_NAMES.has(t.toLowerCase().replace(/^u\.s\.\s+/, 'u.s. '));
}

function validAddress(address) {
  if (!address || typeof address !== 'object') return false;
  const text = String(address.address || '').trim();
  // Needs an actual street fragment — more than a lone token.
  return text.length > 0 && text.split(/\s+/).length > 1;
}

function validFutureDate(text) {
  const t = String(text || '').trim();
  const d = new Date(`${t}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() >= today.getTime();
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
      `⚠️ Form sync: I found no matching hire named "${candidateName}" on the Onboarding board — nothing was synced.\n\nOver to you\n    → link this submission to the right hire manually`
    ).catch(() => {});
    return { status: 200, body: { synced: false, reason: 'no matching hire', candidateName } };
  }
  if (matches.length > 1) {
    logger.warn('formSync-ambiguous-hire-match', { candidateName, count: matches.length });
    await monday.postUpdate(itemId,
      `⚠️ Form sync: ${matches.length} hires match "${candidateName}" on the Onboarding board — I won't guess between them.\n\nOver to you\n    → pick the correct hire card and copy the form details over manually`
    ).catch(() => {});
    return { status: 200, body: { synced: false, reason: 'ambiguous match', candidateName } };
  }

  const hireId = matches[0].id;

  // Idempotency: Monday redelivers webhooks on timeout. Look for this sync's
  // own comment marker — an email copied over by the ATS import must NOT
  // count as "form already received".
  const alreadySynced = await monday.hasUpdateContaining(hireId, 'Welcome form received').catch(() => false);
  if (alreadySynced) {
    logger.event('formSync-already-synced', { formItemId: itemId, hireId });
    return { status: 200, body: { synced: true, hireId, deduped: true } };
  }

  // Build the column writes — every answer is validated first. Valid fields
  // sync exactly as before; invalid ones are skipped and reported (never
  // write garbage). rejected: [{field, reason, raw}] feeds the card comment.
  const values = {};
  const rejected = [];
  const reject = (field, reason, raw) => rejected.push({ field, reason, raw: raw == null ? '' : String(raw) });

  const preferredFirst = get(fc.preferredFirst);
  if (preferredFirst) values[tc.preferredFirst] = preferredFirst;

  const email = get(fc.personalEmail);
  if (email) {
    if (validEmail(email)) values[tc.personalEmail] = { email, text: email };
    else reject('personal email', `"${email}" doesn't look like an email address`, email);
  }

  const rawPhone = get(fc.mobilePhone);
  const phone = validUsPhone(rawPhone);
  if (phone) values[tc.mobilePhone] = { phone, countryShortName: 'US' };
  else if (rawPhone) reject('mobile phone', `"${rawPhone}" isn't a 10-digit US phone number`, rawPhone);

  // Location: copy the raw value JSON (contains lat/lng/address from the form)
  const address = await monday.getColumnValueJson(eventBoardId, itemId, fc.homeAddress);
  if (address && (address.address || address.lat)) {
    if (validAddress(address)) values[tc.homeAddress] = address;
    else reject('home address', 'what they typed is too thin to be a street address', address.address || JSON.stringify(address));
  }

  const livedIn = get(fc.livedInState);
  if (livedIn) {
    if (validUsState(livedIn)) values[tc.livedInState] = { labels: [livedIn] };
    else reject('state they live in', `"${livedIn}" isn't a US state or territory I recognize`, livedIn);
  }

  const tzShort = get(fc.timeZone);
  if (tzShort) {
    const code = String(tzShort).split(' ')[0].toUpperCase();
    values[tc.timeZone] = { labels: [TIMEZONE_MAP[code] || tzShort] };
  }

  const startDate = get(fc.startDate);
  if (startDate) {
    if (validFutureDate(startDate)) values[tc.startDate] = { date: startDate };
    else reject('start date', `"${startDate}" is either not a real date or already behind us`, startDate);
  }

  const emName = get(fc.emergencyName);
  const rawEmPhone = get(fc.emergencyPhone);
  const emPhone = validUsPhone(rawEmPhone);
  if (emName) values[tc.emergencyName] = emName;
  if (emPhone) values[tc.emergencyPhone] = { phone: emPhone, countryShortName: 'US' };
  if (rawEmPhone && !emPhone) {
    reject('emergency contact phone', `"${rawEmPhone}" isn't a 10-digit US phone number`, rawEmPhone);
  }
  if (!(emName && emPhone)) {
    reject('emergency contact', 'incomplete emergency contact — I need both a name and a working phone number', `name="${emName || ''}", phone="${rawEmPhone || ''}"`);
  }

  if (Object.keys(values).length > 0) {
    await monday.updateItemColumns(cfg.monday.onboardingBoardId, hireId, values);
  }

  // Where does the card go? Forms can arrive any time. If the hire already
  // signed (card sits at "⑥ ✍️ Form Pending"), this form closes the second
  // gate → advance to Waiting for Background. Otherwise it's the normal
  // pre-sign path: ③ HR completes the remaining hire fields.
  const rowStatus = await monday.readRow(cfg.monday.onboardingBoardId, hireId)
    .then((r) => String(r.columns[cfg.monday.columns.status] || r.byTitle['Onboarding Status'] || ''))
    .catch(() => '');
  const postSign = rowStatus === cfg.monday.statusLabels.signedFormPending;
  const nextStatus = postSign
    ? cfg.monday.statusLabels.waitingBackground
    : cfg.monday.statusLabels.fieldsNeeded;
  await monday.updateItemStatus(cfg.monday.onboardingBoardId, hireId, nextStatus).catch((err) => {
    logger.warn('formSync-status-advance-failed', { hireId, error: err.message });
  });

  // Visible trail on the hire record (notifies subscribers).
  // Validation verdict: either the quiet all-clear line, or a clearly-set-off
  // section listing exactly which answers I couldn't use and why.
  const verdict = rejected.length === 0
    ? `\n\nAll answers checked out — every field passed validation.`
    : `\n\n⚠️ I couldn't use ${rejected.length} of their answers:\n`
      + rejected.map((r) => `    • ${r.field} — ${r.reason}`).join('\n');
  const chaseLine = rejected.length > 0
    ? `    → ask ${candidateName} for the flagged answers — send the corrections and I'll sync them onto this card\n`
    : '';

  const notes = get(fc.notes);
  await monday.logAction(hireId,
    (postSign
      ? stepHeader(9, 'Form received')
      + `Welcome form received from ${candidateName} — I synced contact info, address, emergency contact and availability onto this record.`
      + (notes ? `\n\nCandidate notes: ${notes}` : '')
      + verdict
      + (rejected.length > 0 ? `\n\nOver to you\n${chaseLine}` : '')
      + `\n\nTHE THREE GATES:\n    ✍️ Offer packet — SIGNED ✓\n    📥 New Hire form — RECEIVED ✓\n    🔎 Background check — pending (tracked on the Background Checks board)\n\n`
      + `Next → I move the status to "${nextStatus}". Flip to "${cfg.monday.statusLabels.complete}" when the background check clears.`
      : stepHeader(2, 'Hire details')
      + `Welcome form received from ${candidateName} — I synced contact info, address, emergency contact and availability onto this record.`
      + (notes ? `\n\nCandidate notes: ${notes}` : '')
      + verdict
      + `\n\nOver to you\n`
      + chaseLine
      + `    ✎ fill the remaining ADP fields, then check ☑ Details Verified`),
    `formSync matched form submission ${itemId} to this hire by name and wrote ${Object.keys(values).length} columns; status advanced to "${nextStatus}".`
    + (rejected.length > 0
      ? ` Rejected raw values: ${rejected.map((r) => `${r.field}=${JSON.stringify(r.raw)}`).join(', ')}.`
      : '')
  ).catch((err) => logger.warn('formSync-update-post-failed', { hireId, error: err.message }));

  logger.event('formSync-complete', { formItemId: itemId, hireId, fields: Object.keys(values).length, rejected: rejected.length });
  return { status: 200, body: { synced: true, hireId, fields: Object.keys(values).length, rejected: rejected.length } };
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
