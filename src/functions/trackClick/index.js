'use strict';
/**
 * trackClick: anonymous GET redirect for candidate email links.
 *
 * Every link in the two candidate emails is wrapped in a signed redirect
 * (see util.trackedLink). The FIRST click per (item, link kind) posts a card
 * comment in the DocFlow voice, then the candidate is 302'd to the real
 * destination. Signature is HMAC-SHA256 hex of `${i}|${k}|${u}` with
 * cfg.tracking.secret — a bad signature never redirects (open-redirect
 * guard), and even a VALID signature only redirects to https URLs on the
 * host allowlist below. The comment is best-effort behind a 2s race so the
 * candidate never waits on Monday's API.
 */

const crypto = require('crypto');
const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const { stepHeader, trackSignature, sleep } = require('../../lib/util');

// Only ever redirect to these hosts (exact match or their subdomains).
const ALLOWED_HOSTS = ['adobesign.com', 'forms.monday.com', 'monday.com', 'medwatchers.com', 'example.com'];

const KINDS = {
  sign: {
    step: 8, name: 'Candidate activity', label: 'signing link',
    line: 'The candidate clicked the signing link from the welcome email — the packet is open in front of them.',
    next: `Next → I post here the second the signed packet lands.`,
  },
  form: {
    step: 9, name: 'Candidate activity', label: 'info form link',
    line: 'The candidate clicked the info form link from the welcome email.',
    next: 'Next → the answers sync onto this card the moment the form is submitted.',
  },
  video: {
    step: 7, name: 'Candidate activity', label: 'intro video link',
    line: 'The candidate clicked the intro video link from the welcome email.',
    next: 'Next → nothing to do here; this is visibility only.',
  },
};

function _hostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

function _forbidden(context, reason) {
  logger.warn('trackClick-forbidden', { reason });
  context.res = { status: 403, body: 'Forbidden' };
}

module.exports = async function (context, req) {
  const cfg = config.load();
  const q = (req && req.query) || {};
  const { i: itemId, k: kind, u: encoded, s: sig } = q;

  if (!itemId || !kind || !encoded || !sig) return _forbidden(context, 'missing params');
  const secret = cfg.tracking && cfg.tracking.secret;
  if (!secret) return _forbidden(context, 'no tracking secret configured');

  // Constant-time signature check — a bad sig never redirects anywhere.
  const expected = trackSignature(secret, itemId, kind, encoded);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return _forbidden(context, 'bad signature');
  }

  // Decode + allowlist the destination. https only, known hosts only —
  // even a validly signed URL must not leave the building.
  let target;
  try {
    target = Buffer.from(String(encoded), 'base64url').toString('utf8');
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:' || !_hostAllowed(parsed.hostname)) {
      return _forbidden(context, `destination not allowed: ${parsed.hostname}`);
    }
  } catch (err) {
    return _forbidden(context, `bad target url: ${err.message}`);
  }

  const meta = KINDS[kind] || KINDS.video;
  const needle = `clicked the ${meta.label}`;

  // Best-effort comment: first click per (item, kind) only, capped at 2s so
  // the candidate never waits on Monday. Awaited (never orphaned), but a
  // timeout or failure still redirects.
  try {
    await Promise.race([
      (async () => {
        const already = await monday.hasUpdateContaining(itemId, needle);
        if (already) {
          logger.info('trackClick-dedupe-skip', { itemId, kind });
          return;
        }
        await monday.logAction(itemId,
          stepHeader(meta.step, meta.name)
          + `${meta.line}\n\n`
          + `${meta.next}`,
          `trackClick: first "${kind}" click recorded for item ${itemId}; redirected to ${target}`);
        logger.event('trackClick-comment-posted', { itemId, kind });
      })(),
      sleep(2000).then(() => { throw new Error('comment timeout (2s) — redirecting anyway'); }),
    ]);
  } catch (err) {
    logger.warn('trackClick-comment-best-effort-failed', { itemId, kind, error: err.message });
  }

  context.res = {
    status: 302,
    headers: { Location: target, 'Cache-Control': 'no-store' },
    body: '',
  };
};
