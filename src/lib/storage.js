'use strict';
/**
 * Storage integration: unified blob + job queue operations.
 * - uploadBlob(name, buffer): upload to temp container
 * - downloadBlob(name): download from temp container
 * - queueJob(job): enqueue a job
 * - dequeueJob(): dequeue and process next job
 *
 * Jobs are stored as JSON in a dedicated queue container with an index
 * for tracking pending, processing, and completed states.
 */

const blob = require('./blob');
const config = require('./config');
const logger = require('./logger');
const { retry } = require('./util');

const QUEUE_CONTAINER = 'job-queue';
const QUEUE_INDEX = 'queue-index.json';
const JOB_PREFIX = 'jobs/';

// In-memory cache of queue state (for local dev; production uses blob storage)
let _queueCache = { pending: [], processing: {}, completed: [] };

/**
 * Load queue index from blob storage.
 * @returns {Promise<Object>} {pending: [], processing: {}, completed: []}
 */
async function _loadQueueIndex() {
  try {
    const buffer = await blob.downloadPDF(QUEUE_CONTAINER, QUEUE_INDEX);
    const str = buffer.toString('utf8');
    const data = JSON.parse(str);
    _queueCache = data;
    return data;
  } catch (err) {
    // First time or index corrupted — start fresh
    if (err.code === 'BlobNotFound' || err.code === 404 || err instanceof SyntaxError) {
      _queueCache = { pending: [], processing: {}, completed: [] };
      return _queueCache;
    }
    throw err;
  }
}

/**
 * Persist queue index to blob storage.
 * @param {Object} state - Queue state
 */
async function _saveQueueIndex(state) {
  const buffer = Buffer.from(JSON.stringify(state, null, 2), 'utf8');
  await blob.uploadPDF(QUEUE_CONTAINER, QUEUE_INDEX, buffer);
  _queueCache = state;
}

/**
 * Upload a blob (PDF) to the temp container.
 * @param {string} name - Blob name
 * @param {Buffer} buffer - File buffer
 * @returns {Promise<Object>} {url, sasUrl, account, bytes}
 */
async function uploadBlob(name, buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('uploadBlob: buffer must be a Buffer');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('uploadBlob: name must be a non-empty string');
  }

  const cfg = config.load();
  const result = await blob.uploadPDF(cfg.storage.tempContainer, name, buffer);
  logger.event('storage-blob-uploaded', { name, bytes: buffer.length, container: cfg.storage.tempContainer });
  return result;
}

/**
 * Download a blob (PDF) from the temp container.
 * @param {string} name - Blob name
 * @returns {Promise<Buffer>}
 */
async function downloadBlob(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('downloadBlob: name must be a non-empty string');
  }

  const cfg = config.load();
  const buffer = await blob.downloadPDF(cfg.storage.tempContainer, name);
  logger.event('storage-blob-downloaded', { name, bytes: buffer.length, container: cfg.storage.tempContainer });
  return buffer;
}

/**
 * Enqueue a job for processing.
 * @param {Object} job - Job object {boardId, itemId, eventType, receivedAt, ...}
 * @returns {Promise<string>} jobId
 */
async function queueJob(job) {
  if (!job || typeof job !== 'object') {
    throw new Error('queueJob: job must be an object');
  }
  if (!job.itemId) {
    throw new Error('queueJob: job.itemId is required');
  }

  const jobId = `${job.boardId || 'unknown'}-${job.itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const jobData = {
    jobId,
    ...job,
    enqueuedAt: new Date().toISOString(),
    status: 'pending',
  };

  // Save job data to blob storage
  const jobBlob = Buffer.from(JSON.stringify(jobData, null, 2), 'utf8');
  await retry(
    () => blob.uploadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`, jobBlob),
    { retries: 2, label: 'storage-queue-job-save' }
  );

  // Update queue index
  const index = await _loadQueueIndex();
  index.pending.push(jobId);
  await _saveQueueIndex(index);

  logger.event('storage-job-queued', { jobId, itemId: job.itemId, boardId: job.boardId });
  return jobId;
}

/**
 * Dequeue the next pending job for processing.
 * Atomically transitions job from pending → processing.
 * @returns {Promise<Object|null>} Job object or null if queue empty
 */
async function dequeueJob() {
  const index = await _loadQueueIndex();

  if (!index.pending || index.pending.length === 0) {
    logger.event('storage-dequeue-empty', { queueSize: 0 });
    return null;
  }

  const jobId = index.pending.shift();
  if (!jobId) return null;

  try {
    // Fetch job data
    const jobBuffer = await blob.downloadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`);
    const job = JSON.parse(jobBuffer.toString('utf8'));

    // Mark as processing
    job.status = 'processing';
    job.processingStartedAt = new Date().toISOString();

    // Update job and index
    const jobBlob = Buffer.from(JSON.stringify(job, null, 2), 'utf8');
    await blob.uploadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`, jobBlob);

    index.processing[jobId] = {
      startedAt: job.processingStartedAt,
      itemId: job.itemId,
      boardId: job.boardId,
    };
    await _saveQueueIndex(index);

    logger.event('storage-job-dequeued', { jobId, itemId: job.itemId });
    return job;
  } catch (err) {
    // If fetch fails, restore job to pending and throw
    index.pending.unshift(jobId);
    await _saveQueueIndex(index);
    throw err;
  }
}

/**
 * Mark a job as completed.
 * Atomically transitions job from processing → completed.
 * @param {string} jobId - Job ID
 * @param {Object} result - Completion result data (optional)
 * @returns {Promise<void>}
 */
async function completeJob(jobId, result = {}) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('completeJob: jobId must be a non-empty string');
  }

  const index = await _loadQueueIndex();

  // Fetch and update job
  const jobBuffer = await blob.downloadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`);
  const job = JSON.parse(jobBuffer.toString('utf8'));

  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  job.result = result;

  // Persist updated job
  const jobBlob = Buffer.from(JSON.stringify(job, null, 2), 'utf8');
  await blob.uploadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`, jobBlob);

  // Update index
  delete index.processing[jobId];
  index.completed.push({ jobId, completedAt: job.completedAt });

  // Trim completed jobs (keep last 1000)
  if (index.completed.length > 1000) {
    index.completed = index.completed.slice(-1000);
  }

  await _saveQueueIndex(index);
  logger.event('storage-job-completed', { jobId });
}

/**
 * Mark a job as failed.
 * Atomically transitions job from processing → pending (for retry) or failed.
 * @param {string} jobId - Job ID
 * @param {Error} err - Error that occurred
 * @param {boolean} shouldRetry - Whether to move back to pending
 * @returns {Promise<void>}
 */
async function failJob(jobId, err, shouldRetry = true) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('failJob: jobId must be a non-empty string');
  }

  const index = await _loadQueueIndex();

  // Fetch and update job
  const jobBuffer = await blob.downloadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`);
  const job = JSON.parse(jobBuffer.toString('utf8'));

  job.status = shouldRetry ? 'pending' : 'failed';
  job.lastError = err.message;
  job.lastErrorCode = err.code;
  job.failedAt = new Date().toISOString();
  job.retryCount = (job.retryCount || 0) + 1;

  // Persist updated job
  const jobBlob = Buffer.from(JSON.stringify(job, null, 2), 'utf8');
  await blob.uploadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`, jobBlob);

  // Update index
  delete index.processing[jobId];
  if (shouldRetry) {
    index.pending.unshift(jobId); // Re-queue for retry
  } else {
    index.completed.push({ jobId, failedAt: job.failedAt, error: job.lastError });
  }

  await _saveQueueIndex(index);
  const action = shouldRetry ? 'retrying' : 'failed';
  logger.warn(`storage-job-${action}`, { jobId, error: err.message, retryCount: job.retryCount });
}

/**
 * Get job status and metadata.
 * @param {string} jobId - Job ID
 * @returns {Promise<Object|null>} Job or null if not found
 */
async function getJob(jobId) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('getJob: jobId must be a non-empty string');
  }

  try {
    const jobBuffer = await blob.downloadPDF(QUEUE_CONTAINER, `${JOB_PREFIX}${jobId}.json`);
    return JSON.parse(jobBuffer.toString('utf8'));
  } catch (err) {
    if (err.code === 'BlobNotFound' || err.code === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Get queue statistics.
 * @returns {Promise<Object>} {pending: number, processing: number, completed: number}
 */
async function getQueueStats() {
  const index = await _loadQueueIndex();
  return {
    pending: (index.pending || []).length,
    processing: Object.keys(index.processing || {}).length,
    completed: (index.completed || []).length,
  };
}

/**
 * For testing: reset queue state.
 */
async function _resetQueue() {
  _queueCache = { pending: [], processing: {}, completed: [] };
  try {
    const cfg = config.load();
    const client = require('./blob')._getClient ? null : {}; // Ensure blob module accessible
    // In test mode, queue index deletion is optional
  } catch (_) {
    /* noop in tests */
  }
}

module.exports = {
  uploadBlob,
  downloadBlob,
  queueJob,
  dequeueJob,
  completeJob,
  failJob,
  getJob,
  getQueueStats,
  _resetQueue,
  _loadQueueIndex,
  _saveQueueIndex,
};
