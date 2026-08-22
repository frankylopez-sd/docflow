'use strict';
/**
 * poisonDrain: 30-minute observability sweep for poison queues (finding A57).
 *
 * Azure Queues move a message to "<queue>-poison" after maxDequeueCount
 * failures. Nothing consumed those queues before this — they filled silently,
 * so a hung dependency looked like calm. This timer inspects every known
 * poison queue's depth and raises a loud alert event when any of them holds a
 * message, giving ops a single signal to act on. It never mutates a queue;
 * inspection only. If the queue SDK can't be reached (no connection, transient
 * error), it logs 'poison-drain-check' with a note and exits cleanly — a
 * monitoring gap must never crash the host.
 */

const logger = require('../../lib/logger');
const queue = require('../../lib/queue');

// The live application queues; their poison siblings are "<name>-poison".
const SOURCE_QUEUES = [
  'docflow-generate',
  'docflow-generate-high',
  'docflow-generate-batch',
  'docflow-archive',
  'docflow-sign',
  'sharepoint-upload-queue',
  'sharepoint-uploads',
];

/** Inspect every poison queue's depth. @returns {Promise<Object>} run summary */
async function drainPoisonQueues() {
  const summary = { checked: 0, totalPoison: 0, alerts: [], errors: 0 };

  for (const source of SOURCE_QUEUES) {
    const poisonQueue = `${source}-poison`;
    try {
      const depth = await queue.getQueueDepth(poisonQueue);
      summary.checked++;
      if (depth > 0) {
        summary.totalPoison += depth;
        summary.alerts.push({ queue: poisonQueue, depth });
        // Loud, per-queue alert so an alert rule can fire on it.
        logger.event('poison-queue-alert', {
          queue: poisonQueue,
          depth,
          note: `${depth} message(s) stuck in ${poisonQueue} — a dependency is failing repeatedly. Inspect and drain.`,
        });
      }
    } catch (err) {
      // Can't inspect (no SDK/connection) — log the gap, never throw.
      summary.errors++;
      logger.warn('poison-drain-check', {
        queue: poisonQueue,
        note: 'could not inspect poison queue depth',
        error: err && err.message,
      });
    }
  }

  logger.event('poison-drain-run', summary);
  return summary;
}

module.exports = async function (context, timer) {
  if (timer && timer.isPastDue) logger.warn('poison-drain-past-due');
  try {
    await drainPoisonQueues();
  } catch (err) {
    // Belt-and-suspenders: a monitoring sweep must never crash the host.
    logger.warn('poison-drain-check', { note: 'poison-drain sweep failed', error: err && err.message });
  }
};

module.exports.drainPoisonQueues = drainPoisonQueues;
module.exports.SOURCE_QUEUES = SOURCE_QUEUES;
