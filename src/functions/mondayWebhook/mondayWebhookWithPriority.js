'use strict';
/**
 * Enhanced Monday Webhook with Priority Routing
 *
 * This is an ALTERNATIVE implementation of the standard mondayWebhook
 * that integrates with the priority queue system.
 *
 * Differences from standard webhook:
 * - Reads Monday item data to determine priority
 * - Routes high-priority (VP/executive) to dedicated queue
 * - Routes normal to standard queue
 * - Routes low-priority (batch) to background queue
 * - Automatic starvation prevention
 *
 * Use either:
 * 1. Standard mondayWebhook (direct to docflow-generate)
 * 2. This enhanced version (routes by priority)
 * But NOT both on same board.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const priorityQueue = require('../../lib/priorityQueueService');
const { WebhookError, validateSignature, queueErrorToWebhookError } = require('../../lib/webhookErrors');

/**
 * Core webhook handler with priority support.
 * Returns structured result with HTTP status and queue routing info.
 */
async function handleWebhookWithPriority(req, mondayRow = null) {
  const cfg = config.load();
  const body = req.body || {};

  // Monday URL-verification handshake
  if (body.challenge) {
    return {
      status: 200,
      body: { challenge: body.challenge },
      queueMessages: [],
    };
  }

  // Validate webhook signature
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
        queueMessages: [],
      };
    }
    throw err;
  }

  // Check for rate limiting on ALL priority queues combined
  try {
    const depths = await priorityQueue.getAllQueueDepths();
    const totalDepth = depths.total;
    const threshold = cfg.webhookRateLimitThreshold || 1000;

    if (totalDepth >= threshold) {
      logger.warn('monday-webhook-priority-rate-limited', {
        totalDepth,
        threshold,
        breakdown: { high: depths.high, normal: depths.normal, low: depths.low },
      });
      return {
        status: 429,
        body: {
          error: 'service temporarily overloaded',
          totalQueueDepth: totalDepth,
          threshold,
          breakdown: { high: depths.high, normal: depths.normal, low: depths.low },
        },
        queueMessages: [],
        retryAfter: 60,
      };
    }
  } catch (err) {
    logger.warn('monday-webhook-priority-rate-limit-check-failed', {
      error: err.message,
    });
    // Continue on error (fail open)
  }

  // Extract event and item ID
  const event = body.event || {};
  const boardId = event.boardId || cfg.monday.onboardingBoardId;
  const itemId = event.pulseId || event.itemId;

  // Ignore events without item ID
  if (!itemId) {
    logger.warn('monday-webhook-priority-no-item', { eventType: event.type, boardId });
    return {
      status: 200,
      body: { ignored: true, reason: 'no itemId' },
      queueMessages: [],
    };
  }

  // Only process trigger checkbox being checked
  const isColumnEvent = event.type === 'update_column_value' || event.type === 'change_column_value';
  const isTriggerColumn = !event.columnId || event.columnId === cfg.monday.columns.trigger;
  const checked = event.value && (event.value.checked === true || event.value.checked === 'true');

  if (isColumnEvent && (!isTriggerColumn || !checked)) {
    logger.debug('monday-webhook-priority-ignored', {
      itemId,
      eventType: event.type,
      checked: checked ? 'true' : 'false',
    });
    return {
      status: 200,
      body: { ignored: true, reason: 'not trigger checkbox checked' },
      queueMessages: [],
    };
  }

  // Fetch Monday row to determine priority
  let row;
  if (!mondayRow) {
    try {
      row = await monday.readRow(boardId, itemId);
    } catch (err) {
      logger.warn('monday-webhook-priority-read-failed', {
        itemId,
        error: err.message,
        note: 'Defaulting to normal priority'
      });
      // Fail open: use normal priority
      row = {
        itemId,
        name: `Item ${itemId}`,
        boardId,
        byTitle: {}
      };
    }
  } else {
    row = mondayRow;
  }

  // Determine priority
  const priority = priorityQueue.determinePriority(row);

  // Build queue message
  const queueMessage = {
    boardId: String(boardId),
    itemId: String(itemId),
    eventType: event.type || 'unknown',
    receivedAt: new Date().toISOString(),
    userId: claims?.userId || claims?.sub || undefined,
    priority, // Include for downstream processing
  };

  // Log routing decision
  logger.event('monday-webhook-priority-queued', {
    itemId,
    boardId,
    priority,
    employee: row.name,
    position: row.byTitle?.Position || 'Unknown',
    eventType: event.type,
  });

  return {
    status: 200,
    body: {
      queued: true,
      itemId: String(itemId),
      priority,
      employee: row.name,
    },
    queueMessages: [{ message: queueMessage, priority }],
  };
}

/**
 * Azure Function entry point.
 * Routes message to the appropriate priority queue via output binding.
 */
module.exports = async function (context, req) {
  let handleError = null;

  try {
    const result = await handleWebhookWithPriority(req);

    // Route each queued message to appropriate priority queue
    if (result.queueMessages && result.queueMessages.length > 0) {
      try {
        for (const { message, priority } of result.queueMessages) {
          const routing = await priorityQueue.routeMessage(message, priority);

          // Set output binding for this queue
          context.bindings[routing.binding] = routing.message;

          logger.event('monday-webhook-priority-message-bound', {
            itemId: message.itemId,
            binding: routing.binding,
            queueName: routing.queueName,
            priority: routing.priority
          });
        }
      } catch (err) {
        handleError = queueErrorToWebhookError(err);
      }
    }

    // Set HTTP response
    if (handleError) {
      handleError.log({ itemId: req.body?.event?.itemId });
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
    if (err instanceof WebhookError) {
      err.log({ phase: 'main-handler' });
      const response = err.getResponse();
      context.res = {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: response.body,
      };
    } else {
      logger.error('monday-webhook-priority-unexpected-error', err, {
        message: err?.message,
        stack: err?.stack,
      });

      context.res = {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: {
          error: 'Internal server error',
          message: err?.message,
        },
      };
    }
  }
};

// Export for testing
module.exports.handleWebhookWithPriority = handleWebhookWithPriority;
