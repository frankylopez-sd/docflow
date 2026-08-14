'use strict';
/**
 * EventSourcing: Immutable event log for DocFlow jobs.
 *
 * Every step in the document lifecycle (create, generate, sign, archive, etc.)
 * is recorded as an immutable event in Azure Blob Storage. Events are indexed
 * by jobId for easy querying and replay.
 *
 * Storage structure:
 *  - events/{jobId}/{timestamp}-{sequence}-{eventType}.json
 *  - events-index/{jobId}.json (metadata: count, lastUpdate, stateSnapshot)
 *
 * Features:
 *  - Write: create immutable timestamped events
 *  - Query: list all events for a jobId, paginated
 *  - Replay: reconstruct state from events[N:M]
 *  - Stream: real-time event hooks (webhooks, bus)
 */

const crypto = require('crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const config = require('./config');
const logger = require('./logger');
const { retry } = require('./util');

const EVENTS_CONTAINER = 'events';
const INDEX_CONTAINER = 'events-index';
const PAGE_SIZE = 100;

let _clients = {}; // accountName -> service client
let _sequencers = {}; // jobId -> next sequence number

/**
 * Get or create a blob service client.
 * @private
 */
function _getClient(accountName, accountKey) {
  if (_clients[accountName]) return _clients[accountName];

  const url = `https://${accountName}.blob.core.windows.net`;
  let client;

  if (accountKey) {
    const { StorageSharedKeyCredential } = require('@azure/storage-blob');
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    client = new BlobServiceClient(url, credential);
  } else {
    const { DefaultAzureCredential } = require('@azure/identity');
    client = new BlobServiceClient(url, new DefaultAzureCredential());
  }

  _clients[accountName] = client;
  return client;
}

/**
 * Get storage client for primary account (or secondary on failover).
 * @private
 */
function _getPrimaryClient() {
  const cfg = config.load();
  return _getClient(cfg.storage.accountName, cfg.storage.accountKey);
}

function _getSecondaryClient() {
  const cfg = config.load();
  if (!cfg.storage.secondaryAccountName) return null;
  return _getClient(cfg.storage.secondaryAccountName, cfg.storage.secondaryAccountKey);
}

/**
 * Initialize required containers.
 * @private
 */
async function _ensureContainers() {
  const client = _getPrimaryClient();
  for (const container of [EVENTS_CONTAINER, INDEX_CONTAINER]) {
    const containerClient = client.getContainerClient(container);
    try {
      await containerClient.createIfNotExists();
    } catch (err) {
      if (err.code !== 'ContainerAlreadyExists') {
        throw err;
      }
    }
  }
}

/**
 * Generate a unique event ID.
 * @private
 */
function _generateEventId() {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Get next sequence number for a job (with in-memory caching).
 * @private
 */
async function _getNextSequence(jobId) {
  if (!_sequencers[jobId]) {
    _sequencers[jobId] = 0;
  }
  return _sequencers[jobId]++;
}

/**
 * Construct blob name for an event.
 * Format: events/{jobId}/{isoDate}T{hours}_{minutes}_{seconds}_{millis}-{seq}-{type}.json
 * Ensures natural chronological sorting.
 * @private
 */
function _getEventBlobName(jobId, eventType, sequence) {
  const now = new Date();
  const isoDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = now.toISOString().split('T')[1].replace(/[:.]/g, '_').slice(0, -1); // HH_MM_SS_mmm
  return `events/${jobId}/${isoDate}T${time}-${sequence.toString().padStart(8, '0')}-${eventType}.json`;
}

/**
 * Construct blob name for job index metadata.
 * @private
 */
function _getIndexBlobName(jobId) {
  return `events-index/${jobId}/index.json`;
}

/**
 * Load or create job index (metadata about all events).
 * @private
 */
async function _loadOrCreateIndex(jobId) {
  const client = _getPrimaryClient();
  const containerClient = client.getContainerClient(INDEX_CONTAINER);
  const blobClient = containerClient.getBlobClient(_getIndexBlobName(jobId));

  try {
    const response = await blobClient.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    if (err.code === 'BlobNotFound') {
      return {
        jobId,
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        eventCount: 0,
        events: [],
      };
    }
    throw err;
  }
}

/**
 * Save job index metadata.
 * @private
 */
async function _saveIndex(jobId, index) {
  index.lastUpdated = new Date().toISOString();

  const client = _getPrimaryClient();
  const containerClient = client.getContainerClient(INDEX_CONTAINER);
  const blobClient = containerClient.getBlobClient(_getIndexBlobName(jobId));

  const data = JSON.stringify(index, null, 2);
  await blobClient.uploadData(Buffer.from(data, 'utf8'), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
    overwrite: true,
  });
}

/**
 * Write an immutable event to the log.
 *
 * @param {string} jobId         - Job identifier (Monday itemId or similar)
 * @param {string} eventType     - Event classification (e.g., 'pdf-generated', 'signed', 'archived')
 * @param {Object} data          - Event payload (the actual state change)
 * @param {Object} metadata      - Additional context (author, source, userId, etc.)
 * @returns {Promise<Object>}    - { eventId, timestamp, sequence, blobName }
 */
async function writeEvent(jobId, eventType, data, metadata = {}) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('writeEvent: jobId is required and must be a string');
  }
  if (!eventType || typeof eventType !== 'string') {
    throw new Error('writeEvent: eventType is required and must be a string');
  }

  await _ensureContainers();

  const eventId = _generateEventId();
  const sequence = await _getNextSequence(jobId);
  const timestamp = new Date().toISOString();

  const event = {
    eventId,
    jobId,
    timestamp,
    sequence,
    eventType,
    data,
    metadata: {
      ...metadata,
      recordedAt: timestamp,
    },
  };

  const blobName = _getEventBlobName(jobId, eventType, sequence);

  await retry(async () => {
    const client = _getPrimaryClient();
    const containerClient = client.getContainerClient(EVENTS_CONTAINER);
    const blobClient = containerClient.getBlobClient(blobName);

    const eventJson = JSON.stringify(event, null, 2);
    await blobClient.uploadData(Buffer.from(eventJson, 'utf8'), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      overwrite: false, // Immutable — no overwrites
    });
  }, {
    retries: 2,
    label: `event-write:${jobId}:${eventType}`,
    shouldRetry: (err) => {
      // 409 Conflict means blob already exists — this is fatal, don't retry
      if (err.code === 'BlobAlreadyExists' || err.statusCode === 409) return false;
      return err.transient === true || err.code === 'ECONNRESET' || (err.response && err.response.status >= 500);
    },
  });

  // Update index (best-effort; event is already written)
  try {
    const index = await _loadOrCreateIndex(jobId);
    index.eventCount++;
    index.events.push({
      eventId,
      sequence,
      timestamp,
      eventType,
      blobName,
    });
    await _saveIndex(jobId, index);
  } catch (err) {
    logger.warn('event-index-update-failed', {
      jobId, eventId, error: err.message,
    });
  }

  logger.event('event-written', {
    jobId, eventId, sequence, eventType, bytes: JSON.stringify(event).length,
  });

  return { eventId, timestamp, sequence, blobName };
}

/**
 * Retrieve all events for a job, with optional pagination.
 *
 * @param {string} jobId         - Job identifier
 * @param {Object} options       - { skip=0, limit=PAGE_SIZE }
 * @returns {Promise<Object>}    - { events: [...], total, hasMore, continuationToken }
 */
async function getHistory(jobId, options = {}) {
  if (!jobId) throw new Error('getHistory: jobId is required');

  const { skip = 0, limit = PAGE_SIZE } = options;

  await _ensureContainers();

  const events = [];
  let total = 0;
  let skipped = 0;
  let collected = 0;

  try {
    const client = _getPrimaryClient();
    const containerClient = client.getContainerClient(EVENTS_CONTAINER);

    // List blobs with jobId prefix (natural chronological order by blob name)
    for await (const blob of containerClient.listBlobsFlat({ prefix: `events/${jobId}/` })) {
      total++;
      if (skipped < skip) {
        skipped++;
        continue;
      }
      if (collected >= limit) break;

      try {
        const blobClient = containerClient.getBlobClient(blob.name);
        const response = await blobClient.download();
        const chunks = [];
        for await (const chunk of response.readableStreamBody) {
          chunks.push(chunk);
        }
        const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        events.push(event);
        collected++;
      } catch (err) {
        logger.warn('event-read-failed', { jobId, blobName: blob.name, error: err.message });
      }
    }
  } catch (err) {
    logger.error('event-list-failed', err, { jobId });
    throw err;
  }

  const hasMore = skipped + collected < total;

  logger.event('event-history-retrieved', {
    jobId, returned: events.length, total, hasMore,
  });

  return {
    jobId,
    events,
    total,
    skip,
    limit,
    returned: events.length,
    hasMore,
  };
}

/**
 * Get a single event by jobId and sequence number.
 *
 * @param {string} jobId         - Job identifier
 * @param {number} sequence      - Event sequence number
 * @returns {Promise<Object|null>} - Event or null if not found
 */
async function getEvent(jobId, sequence) {
  if (!jobId) throw new Error('getEvent: jobId is required');
  if (!Number.isFinite(sequence)) throw new Error('getEvent: sequence must be a number');

  await _ensureContainers();

  try {
    const history = await getHistory(jobId, { skip: 0, limit: 10000 });
    const event = history.events.find((e) => e.sequence === sequence);
    return event || null;
  } catch (err) {
    logger.error('event-fetch-failed', err, { jobId, sequence });
    throw err;
  }
}

/**
 * Replay events to reconstruct state from a point in time.
 *
 * Supports two replay modes:
 *  1. Replay from sequence N onward: replayFrom(jobId, { fromSequence: N })
 *  2. Replay from timestamp onward: replayFrom(jobId, { fromTimestamp: '2026-08-01T...' })
 *
 * Returns the full event sequence for external reduction/replay logic.
 *
 * @param {string} jobId         - Job identifier
 * @param {Object} options       - { fromSequence, fromTimestamp, toSequence, toTimestamp }
 * @returns {Promise<Object>}    - { jobId, fromSequence, toSequence, events: [...], count }
 */
async function replayFrom(jobId, options = {}) {
  if (!jobId) throw new Error('replayFrom: jobId is required');

  const {
    fromSequence = 0,
    fromTimestamp,
    toSequence = Infinity,
    toTimestamp,
  } = options;

  const history = await getHistory(jobId, { skip: 0, limit: 10000 });
  let filtered = [...history.events];

  if (Number.isFinite(fromSequence)) {
    filtered = filtered.filter((e) => e.sequence >= fromSequence);
  }

  if (Number.isFinite(toSequence)) {
    filtered = filtered.filter((e) => e.sequence <= toSequence);
  }

  if (fromTimestamp) {
    const ts = new Date(fromTimestamp).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= ts);
  }

  if (toTimestamp) {
    const ts = new Date(toTimestamp).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= ts);
  }

  logger.event('event-replay', {
    jobId,
    fromSequence,
    toSequence,
    eventsReplayed: filtered.length,
  });

  return {
    jobId,
    fromSequence,
    toSequence,
    fromTimestamp,
    toTimestamp,
    events: filtered,
    count: filtered.length,
  };
}

/**
 * Get total event count for a job.
 *
 * @param {string} jobId
 * @returns {Promise<number>}
 */
async function getEventCount(jobId) {
  if (!jobId) throw new Error('getEventCount: jobId is required');

  try {
    const index = await _loadOrCreateIndex(jobId);
    return index.eventCount || 0;
  } catch (err) {
    logger.warn('event-count-lookup-failed', { jobId, error: err.message });
    // Fallback: count blobs
    const history = await getHistory(jobId, { skip: 0, limit: 1 });
    return history.total;
  }
}

/**
 * Replay events into a reducer function to compute final state.
 *
 * Usage:
 *   const initialState = {};
 *   const reducer = (state, event) => {
 *     if (event.eventType === 'pdf-generated') state.pdfUrl = event.data.pdfUrl;
 *     if (event.eventType === 'signed') state.signedAt = event.timestamp;
 *     return state;
 *   };
 *   const finalState = await reduceEvents(jobId, initialState, reducer);
 *
 * @param {string} jobId         - Job identifier
 * @param {Object} initialState  - Starting state (e.g., {})
 * @param {Function} reducer     - (state, event) => newState
 * @returns {Promise<Object>}    - Final computed state
 */
async function reduceEvents(jobId, initialState, reducer) {
  if (!jobId) throw new Error('reduceEvents: jobId is required');
  if (typeof reducer !== 'function') throw new Error('reduceEvents: reducer must be a function');

  const replay = await replayFrom(jobId, {});
  let state = { ...initialState };

  for (const event of replay.events) {
    try {
      state = await reducer(state, event);
    } catch (err) {
      logger.error('event-reduce-failed', err, {
        jobId,
        eventId: event.eventId,
        sequence: event.sequence,
      });
      throw err;
    }
  }

  return state;
}

/**
 * List all jobs that have events (for admin/monitoring).
 * Returns job prefixes across the entire events container.
 *
 * @returns {Promise<string[]>} - Array of jobIds with events
 */
async function listJobs() {
  await _ensureContainers();

  const jobIds = new Set();

  try {
    const client = _getPrimaryClient();
    const containerClient = client.getContainerClient(EVENTS_CONTAINER);

    for await (const blob of containerClient.listBlobsFlat({ prefix: 'events/' })) {
      // Extract jobId from "events/{jobId}/..."
      const match = blob.name.match(/^events\/([^/]+)\//);
      if (match) jobIds.add(match[1]);
    }
  } catch (err) {
    logger.error('list-jobs-failed', err, {});
    throw err;
  }

  return Array.from(jobIds).sort();
}

/**
 * Delete all events for a job (for cleanup/GDPR).
 *
 * @param {string} jobId
 * @returns {Promise<{deleted: number}>}
 */
async function deleteJob(jobId) {
  if (!jobId) throw new Error('deleteJob: jobId is required');

  await _ensureContainers();

  let deleted = 0;

  try {
    const client = _getPrimaryClient();
    const containerClient = client.getContainerClient(EVENTS_CONTAINER);

    for await (const blob of containerClient.listBlobsFlat({ prefix: `events/${jobId}/` })) {
      await containerClient.deleteBlob(blob.name);
      deleted++;
    }

    // Delete index
    const indexContainer = client.getContainerClient(INDEX_CONTAINER);
    await indexContainer.deleteBlobIfExists(_getIndexBlobName(jobId));
  } catch (err) {
    logger.error('delete-job-failed', err, { jobId });
    throw err;
  }

  logger.event('job-deleted', { jobId, eventsDeleted: deleted });

  // Clean up in-memory sequencer
  delete _sequencers[jobId];

  return { deleted };
}

/**
 * Clear in-memory caches (for testing / hot-reload).
 * @private
 */
function _reset() {
  _clients = {};
  _sequencers = {};
}

module.exports = {
  // Write
  writeEvent,

  // Query
  getHistory,
  getEvent,
  getEventCount,
  listJobs,

  // Replay
  replayFrom,
  reduceEvents,

  // Admin
  deleteJob,

  // Testing
  _reset,
};
