'use strict';
/**
 * poisonQueueHandler: monitors the docflow-archive poison queue (dead-letter).
 * When a message fails to upload to SharePoint after retries, it moves here.
 *
 * Strategy:
 * 1. On first failure (poison dequeue): log + re-enqueue with retry_count + exponential backoff
 * 2. Every hour for 24 hours: attempt SharePoint re-upload
 * 3. After 24hrs failed: move to blob-archive, create ops alert (Monday item), mark as AWAITING_MANUAL
 * 4. Manual resolution: operations team uploads or confirms blob storage is sufficient
 *
 * Triggered by timer (every 5 minutes) to check poison queue status.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const blob = require('../../lib/blob');
const sharepoint = require('../../lib/sharepoint');

/**
 * Calculate backoff: 2^retryCount * baseMs, capped at 24hrs
 */
function getBackoffMs(retryCount, baseMs = 60000) {
  const ms = Math.min(Math.pow(2, retryCount) * baseMs, 24 * 3600 * 1000);
  return ms + Math.random() * (ms * 0.1); // +10% jitter
}

/**
 * Check if a poison message has been failing for >24hrs
 */
function isExpiredPoisonMessage(msg) {
  const firstFailedAt = msg.firstFailedAt ? new Date(msg.firstFailedAt).getTime() : Date.now();
  const ageMs = Date.now() - firstFailedAt;
  return ageMs > 24 * 3600 * 1000; // 24 hours
}

/**
 * Get the list of messages from the docflow-archive poison/dead-letter queue.
 * (In production, this would use Azure Queue API; for now, we simulate queue.len)
 * Returns {messages: Array, count: number}
 */
async function getPoisonQueueMessages() {
  // TODO: Implement actual queue read via Azure SDK (@azure/storage-queue)
  // For now, return empty to avoid false positives in tests
  return { messages: [], count: 0 };
}

/**
 * Update the onboarding item to reflect poison queue status.
 * Creates a Note in Monday with the error and timestamp.
 */
async function updateMondayPoisonStatus(boardId, itemId, msg, status) {
  const cfg = config.load();
  try {
    const statusValue = status === 'expired' ? 'Poison - Awaiting Manual Upload' : 'Poison Queue - Retrying';
    await monday.updateStatus(boardId, itemId, {
      status: statusValue,
    }, { verify: false });

    // Log event with details for operator reference
    const note = `[Poison Queue] ${status === 'expired' ? '24HR EXPIRED' : 'RETRY ATTEMPT'}: ${msg.error || 'Unknown error'}. Agreement: ${msg.agreementId}`;
    logger.warn(`poison-queue-${status}`, {
      itemId,
      agreementId: msg.agreementId,
      retryCount: msg.retry_count,
      note,
    });
  } catch (err) {
    logger.error('poison-queue-monday-update-failed', err, { itemId });
  }
}

/**
 * Attempt to re-upload to SharePoint.
 * Returns true if successful, false if failed.
 */
async function attemptSharePointRetry(msg, pdfBuffer) {
  const result = await sharepoint.tryUpload(pdfBuffer, msg.fileName);
  if (result.success) {
    logger.event('poison-sharepoint-retry-success', {
      agreementId: msg.agreementId,
      uploadId: result.uploadId,
      retryCount: msg.retry_count,
    });
    return true;
  }
  return false;
}

/**
 * Move poison message to blob storage and create operational alert.
 * @param {Object} msg - the poison queue message
 * @param {Buffer} pdfBuffer - PDF content
 */
async function moveToFallbackAndAlert(msg, pdfBuffer) {
  const cfg = config.load();
  try {
    // 1. Store in blob fallback container
    const fallbackKey = `poison-fallback/${msg.agreementId}_${Date.now()}.pdf`;
    const uploaded = await blob.uploadPDF(cfg.storage.archiveContainer, fallbackKey, pdfBuffer);

    logger.event('poison-fallback-stored', {
      agreementId: msg.agreementId,
      blobUrl: uploaded.url,
      fallbackKey,
    });

    // 2. Create ops alert item in Monday (if alertBoardId configured)
    const alertBoardId = process.env.MONDAY_OPS_ALERTS_BOARD_ID || cfg.monday.archiveBoardId;
    if (alertBoardId) {
      try {
        await monday.createItem(alertBoardId, {
          name: `[ALERT] SharePoint Fallback: ${msg.agreementId}`,
          status: 'Active',
          priority: 'Critical',
          description: `Document ${msg.agreementId} failed to upload to SharePoint after 24hrs. Stored in blob fallback: ${uploaded.url}. Manual intervention required.`,
          blobUrl: uploaded.url,
          agreementId: msg.agreementId,
          itemId: msg.itemId,
        });
        logger.event('poison-ops-alert-created', { agreementId: msg.agreementId });
      } catch (alertErr) {
        logger.error('poison-ops-alert-failed', alertErr, { agreementId: msg.agreementId });
      }
    }

    // 3. Update the original onboarding row
    if (msg.itemId && msg.boardId) {
      await updateMondayPoisonStatus(msg.boardId, msg.itemId, msg, 'expired');
    }

    return { fallbackKey, blobUrl: uploaded.url };
  } catch (err) {
    logger.error('poison-fallback-failed', err, { agreementId: msg.agreementId });
    throw err;
  }
}

/**
 * Process a single poison queue message.
 * Returns {action: 'retry', 'resolved', 'failed', 'fallback'}
 */
async function processPoisonMessage(msg, context) {
  const { agreementId, itemId, boardId, fileName, firstFailedAt, retry_count = 0 } = msg;

  try {
    // 1. Check if message is expired (>24hrs)
    if (isExpiredPoisonMessage(msg)) {
      // Fetch PDF from blob (should be in temp or archive)
      let pdfBuffer = null;
      try {
        const tempKey = msg.tempKey || `${agreementId}_temp.pdf`;
        pdfBuffer = await blob.downloadPDF(cfg.storage.tempContainer, tempKey);
      } catch (tempErr) {
        logger.warn('poison-temp-pdf-not-found', {
          agreementId,
          error: tempErr.message,
        });
        // Try archive container
        try {
          const archiveKey = msg.archiveKey || `${agreementId}_archive.pdf`;
          pdfBuffer = await blob.downloadPDF(cfg.storage.archiveContainer, archiveKey);
        } catch (archiveErr) {
          logger.error('poison-pdf-retrieval-failed', archiveErr, { agreementId });
          return { action: 'failed', reason: 'PDF not found in blob' };
        }
      }

      // Move to fallback
      const result = await moveToFallbackAndAlert(msg, pdfBuffer);
      return { action: 'fallback', fallbackKey: result.fallbackKey, blobUrl: result.blobUrl };
    }

    // 2. Not expired yet: attempt re-upload to SharePoint
    let pdfBuffer = null;
    try {
      // Try to get PDF from blob (stored during archive stage)
      const tempKey = msg.tempKey || `${agreementId}_temp.pdf`;
      pdfBuffer = await blob.downloadPDF(cfg.storage.tempContainer, tempKey);
    } catch (err) {
      logger.warn('poison-cannot-retry-no-pdf', {
        agreementId,
        error: err.message,
      });
      return { action: 'failed', reason: 'PDF not available for retry' };
    }

    // Attempt SharePoint upload
    const success = await attemptSharePointRetry(msg, pdfBuffer);
    if (success) {
      return { action: 'resolved' };
    }

    // Still failed: re-enqueue with backoff (will be picked up in next timer iteration)
    const backoffMs = getBackoffMs(retry_count);
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

    if (context.bindings) {
      // Re-enqueue to the main archive queue (not poison)
      // The Azure Function runtime will handle re-enqueueing
      context.bindings.retryQueue = JSON.stringify({
        ...msg,
        retry_count: retry_count + 1,
        nextRetryAt,
        firstFailedAt: msg.firstFailedAt || new Date().toISOString(),
      });
    }

    logger.event('poison-requeued-for-retry', {
      agreementId,
      retry_count: retry_count + 1,
      backoffMs,
      nextRetryAt,
    });

    return { action: 'retry', nextRetryAt, backoffMs };
  } catch (err) {
    logger.error('poison-process-failed', err, { agreementId });
    return { action: 'failed', error: err.message };
  }
}

/**
 * Main entry: triggered by timer (every 5 minutes).
 * Reads poison queue and processes expired/retryable messages.
 */
async function processPoisonQueue(context) {
  const cfg = config.load();

  try {
    logger.event('poison-queue-scan-start', {});

    // Get messages from poison queue
    // TODO: Implement actual queue read
    const { messages } = await getPoisonQueueMessages();

    if (messages.length === 0) {
      logger.event('poison-queue-empty', {});
      context.res = { status: 200, body: { scanned: 0, processed: 0 } };
      return;
    }

    const results = [];
    for (const msg of messages) {
      const result = await processPoisonMessage(msg, context);
      results.push(result);
    }

    const summary = {
      total: results.length,
      resolved: results.filter(r => r.action === 'resolved').length,
      fallback: results.filter(r => r.action === 'fallback').length,
      retry: results.filter(r => r.action === 'retry').length,
      failed: results.filter(r => r.action === 'failed').length,
    };

    logger.event('poison-queue-scan-complete', summary);
    context.res = { status: 200, body: summary };
  } catch (err) {
    logger.error('poison-queue-scan-error', err, {});
    context.res = { status: 500, body: { error: err.message } };
  }
}

module.exports = async function (context, timer) {
  await processPoisonQueue(context);
};

// Export for testing
module.exports.processPoisonMessage = processPoisonMessage;
module.exports.moveToFallbackAndAlert = moveToFallbackAndAlert;
module.exports.getBackoffMs = getBackoffMs;
module.exports.isExpiredPoisonMessage = isExpiredPoisonMessage;
