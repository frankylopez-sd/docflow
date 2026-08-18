'use strict';
/**
 * Priority Routing Function: Routes onboarding requests to appropriate priority queue.
 *
 * Triggered by: Monday webhook (same as mondayWebhook)
 * Outputs to: High/normal/low priority queues based on employee profile
 *
 * Enhancements over basic mondayWebhook:
 * - Reads Monday item to determine priority
 * - Routes to high/normal/low queue based on role/position
 * - Monitors individual queue depths
 * - Prevents starvation with age-based promotion
 * - Reports queue health metrics
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const priorityQueue = require('../../lib/priorityQueueService');
const { WebhookError, validateSignature, queueErrorToWebhookError } = require('../../lib/webhookErrors');

/**
 * Core priority routing handler.
 * @param {Object} req - Express-like request object
 * @returns {{
 *   status: number,
 *   body: Object,
 *   queueMessage: Object|null,
 *   routingInfo: Object|null,
 *   retryAfter: number|undefined
 * }}
 */
async function handlePriorityRouting(req) {
  const cfg = config.load();
  const body = req.body || {};

  // Monday URL-verification handshake
  if (body.challenge) {
    return {
      status: 200,
      body: { challenge: body.challenge },
      queueMessage: null,
      routingInfo: null,
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
      err.log({ requestPath: req.path || '/api/priorityRouting' });
      return {
        status: err.response.status,
        body: err.response.body,
        queueMessage: null,
        routingInfo: null,
      };
    }
    throw err;
  }

  // Extract event and item ID
  const event = body.event || {};
  const boardId = event.boardId || cfg.monday.onboardingBoardId;
  const itemId = event.pulseId || event.itemId;

  // Ignore events without item ID
  if (!itemId) {
    logger.warn('priority-routing-no-item', { eventType: event.type, boardId });
    return {
      status: 200,
      body: { ignored: true, reason: 'no itemId' },
      queueMessage: null,
      routingInfo: null,
    };
  }

  // Only process trigger checkbox being checked
  const isColumnEvent = event.type === 'update_column_value' || event.type === 'change_column_value';
  const isTriggerColumn = !event.columnId || event.columnId === cfg.monday.columns.trigger;
  const checked = event.value && (event.value.checked === true || event.value.checked === 'true');

  if (isColumnEvent && (!isTriggerColumn || !checked)) {
    logger.debug('priority-routing-ignored', {
      itemId,
      eventType: event.type,
      columnId: event.columnId,
      checked: checked ? 'true' : 'false',
    });
    return {
      status: 200,
      body: { ignored: true, reason: 'not trigger checkbox checked' },
      queueMessage: null,
      routingInfo: null,
    };
  }

  // Fetch Monday row to determine priority
  let mondayRow;
  try {
    mondayRow = await monday.readRow(boardId, itemId);
  } catch (err) {
    logger.warn('priority-routing-monday-read-failed', {
      itemId,
      boardId,
      error: err.message,
      note: 'Defaulting to normal priority'
    });
    // Fail open: continue with normal priority
    mondayRow = { itemId, name: `Item ${itemId}`, byTitle: {} };
  }

  // Determine priority based on Monday data
  const priority = priorityQueue.determinePriority(mondayRow);

  // Check queue depth before routing
  let routingInfo = {
    priority,
    itemId: String(itemId),
    employee: mondayRow.name,
  };

  try {
    const depths = await priorityQueue.getAllQueueDepths();
    routingInfo.queueDepths = depths;

    const { overloaded } = await priorityQueue.isPriorityOverloaded(priority);
    if (overloaded) {
      logger.warn('priority-routing-queue-overloaded', {
        priority,
        itemId,
        depth: depths[priority]
      });
      // Continue anyway but note in response
      routingInfo.queueWarning = `${priority} queue at capacity`;
    }
  } catch (err) {
    logger.warn('priority-routing-queue-check-failed', {
      priority,
      error: err.message
    });
    // Continue on queue check failure
  }

  // Build queue message with priority metadata
  const queueMessage = {
    boardId: String(boardId),
    itemId: String(itemId),
    eventType: event.type || 'unknown',
    receivedAt: new Date().toISOString(),
    userId: claims?.userId || claims?.sub || undefined,
    employee: mondayRow.name,
    priority, // Include priority for awareness in downstream processors
  };

  logger.event('priority-routing-request-queued', {
    itemId,
    boardId,
    priority,
    employee: mondayRow.name,
    position: mondayRow.byTitle?.Position || 'Unknown',
    eventType: event.type,
  });

  return {
    status: 200,
    body: {
      queued: true,
      itemId: String(itemId),
      priority,
      employee: mondayRow.name,
      queueDepths: routingInfo.queueDepths,
    },
    queueMessage,
    routingInfo,
  };
}

/**
 * Azure Function entry point.
 * Supports multiple output bindings for priority queues.
 */
module.exports = async function (context, req) {
  let handleError = null;

  try {
    const result = await handlePriorityRouting(req);

    // Route message to appropriate queue based on priority
    if (result.queueMessage) {
      try {
        const routing = await priorityQueue.routeMessage(
          result.queueMessage,
          result.queueMessage.priority
        );

        // Set the appropriate queue output binding
        context.bindings[routing.binding] = routing.message;

        logger.event('priority-routing-message-bound', {
          itemId: result.queueMessage.itemId,
          binding: routing.binding,
          queueName: routing.queueName,
          priority: routing.priority
        });

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
      logger.error('priority-routing-unexpected-error', err, {
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
