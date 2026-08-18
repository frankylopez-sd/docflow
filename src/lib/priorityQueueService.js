'use strict';
/**
 * Priority Queue Service: manages high/normal/low priority queues for document automation.
 *
 * Features:
 * - Dynamic priority routing (VP/executive vs regular vs batch imports)
 * - Age-based dynamic reordering to prevent starvation
 * - Queue depth monitoring per priority level
 * - Automatic promotion of aged low-priority items
 *
 * Queue structure:
 * - docflow-generate-high: VP/executive hires (same-day processing)
 * - docflow-generate: Regular hires (standard timeline)
 * - docflow-generate-batch: Batch imports (off-peak processing)
 */

const { QueueServiceClient, StorageSharedKeyCredential } = require('@azure/storage-queue');
const config = require('./config');
const logger = require('./logger');

const QUEUE_CONFIG = {
  high: {
    name: 'docflow-generate-high',
    basePriority: 1,
    ttlMinutes: 60, // VP hires processed same-day
    workerCount: 2,
    description: 'VP/executive hires (immediate processing)'
  },
  normal: {
    name: 'docflow-generate',
    basePriority: 2,
    ttlMinutes: 480, // 8 hours for normal processing
    workerCount: 4,
    description: 'Regular employee hires (standard timeline)'
  },
  low: {
    name: 'docflow-generate-batch',
    basePriority: 3,
    ttlMinutes: 1440, // 24 hours for batch imports
    workerCount: 1,
    description: 'Batch imports and background processing'
  }
};

// Promotion thresholds for starvation prevention
const PROMOTION_THRESHOLDS = {
  lowToNormal: 30 * 60 * 1000, // 30 minutes in low queue → promote to normal
  normalToHigh: 60 * 60 * 1000, // 60 minutes in normal queue → promote to high
};

const _clients = {}; // accountName -> client

function _getClient(accountName, accountKey) {
  if (_clients[accountName]) return _clients[accountName];
  const url = `https://${accountName}.queue.core.windows.net`;
  let client;
  if (accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    client = new QueueServiceClient(url, credential);
  } else {
    const { DefaultAzureCredential } = require('@azure/identity');
    client = new QueueServiceClient(url, new DefaultAzureCredential());
  }
  _clients[accountName] = client;
  return client;
}

function _primary() {
  const cfg = config.load();
  return _getClient(cfg.storage.accountName, cfg.storage.accountKey);
}

function _resetState() {
  for (const k of Object.keys(_clients)) delete _clients[k];
}

/**
 * Determine priority level based on Monday item data.
 *
 * Priority Logic:
 * - HIGH: VP or C-suite executives, special circumstances
 * - NORMAL: Regular employees (default)
 * - LOW: Batch imports, background processes
 *
 * @param {Object} mondayRow - Monday item with columns
 * @param {string} mondayRow.byTitle - Column values by title
 * @returns {string} 'high', 'normal', or 'low'
 */
function determinePriority(mondayRow = {}) {
  const { byTitle = {} } = mondayRow;

  // High priority indicators
  const position = (byTitle.Position || '').toLowerCase();
  const isExecutive = /^(vp|vice president|ceo|cfo|cto|coo|evp|executive vice|president|chief)/i.test(position);

  // Check for explicit priority override in Monday
  const priorityOverride = (byTitle.Priority || '').toLowerCase();
  if (priorityOverride === 'high' || priorityOverride === 'urgent' || priorityOverride === 'vip') {
    return 'high';
  }

  if (isExecutive) {
    logger.event('priority-executive-detected', {
      position,
      employee: mondayRow.name
    });
    return 'high';
  }

  // Low priority indicators (batch processing)
  const isBatch = (byTitle['Batch Import'] || '').toLowerCase() === 'true';
  if (isBatch) {
    logger.event('priority-batch-detected', {
      employee: mondayRow.name
    });
    return 'low';
  }

  // Default to normal
  return 'normal';
}

/**
 * Get queue depth for a priority level.
 * @param {string} priority - 'high', 'normal', or 'low'
 * @returns {Promise<number>} Approximate queue depth
 */
async function getQueueDepth(priority = 'normal') {
  if (!QUEUE_CONFIG[priority]) {
    throw new Error(`Invalid priority level: ${priority}`);
  }

  const queueName = QUEUE_CONFIG[priority].name;

  try {
    const client = _primary();
    const queueClient = client.getQueueClient(queueName);
    const properties = await queueClient.getProperties();
    const depth = properties.approximateMessagesCount || 0;

    logger.event('priority-queue-depth-checked', {
      priority,
      queueName,
      depth
    });

    return depth;
  } catch (err) {
    logger.warn('priority-queue-depth-check-failed', {
      priority,
      queueName,
      error: err.message
    });
    return 0;
  }
}

/**
 * Get depth for all priority queues.
 * @returns {Promise<Object>} {high: number, normal: number, low: number, total: number}
 */
async function getAllQueueDepths() {
  try {
    const depths = {};
    let total = 0;

    for (const [priority, config] of Object.entries(QUEUE_CONFIG)) {
      depths[priority] = await getQueueDepth(priority);
      total += depths[priority];
    }

    depths.total = total;
    return depths;
  } catch (err) {
    logger.error('priority-queue-depths-batch-failed', err);
    return { high: 0, normal: 0, low: 0, total: 0 };
  }
}

/**
 * Check if a priority queue is overloaded.
 * @param {string} priority - 'high', 'normal', or 'low'
 * @param {number} limit - Max allowed depth
 * @returns {Promise<{overloaded: boolean, depth: number, priority: string}>}
 */
async function isPriorityOverloaded(priority = 'normal', limit) {
  if (!QUEUE_CONFIG[priority]) {
    throw new Error(`Invalid priority level: ${priority}`);
  }

  try {
    const depth = await getQueueDepth(priority);
    // Use priority-specific limit or provided limit
    const threshold = limit || (priority === 'high' ? 50 : priority === 'normal' ? 500 : 1000);
    const overloaded = depth >= threshold;

    if (overloaded) {
      logger.warn('priority-queue-overloaded', {
        priority,
        depth,
        threshold,
        utilization: Math.round((depth / threshold) * 100)
      });
    }

    return { overloaded, depth, priority };
  } catch (err) {
    logger.warn('priority-queue-overload-check-failed', {
      priority,
      error: err.message
    });
    return { overloaded: false, depth: 0, priority };
  }
}

/**
 * Route a message to the appropriate queue based on priority.
 * Integrates with Azure Function output bindings via return object.
 *
 * @param {Object} queueMessage - Message to enqueue
 * @param {string} priority - 'high', 'normal', or 'low' (optional, auto-detected)
 * @returns {Promise<{queueName: string, priority: string, binding: string, message: string}>}
 */
async function routeMessage(queueMessage, priority = null) {
  if (!queueMessage) {
    throw new Error('routeMessage: queueMessage required');
  }

  // Auto-detect priority if not specified
  const actualPriority = priority || 'normal';

  if (!QUEUE_CONFIG[actualPriority]) {
    throw new Error(`Invalid priority: ${actualPriority}`);
  }

  // Check if target queue is overloaded and can fallback
  const { overloaded } = await isPriorityOverloaded(actualPriority);

  let targetPriority = actualPriority;

  // Intelligent fallback for overloaded queues
  if (overloaded && actualPriority === 'high') {
    logger.warn('priority-queue-fallback', {
      from: 'high',
      to: 'normal',
      reason: 'high queue overloaded'
    });
    targetPriority = 'normal';
  } else if (overloaded && actualPriority === 'normal') {
    logger.warn('priority-queue-fallback', {
      from: 'normal',
      to: 'low',
      reason: 'normal queue overloaded'
    });
    targetPriority = 'low';
  }

  const config = QUEUE_CONFIG[targetPriority];
  const messageWithMetadata = {
    ...queueMessage,
    _priority: targetPriority,
    _enqueuedAt: new Date().toISOString(),
    _promotedFrom: actualPriority !== targetPriority ? actualPriority : undefined
  };

  const messageJson = JSON.stringify(messageWithMetadata);

  logger.event('priority-message-routed', {
    priority: targetPriority,
    queueName: config.name,
    itemId: queueMessage.itemId,
    fromPriority: actualPriority !== targetPriority ? actualPriority : undefined
  });

  return {
    queueName: config.name,
    priority: targetPriority,
    binding: `generateQueue${targetPriority.charAt(0).toUpperCase() + targetPriority.slice(1)}`, // e.g., generateQueueHigh
    message: messageJson
  };
}

/**
 * Process a message with priority awareness.
 * Called by processor functions to dequeue and process items.
 *
 * @param {string} messageText - Queue message content
 * @param {string} priority - Priority level being processed
 * @returns {Promise<{processed: boolean, message: Object, shouldPromote: boolean}>}
 */
async function processMessage(messageText, priority = 'normal') {
  if (!messageText || typeof messageText !== 'string') {
    throw new Error('processMessage: messageText required');
  }

  let message;
  try {
    message = JSON.parse(messageText);
  } catch (err) {
    logger.error('priority-message-parse-failed', err, { messageText: messageText.slice(0, 100) });
    return { processed: false, message: null, shouldPromote: false };
  }

  // Calculate message age
  const enqueuedAt = new Date(message._enqueuedAt || message.receivedAt || new Date());
  const ageMs = Date.now() - enqueuedAt.getTime();

  // Determine if message should be promoted (starvation prevention)
  let shouldPromote = false;
  if (priority === 'low' && ageMs > PROMOTION_THRESHOLDS.lowToNormal) {
    shouldPromote = true;
    logger.event('priority-promotion-low-to-normal', {
      itemId: message.itemId,
      ageMinutes: Math.round(ageMs / 60000)
    });
  } else if (priority === 'normal' && ageMs > PROMOTION_THRESHOLDS.normalToHigh) {
    shouldPromote = true;
    logger.event('priority-promotion-normal-to-high', {
      itemId: message.itemId,
      ageMinutes: Math.round(ageMs / 60000)
    });
  }

  return {
    processed: true,
    message,
    shouldPromote,
    ageMs,
    priority
  };
}

/**
 * Promote a message to a higher priority queue.
 * Used when starvation is detected.
 *
 * @param {Object} message - Original message
 * @param {string} fromPriority - Current priority
 * @param {string} toPriority - Target priority
 * @returns {Promise<{success: boolean, newQueueName: string, message: string}>}
 */
async function promoteMessage(message, fromPriority, toPriority) {
  if (!QUEUE_CONFIG[fromPriority] || !QUEUE_CONFIG[toPriority]) {
    throw new Error(`Invalid priority levels: ${fromPriority} -> ${toPriority}`);
  }

  const promotedMessage = {
    ...message,
    _priority: toPriority,
    _promotedFrom: fromPriority,
    _promotedAt: new Date().toISOString(),
    _previousEnqueuedAt: message._enqueuedAt || message.receivedAt
  };

  logger.event('priority-message-promoted', {
    itemId: message.itemId,
    from: fromPriority,
    to: toPriority,
    ageMinutes: message._ageMinutes || 0
  });

  return {
    success: true,
    newQueueName: QUEUE_CONFIG[toPriority].name,
    message: JSON.stringify(promotedMessage)
  };
}

/**
 * Get priority metrics for all queues.
 * @returns {Promise<Object>} Detailed metrics by priority
 */
async function getMetrics() {
  try {
    const depths = await getAllQueueDepths();
    const metrics = {
      timestamp: new Date().toISOString(),
      queues: {},
      summary: {
        total: depths.total,
        highPriority: depths.high,
        normalPriority: depths.normal,
        lowPriority: depths.low,
        avgResponseTime: 'TODO', // Can be enhanced with tracking
        processingRate: 'TODO'
      }
    };

    for (const [priority, config] of Object.entries(QUEUE_CONFIG)) {
      metrics.queues[priority] = {
        name: config.name,
        depth: depths[priority],
        basePriority: config.basePriority,
        ttlMinutes: config.ttlMinutes,
        workerCount: config.workerCount,
        description: config.description,
        utilizationPercent: Math.round((depths[priority] / 500) * 100) // 500 as base capacity
      };
    }

    return metrics;
  } catch (err) {
    logger.error('priority-metrics-failed', err);
    return {
      timestamp: new Date().toISOString(),
      error: err.message,
      queues: {},
      summary: {}
    };
  }
}

/**
 * Health check for priority queue system.
 * @returns {Promise<{healthy: boolean, issues: Array}>}
 */
async function healthCheck() {
  const issues = [];

  try {
    const depths = await getAllQueueDepths();

    // Check for overloaded high-priority queue
    if (depths.high > 50) {
      issues.push(`High-priority queue overloaded: ${depths.high} pending`);
    }

    // Check for backed-up normal queue
    if (depths.normal > 500) {
      issues.push(`Normal queue at capacity: ${depths.normal} pending`);
    }

    // Check for starving low-priority queue
    if (depths.low > 1000) {
      issues.push(`Low-priority queue backed up: ${depths.low} pending`);
    }

  } catch (err) {
    issues.push(`Health check failed: ${err.message}`);
  }

  return {
    healthy: issues.length === 0,
    issues,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  // Configuration
  QUEUE_CONFIG,
  PROMOTION_THRESHOLDS,

  // Core operations
  determinePriority,
  routeMessage,
  processMessage,
  promoteMessage,

  // Queue management
  getQueueDepth,
  getAllQueueDepths,
  isPriorityOverloaded,

  // Monitoring
  getMetrics,
  healthCheck,

  // Internal
  _resetState,
};
