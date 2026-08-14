'use strict';
/**
 * SharePoint integration with Circuit Breaker.
 *
 * When to use circuit breaker:
 * - SharePoint token acquisition is critical; auth service down = everything fails
 * - Graph API is resilient but has rate limits (1000/min per app)
 * - File uploads are blocking operations in document workflow
 * - Folder creation is idempotent; can be retried with circuit protection
 *
 * Decision matrix:
 *   Operation              | Threshold | Timeout | Rationale
 *   ---------------------- | --------- | ------- | ---------------------------------
 *   Token acquisition      | 3 failures| 30s     | Auth service down -> fail fast
 *   Graph request (generic)| 3 failures| 45s     | Token failure is implicit
 *   Folder creation        | 3 failures| 45s     | Idempotent; can retry
 *   File upload           | 3 failures| 60s     | Larger payload; longer timeout
 *   Metadata update       | 3 failures| 45s     | Post-upload; less critical
 *
 * SharePoint-specific handling:
 *   - 401/403 -> token is expired/invalid -> force refresh
 *   - 429 -> throttled -> respect Retry-After header
 *   - 5xx -> service error -> retryable
 */

const sharepoint = require('../sharepoint');
const { callApi } = require('../apiClient');

const _originalFunctions = { ...sharepoint };

/**
 * Get access token with strict circuit breaker.
 * Auth failure = everything downstream fails. Fail fast.
 */
async function getAccessToken() {
  return callApi('sharepoint', async () => {
    return _originalFunctions.getAccessToken();
  }, {
    label: `sharepoint-token-acquire`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 30000,
    },
  });
}

/**
 * Make authenticated Graph API request with circuit breaker.
 * Handles both network failures + Graph-specific errors.
 */
async function graphRequest(method, path, data = null, opts = {}) {
  return callApi('sharepoint', async () => {
    return _originalFunctions.graphRequest(method, path, data, opts);
  }, {
    label: `sharepoint-graph-${method}`,
    shouldRetry: (err) => {
      if (err.retryAfterMs) return true; // Respect throttle
      const status = err?.graphStatus;
      // Retry transient: 429, 408, 5xx
      return status === 429 || status === 408 || (status >= 500 && status < 600);
    },
    breakerOpts: {
      failureThreshold: 3,
      timeout: 45000,
    },
  });
}

/**
 * Get or create folder with circuit breaker.
 * Folder creation is idempotent; can retry with circuit protection.
 */
async function getOrCreateFolder(siteId, drivePath, folderName) {
  return callApi('sharepoint', async () => {
    return _originalFunctions.getOrCreateFolder(siteId, drivePath, folderName);
  }, {
    label: `sharepoint-create-folder-${folderName}`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 45000,
    },
  });
}

/**
 * Upload file with circuit breaker.
 * File upload is blocking; use strict threshold + longer timeout for payload.
 */
async function uploadFile(siteId, drivePath, fileName, buffer, metadata) {
  return callApi('sharepoint', async () => {
    return _originalFunctions.uploadFile(siteId, drivePath, fileName, buffer, metadata);
  }, {
    label: `sharepoint-upload-${fileName}`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 60000, // Longer timeout for file uploads
    },
  });
}

/**
 * Update file metadata with circuit breaker.
 * Metadata updates are non-critical; can tolerate longer retry.
 */
async function updateFileMetadata(siteId, driveItemId, metadata) {
  return callApi('sharepoint', async () => {
    return _originalFunctions.updateFileMetadata(siteId, driveItemId, metadata);
  }, {
    label: `sharepoint-update-metadata`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 45000,
    },
  });
}

/**
 * Batch upload multiple files with circuit breaker.
 */
async function batchUpload(siteId, files) {
  return callApi('sharepoint', async () => {
    return _originalFunctions.batchUpload(siteId, files);
  }, {
    label: `sharepoint-batch-upload`,
    breakerOpts: {
      failureThreshold: 3,
      timeout: 120000, // Batch uploads take longer
    },
  });
}

// Placeholder for functions that may exist in sharepoint.js
// Comment out if not present in your implementation
const passthrough = [
  'getOrCreateFolder',
  'uploadFile',
  'updateFileMetadata',
  'batchUpload',
];

// Export wrapped versions
module.exports = {
  getAccessToken,
  graphRequest,
  getOrCreateFolder,
  uploadFile,
  updateFileMetadata,
  batchUpload,
};
