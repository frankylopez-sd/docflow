'use strict';
/**
 * Monday webhook receiver: checkbox checked on the onboarding board.
 * Validates the signed Authorization JWT, answers Monday's challenge
 * handshake, and enqueues async processing (returns 200 immediately —
 * the docflow-generate queue does the heavy lifting).
 *
 * Error handling strategy:
 * - 401: Signature/JWT validation failures (non-retryable security issues)
 * - 422: Data validation warnings (queued anyway; PDF gen does full validation)
 * - 503: Queue submission failures (Azure will retry based on max delivery attempts)
 * - 500: Unexpected internal errors
 * - 429: Queue rate limiting (intentional back-off)
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const queue = require('../../lib/queue');
const { WebhookError, validateSignature, validateHireData, queueErrorToWebhookError } = require('../../lib/webhookErrors');

/**
 * Core webhook handler.
 * Returns structured result with HTTP status, response body, and queue message.
 *
 * @param {Object} req - Express-like request object
 * @param {Object} mondayRow - Optional pre-fetched Monday row (for data validation)
 * @returns {{
 *   status: number,
 *   body: Object,
 *   queueMessage: Object|null,
 *   retryAfter: number|undefined,
 *   warnings: string[]
 * }}
 */
async function handleWebhook(req, mondayRow = null) {
  const cfg = config.load();
  const body = req.body || {};
  const warnings = [];

  // Monday URL-verification handshake: echo the challenge (standard webhook pattern)
  if (body.challenge) {
    return {
      status: 200,
      body: { challenge: body.challenge },
      queueMessage: null,
      warnings: [],
    };
  }

  // Validate webhook signature (401 if fails)
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || null;
  let claims;
  try {
    const result = validateSignature(auth, cfg.monday.signingSecret);
    claims = result.claims;
  } catch (err) {
    if (err instanceof WebhookError) {
      err.log({ requestPath: req.path || '/api/mondayWebhook' });
      return {
        status: err.response.status,
        body: err.response.body,
        queueMessage: null,
        warnings: [],
      };
    }
    throw err;
  }

  // Rate limit check: reject if queue is overloaded (>threshold pending)
  try {
    const queueName = 'docflow-generate';
    const { overloaded, depth } = await queue.isOverloaded(
      queueName,
      cfg.webhookRateLimitThreshold
    );
    if (overloaded) {
      logger.warn('monday-webhook-rate-limited', {
        queueDepth: depth,
        threshold: cfg.webhookRateLimitThreshold,
      });
      return {
        status: 429,
        body: {
          error: 'service temporarily overloaded',
          queueDepth: depth,
          threshold: cfg.webhookRateLimitThreshold,
        },
        queueMessage: null,
        retryAfter: 60,
        warnings: [],
      };
    }
  } catch (err) {
    // Log but don't fail on rate limit check errors
    logger.warn('monday-webhook-rate-limit-check-failed', {
      error: err.message,
      note: 'Request proceeding despite rate limit check failure',
    });
  }

  // Parse event and extract item ID
  const event = body.event || {};
  const boardId = event.boardId || cfg.monday.onboardingBoardId;
  const itemId = event.pulseId || event.itemId;

  // Silently ignore events with no item ID (malformed Monday event)
  if (!itemId) {
    logger.warn('monday-webhook-no-item', { eventType: event.type, boardId });
    return {
      status: 200,
      body: { ignored: true, reason: 'no itemId', eventType: event.type },
      queueMessage: null,
      warnings: [],
    };
  }

  const isColumnEvent = event.type === 'update_column_value' || event.type === 'change_column_value';

  // Status Exclusion List (anti-recursion): this system writes to the status
  // column itself, and each write re-triggers a Monday webhook. Drop every
  // status-column event immediately with 200 to break the feedback loop.
  if (isColumnEvent && event.columnId === cfg.monday.columns.status) {
    logger.debug('monday-webhook-status-excluded', { itemId, columnId: event.columnId });
    return {
      status: 200,
      body: { ignored: true, reason: 'status column event (exclusion list)' },
      queueMessage: null,
      warnings: [],
    };
  }

  // Welcome blast: a new hire item on the Onboarding board gets an update
  // with the candidate's personalized info-form link, ready for HR to send.
  const isCreateEvent = event.type === 'create_pulse' || event.type === 'create_item';
  if (isCreateEvent) {
    // Dedupe: Monday redelivers on timeout. Look for the welcome marker
    // specifically — other updates (e.g. the ATS import note) must not
    // suppress the welcome packet.
    const alreadyWelcomed = await monday.hasUpdateContaining(itemId, 'Welcome packet ready').catch(() => false);
    if (alreadyWelcomed) {
      return {
        status: 200,
        body: { welcomed: true, itemId: String(itemId), deduped: true },
        queueMessage: null,
        warnings: [],
      };
    }
    const hireName = event.pulseName || event.itemName || '';
    const firstName = String(hireName).trim().split(/\s+/)[0] || 'there';
    const formLink = `${cfg.monday.formSync.formUrl}?name=${encodeURIComponent(hireName)}`;
    await monday.logAction(itemId,
      `👋 Welcome package is prepped and ready to send! Here's a ready-to-go email — just copy, paste, and send it to the candidate:\n\n`
      + `— — — — — — — — — —\n`
      + `Subject: Welcome to MedWatchers, ${firstName}! 🎉\n\n`
      + `Hi ${firstName},\n\n`
      + `Congratulations and welcome to the MedWatchers family! We're so excited to have you.\n\n`
      + `To get your paperwork and first day ready, please fill out this quick 3-minute form:\n${formLink}\n\n`
      + `A couple of things coming your way soon:\n`
      + `  • Your official offer letter to review and sign (arrives by email)\n`
      + `  • A background check consent request — nothing to do until it lands in your inbox\n\n`
      + `Questions anytime — just reply to this email. See you soon!\n\n`
      + `Warmly,\nThe MedWatchers HR Team\n`
      + `— — — — — — — — — —\n\n`
      + `Once they submit the form, their info fills in here on its own and this card moves forward by itself. 💜`
    ).catch((err) => logger.warn('monday-webhook-welcome-post-failed', { itemId, error: err.message }));
    await monday.updateItemStatus(boardId, itemId, cfg.monday.statusLabels.awaitingInfo).catch((err) => {
      logger.warn('monday-webhook-welcome-status-failed', { itemId, error: err.message });
    });
    logger.event('welcome-blast-posted', { itemId, hireName });
    return {
      status: 200,
      body: { welcomed: true, itemId: String(itemId) },
      queueMessage: null,
      warnings: [],
    };
  }

  // HR review gate: offer-status flipped to the approval label → queue signing.
  // Our own offer-status writes (Generating/Ready/Sent) never use the approval
  // label, so this route cannot recurse. Denials and info requests are
  // documented on the item so the decision trail is visible.
  if (isColumnEvent && event.columnId === cfg.monday.columns.offerStatus) {
    const label = (event.value && event.value.label && (event.value.label.text || event.value.label))
      || (typeof event.value === 'string' ? event.value : null);
    if (label === cfg.monday.offerLabels.denied || label === cfg.monday.offerLabels.moreInfo) {
      const denied = label === cfg.monday.offerLabels.denied;
      // The system itself sets ✋ when it can't build the letter — and it has
      // already posted the itemized field list. Don't stack a generic echo on it.
      if (!denied) {
        const alreadyExplained = await monday.hasUpdateContaining(itemId, "Can't build the offer letter").catch(() => false);
        if (alreadyExplained) {
          return { status: 200, body: { documented: true, deduped: true, label, itemId: String(itemId) }, queueMessage: null, warnings: [] };
        }
      }
      await monday.logAction(itemId,
        denied
          ? `🛑 Offer marked Denied — the generated letter will not be sent. Re-generate with "Generate Docs" after changes if needed.`
          : `✋ Offer needs more info before sending. Update the hire fields, then re-check "Generate Docs" to regenerate the letter.`,
        `Offer Letter Status set to "${label}" by a person; automation stopped this offer's routing.`
      ).catch((err) => logger.warn('monday-webhook-denial-post-failed', { itemId, error: err.message }));
      return {
        status: 200,
        body: { documented: true, label, itemId: String(itemId) },
        queueMessage: null,
        warnings: [],
      };
    }
    if (label === cfg.monday.offerLabels.approved) {
      // Guard: approving before a letter exists is the #1 sequence mistake.
      // Explain precisely instead of queueing a doomed send.
      const pdfLink = await monday.getColumnValueJson(boardId, itemId, cfg.monday.columns.pdfUrl).catch(() => null);
      if (!pdfLink || !pdfLink.url) {
        await monday.logAction(itemId,
          `⚠️ Can't send for signature yet — there's no offer letter on this card.\n\n`
          + `WHY (exact): the "PDF Document" column (${cfg.monday.columns.pdfUrl}) is empty — "${cfg.monday.offerLabels.approved}" was selected before the letter was generated.\n\n`
          + `THE ORDER: 1️⃣ fill the hire fields → 2️⃣ check ☑ Generate Docs → 3️⃣ review the PDF ("${cfg.monday.offerLabels.ready}") → 4️⃣ then select "${cfg.monday.offerLabels.approved}".\n\n`
          + `I've reset the offer status — start at ☑ Generate Docs.`
        ).catch(() => {});
        await monday.updateOfferStatus(boardId, itemId, cfg.monday.offerLabels.notStarted).catch(() => {});
        return {
          status: 200,
          body: { blocked: true, reason: 'no generated letter on the item', itemId: String(itemId) },
          queueMessage: null,
          warnings: [],
        };
      }
      logger.event('offer-approved-queueing-sign', { itemId, boardId, label });
      await monday.logAction(itemId,
        `✅ Approval received — the offer is being sent for signature now. No further action needed; this item will update as signers complete.`,
        `Offer Letter Status set to "${label}" by a person; a signing job was queued to docflow-sign.`
      ).catch((err) => logger.warn('monday-webhook-approval-post-failed', { itemId, error: err.message }));
      return {
        status: 200,
        body: { queued: true, itemId: String(itemId), route: 'sign' },
        queueMessage: null,
        signMessage: {
          boardId: String(boardId),
          itemId: String(itemId),
          approvedAt: new Date().toISOString(),
          userId: claims?.userId || claims?.sub || undefined,
        },
        warnings: [],
      };
    }
    logger.debug('monday-webhook-offer-status-ignored', { itemId, label });
    return {
      status: 200,
      body: { ignored: true, reason: 'offer status change is not the approval label' },
      queueMessage: null,
      warnings: [],
    };
  }

  // STRICT routing: only the trigger checkbox being CHECKED queues generation.
  // Any other event type or column is acknowledged and dropped — unknown
  // events must never start the pipeline (blueprint: idempotent state machine).
  const isTriggerColumn = !event.columnId || event.columnId === cfg.monday.columns.trigger;
  const checked = event.value && (event.value.checked === true || event.value.checked === 'true');

  if (!isColumnEvent || !isTriggerColumn || !checked) {
    logger.debug('monday-webhook-ignored', {
      itemId,
      eventType: event.type,
      columnId: event.columnId,
      triggerColumn: cfg.monday.columns.trigger,
      checked: checked ? 'true' : 'false',
    });
    return {
      status: 200,
      body: {
        ignored: true,
        reason: isColumnEvent ? 'not trigger checkbox checked' : 'unrecognized event type',
      },
      queueMessage: null,
      warnings: [],
    };
  }

  // Optionally validate hire data before queuing (422 if incomplete, but still queue)
  if (mondayRow && cfg.monday.validateDataBeforeQueue) {
    const dataValidation = validateHireData(mondayRow, cfg.monday.columns);
    if (!dataValidation.allValid) {
      warnings.push(...dataValidation.warnings);
      logger.warn('monday-webhook-incomplete-data', {
        itemId,
        warnings: dataValidation.warnings,
        note: 'Message still queued; PDF generation will perform full validation',
      });
      // Return 422 but still queue the message
    }
  }

  // Build queue message for async PDF generation
  const queueMessage = {
    boardId: String(boardId),
    itemId: String(itemId),
    eventType: event.type || 'unknown',
    receivedAt: new Date().toISOString(),
    userId: claims?.userId || claims?.sub || undefined, // for audit trail
  };

  logger.event('onboarding-request-queued', {
    itemId,
    boardId,
    eventType: event.type,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  return {
    status: warnings.length > 0 ? 422 : 200,
    body: warnings.length > 0
      ? {
          queued: true,
          itemId: String(itemId),
          warning: 'incomplete hire data',
          note: 'Message queued; PDF generation will validate fully',
        }
      : { queued: true, itemId: String(itemId) },
    queueMessage,
    warnings,
  };
}

/**
 * Azure Function entry point.
 * Sets context.bindings.generateQueue for the queue output binding.
 * Handles both successful and failed requests.
 */
module.exports = async function (context, req) {
  let handleError = null;

  try {
    // Call the core handler
    const result = await handleWebhook(req);

    // If there's a queue message, bind it to the output queue
    if (result.queueMessage) {
      try {
        context.bindings.generateQueue = JSON.stringify(result.queueMessage);
      } catch (err) {
        // Queue binding failure (503, will retry)
        handleError = queueErrorToWebhookError(err);
      }
    }

    // HR approval route: bind the signing message to the sign queue
    if (result.signMessage) {
      try {
        context.bindings.signQueue = JSON.stringify(result.signMessage);
      } catch (err) {
        handleError = queueErrorToWebhookError(err);
      }
    }

    // Set HTTP response
    if (handleError) {
      handleError.log({ itemId: req?.body?.event?.itemId });
      const response = handleError.getResponse();
      context.res = {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: response.body,
      };
    } else {
      context.res = {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
        body: result.body,
      };
      if (result.retryAfter) {
        context.res.headers['Retry-After'] = result.retryAfter.toString();
      }
    }
  } catch (err) {
    // Unexpected error (500)
    if (err instanceof WebhookError) {
      err.log({ phase: 'main-handler', retryable: err.isRetryable() });
      const response = err.getResponse();
      context.res = {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: response.body,
      };
    } else {
      // Completely unexpected error
      logger.error('monday-webhook-unexpected-error', err, {
        message: err?.message,
        code: err?.code,
        stack: err?.stack,
      });

      // Attempt to surface the error on the board for HR visibility
      try {
        const cfg = config.load();
        const itemId = req?.body?.event?.itemId || req?.body?.event?.pulseId;
        if (itemId) {
          await monday.updateStatus(
            cfg.monday.onboardingBoardId,
            itemId,
            { status: 'Webhook Error' },
            { verify: false }
          );
        }
      } catch (inner) {
        logger.error('monday-webhook-error-status-write-failed', inner, {
          itemId: req?.body?.event?.itemId,
        });
      }

      context.res = {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'internal server error', traceId: context.traceContext?.traceparent },
      };
    }
  }
};

// Exports for testing
module.exports.handleWebhook = handleWebhook;
