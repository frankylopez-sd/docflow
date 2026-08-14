'use strict';
/**
 * Azure Storage Queue management: depth checking, rate limiting, metrics.
 * Provides queue depth inspection for rate limiting webhooks.
 * Uses shared-key auth when a key is configured, otherwise managed identity.
 */

const { QueueServiceClient, StorageSharedKeyCredential } = require('@azure/storage-queue');
const config = require('./config');
const logger = require('./logger');

const _clients = {}; // accountName -> client

function _getClient(accountName, accountKey) {
  if (_clients[accountName]) return _clients[accountName];
  const url = `https://${accountName}.queue.core.windows.net`;
  let client;
  if (accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    client = new QueueServiceClient(url, credential);
  } else {
    // Managed identity path (Azure)
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
 * Get the approximate message count in a queue.
 * Uses QueueServiceClient to peek at queue properties.
 * @param {string} queueName - Name of the queue
 * @returns {Promise<number>} Approximate number of messages
 */
async function getQueueDepth(queueName) {
  if (!queueName || typeof queueName !== 'string') {
    throw new Error('getQueueDepth: queueName must be a non-empty string');
  }

  try {
    const client = _primary();
    const queueClient = client.getQueueClient(queueName);
    const properties = await queueClient.getProperties();
    const depth = properties.approximateMessagesCount || 0;
    logger.event('queue-depth-checked', { queueName, depth });
    return depth;
  } catch (err) {
    // If queue doesn't exist or we can't check it, log and return 0
    // (fail open: allow the request through)
    logger.warn('queue-depth-check-failed', { queueName, error: err.message });
    return 0;
  }
}

/**
 * Check if the queue is overloaded and should reject new requests.
 * @param {string} queueName - Name of the queue
 * @param {number} limit - Maximum allowed queue depth (default 1000)
 * @returns {Promise<{overloaded: boolean, depth: number}>}
 */
async function isOverloaded(queueName, limit = 1000) {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('isOverloaded: limit must be a positive number');
  }

  try {
    const depth = await getQueueDepth(queueName);
    const overloaded = depth >= limit;
    if (overloaded) {
      logger.warn('queue-overloaded', {
        queueName,
        depth,
        limit,
        utilization: Math.round((depth / limit) * 100),
      });
    }
    return { overloaded, depth };
  } catch (err) {
    // Fail open: allow through on error
    logger.warn('queue-overload-check-failed', { queueName, error: err.message });
    return { overloaded: false, depth: 0 };
  }
}

/**
 * Get queue properties and statistics.
 * @param {string} queueName - Name of the queue
 * @returns {Promise<Object>} Queue metadata
 */
async function getQueueStats(queueName) {
  if (!queueName || typeof queueName !== 'string') {
    throw new Error('getQueueStats: queueName must be a non-empty string');
  }

  try {
    const client = _primary();
    const queueClient = client.getQueueClient(queueName);
    const properties = await queueClient.getProperties();
    return {
      name: queueName,
      depth: properties.approximateMessagesCount || 0,
      metadata: properties.metadata || {},
      createdOn: properties.createdOn,
      lastModified: properties.lastModified,
    };
  } catch (err) {
    logger.warn('queue-stats-failed', { queueName, error: err.message });
    return { name: queueName, depth: 0, metadata: {}, error: err.message };
  }
}

module.exports = {
  getQueueDepth,
  isOverloaded,
  getQueueStats,
  _resetState,
};
