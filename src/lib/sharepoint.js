'use strict';
/**
 * SharePoint integration: upload signed PDFs to SharePoint Online via Microsoft Graph API.
 * Features:
 * - AAD token-based auth (app-only, managed identity, or MSAL credentials)
 * - Automatic folder creation (by year/month/docType)
 * - Metadata tagging (employee, docType, signDate, agreementId)
 * - Retry with exponential backoff (transient error handling)
 * - Batch upload fallback (when delta upload unavailable)
 */

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const { retry, sleep, RateLimiter } = require('./util');

const DEFAULT_GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const TOKEN_CACHE_TTL_MS = 3600 * 1000; // 1 hour

let _tokenCache = null;
let _tokenCacheTime = 0;
let _graphLimiter = null;

function _limiter() {
  if (!_graphLimiter) {
    // Graph has a default 10 requests per second per app. Be conservative: 5/sec
    _graphLimiter = new RateLimiter(5, 1000, 'graph-sharepoint');
  }
  return _graphLimiter;
}

/**
 * Acquire AAD access token. Supports three auth methods:
 * 1. SHAREPOINT_CLIENT_ID + SHAREPOINT_CLIENT_SECRET (app registration)
 * 2. Managed identity (DefaultAzureCredential) — requires app role
 * 3. (Future) MSAL user flow
 * @returns {Promise<string>} access token
 */
async function getAccessToken() {
  // Check cache (token good for ~1h, refresh at 55min)
  if (_tokenCache && (Date.now() - _tokenCacheTime) < TOKEN_CACHE_TTL_MS * 0.92) {
    return _tokenCache;
  }

  const cfg = config.load();
  const tenantId = cfg.sharepoint?.tenantId;
  const clientId = cfg.sharepoint?.clientId;
  const clientSecret = cfg.sharepoint?.clientSecret;

  if (!tenantId || !clientId) {
    throw new Error('SharePoint auth config missing: SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID required');
  }

  // App-only auth: client credentials flow
  if (clientSecret) {
    try {
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      const response = await retry(() =>
        axios.post(tokenUrl, new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        }),
        { retries: 2, label: 'sharepoint-token-acquire', shouldRetry: (err) => {
          const status = err?.response?.status;
          return status === 429 || status >= 500; // Don't retry 4xx errors (except 429)
        }}
      );

      _tokenCache = response.data.access_token;
      _tokenCacheTime = Date.now();
      logger.info('sharepoint-token-acquired', { tenantId, clientId });
      return _tokenCache;
    } catch (err) {
      logger.error('sharepoint-token-acquire-failed', err, { tenantId, clientId });
      throw new Error(`Failed to acquire SharePoint token: ${err.message}`);
    }
  }

  // Managed identity auth (Azure Functions)
  try {
    const { DefaultAzureCredential } = require('@azure/identity');
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken('https://graph.microsoft.com/.default');
    _tokenCache = token.token;
    _tokenCacheTime = Date.now();
    logger.info('sharepoint-token-acquired-msi', { tenantId });
    return _tokenCache;
  } catch (err) {
    logger.error('sharepoint-token-acquire-msi-failed', err, { tenantId });
    throw new Error(`Failed to acquire token via managed identity: ${err.message}`);
  }
}

/**
 * Make authenticated Graph API request with retry.
 * @param {string} method  GET|POST|PUT|PATCH|DELETE
 * @param {string} path    /sites/{siteId}/drive/items or /me/drive/items, etc.
 * @param {*} data         request body (for POST/PATCH/PUT)
 * @param {Object} opts    { retries, baseDelayMs, headers }
 * @returns {Promise<Object>} response data
 */
async function graphRequest(method, path, data = null, opts = {}) {
  const token = await getAccessToken();
  const url = `${DEFAULT_GRAPH_URL}${path}`;
  await _limiter().acquire(); // Rate limit before each Graph API call

  const req = async (attempt) => {
    try {
      const axiosConfig = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
        timeout: 30000,
      };

      if (data) axiosConfig.data = data;

      const response = await axios(axiosConfig);
      return response.data;
    } catch (err) {
      // Enrich error with Graph-specific details
      if (err.response) {
        err.graphStatus = err.response.status;
        err.graphData = err.response.data;
        if (err.response.status === 429) {
          const retryAfter = parseInt(err.response.headers['retry-after'] || '60', 10);
          err.retryAfterMs = retryAfter * 1000;
          await sleep(err.retryAfterMs);
        }
      }
      throw err;
    }
  };

  return retry(req, {
    retries: opts.retries != null ? opts.retries : 3,
    baseDelayMs: opts.baseDelayMs,
    label: `graph-${method}:${path.split('/').slice(0, 3).join('/')}`,
    shouldRetry: (err) => {
      if (err.retryAfterMs) return true; // 429 throttle
      const status = err?.graphStatus;
      // Retry transient: 429, 408, 5xx; don't retry 4xx errors
      return status === 429 || status === 408 || (status >= 500 && status < 600);
    },
  });
}

/**
 * Get or create folder structure in SharePoint drive.
 * Lazy-creates: /Documents/Onboarding/{year}/{month}/{docType}/
 * @returns {Promise<string>} folder item ID (to upload into)
 */
async function ensureFolderPath(employeeFolder = 'General') {
  const cfg = config.load();
  const siteId = cfg.sharepoint?.siteId;
  const driveId = cfg.sharepoint?.driveId;

  if (!siteId || !driveId) {
    throw new Error('SharePoint folder config missing: SHAREPOINT_SITE_ID, SHAREPOINT_DRIVE_ID required');
  }

  // One folder per hire — Onboarding/Lastname-Firstname — every document the
  // hire ever signs lands in the same place (no year/month nesting).
  const folderPath = `Onboarding/${employeeFolder}`;

  try {
    // Try to get the folder (if it exists)
    const existing = await graphRequest('GET', `/drives/${driveId}/root:/${folderPath}`, null);
    logger.info('sharepoint-folder-exists', { folderPath, itemId: existing.id });
    return existing.id;
  } catch (err) {
    // Folder doesn't exist; create it recursively
    if (err.graphStatus === 404) {
      return createFolderPath(driveId, folderPath);
    }
    throw err;
  }
}

/**
 * Recursively create folder path in SharePoint.
 * @param {string} driveId
 * @param {string} folderPath  'Documents/Onboarding/2026/08/Onboarding'
 * @returns {Promise<string>} final folder item ID
 */
async function createFolderPath(driveId, folderPath) {
  const parts = folderPath.split('/').filter(p => p);
  let currentId = 'root'; // start at drive root

  for (const folderName of parts) {
    try {
      // Try to get existing folder
      const existing = await graphRequest('GET', `/drives/${driveId}/items/${currentId}/children`, null);
      const found = existing.value?.find(item => item.name === folderName && item.folder);
      if (found) {
        currentId = found.id;
        logger.info('sharepoint-folder-found', { folderName, itemId: found.id });
        continue;
      }
    } catch (err) {
      logger.warn('sharepoint-list-children-failed', { folderName, error: err.message });
    }

    // Create the folder
    try {
      const created = await graphRequest('POST', `/drives/${driveId}/items/${currentId}/children`, {
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      });
      currentId = created.id;
      logger.info('sharepoint-folder-created', { folderName, itemId: created.id });
    } catch (err) {
      logger.error('sharepoint-folder-create-failed', err, { folderName, parentId: currentId });
      throw err;
    }
  }

  return currentId;
}

/**
 * Upload PDF to SharePoint with metadata.
 * @param {Buffer} fileBuffer       PDF content
 * @param {Object} metadata         { fileName, docType, employeeName, agreementId, signDate }
 * @param {Object} opts             { retries, folderPath }
 * @returns {Promise<Object>}       { id, name, webUrl, itemId, driveId }
 */
async function uploadPDF(fileBuffer, metadata = {}, opts = {}) {
  if (!Buffer.isBuffer(fileBuffer)) {
    throw new Error('uploadPDF: fileBuffer must be a Buffer');
  }

  const cfg = config.load();
  const driveId = cfg.sharepoint?.driveId;
  if (!driveId) throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');

  const {
    fileName = `document_${Date.now()}.pdf`,
    docType = 'Document',
    employeeName = 'Unknown',
    agreementId = '',
    signDate = new Date().toISOString(),
  } = metadata;

  try {
    // Ensure the hire's folder exists
    const parentId = await ensureFolderPath(metadata.employeeFolder || docType);

    // Upload (< 4MB). conflictBehavior=rename: a same-named file gets " 1",
    // " 2"… appended automatically — old versions are never replaced.
    const uploadUrl = `/drives/${driveId}/items/${parentId}:/${fileName}:/content?@microsoft.graph.conflictBehavior=rename`;
    const uploaded = await graphRequest('PUT', uploadUrl, fileBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
      },
      retries: opts.retries != null ? opts.retries : 2,
    });

    // Add metadata: custom properties on the file
    const itemId = uploaded.id;
    const metadataUpdate = {
      properties: {
        'docType': docType,
        'employeeName': employeeName,
        'signedDate': signDate,
        'agreementId': agreementId,
      },
    };

    try {
      await graphRequest('PATCH', `/drives/${driveId}/items/${itemId}`, metadataUpdate);
      logger.info('sharepoint-file-metadata-set', { itemId, docType, employeeName });
    } catch (metaErr) {
      // Log but don't fail if metadata update fails
      logger.warn('sharepoint-file-metadata-failed', { itemId, error: metaErr.message });
    }

    logger.event('sharepoint-upload-complete', {
      itemId,
      fileName,
      bytes: fileBuffer.length,
      docType,
      employeeName,
      agreementId,
    });

    return {
      id: itemId,
      name: fileName,
      webUrl: uploaded.webUrl || `https://medwatchers.sharepoint.com/Shared%20Documents/${fileName}`,
      itemId,
      driveId,
      bytes: fileBuffer.length,
    };
  } catch (err) {
    logger.error('sharepoint-upload-failed', err, {
      fileName,
      docType,
      employeeName,
      agreementId,
      fileSize: fileBuffer.length,
      graphStatus: err.graphStatus,
      graphData: err.graphData,
    });
    throw err;
  }
}

/**
 * Check upload progress / download file (if needed).
 * @param {string} itemId
 * @returns {Promise<Object>} file metadata
 */
async function getFileInfo(itemId) {
  const cfg = config.load();
  const driveId = cfg.sharepoint?.driveId;
  if (!driveId) throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');

  try {
    const info = await graphRequest('GET', `/drives/${driveId}/items/${itemId}`);
    return {
      id: info.id,
      name: info.name,
      size: info.size,
      webUrl: info.webUrl,
      createdDateTime: info.createdDateTime,
      lastModifiedDateTime: info.lastModifiedDateTime,
      properties: info.properties || {},
    };
  } catch (err) {
    logger.error('sharepoint-get-file-info-failed', err, { itemId, driveId });
    throw err;
  }
}

/**
 * Delete a file from SharePoint.
 * @param {string} itemId
 * @returns {Promise<{success: boolean}>}
 */
async function deleteFile(itemId) {
  const cfg = config.load();
  const driveId = cfg.sharepoint?.driveId;
  if (!driveId) throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');

  try {
    await graphRequest('DELETE', `/drives/${driveId}/items/${itemId}`);
    logger.event('sharepoint-file-deleted', { itemId });
    return { success: true };
  } catch (err) {
    if (err.graphStatus === 404) {
      logger.warn('sharepoint-file-already-deleted', { itemId });
      return { success: true, alreadyDeleted: true };
    }
    logger.error('sharepoint-file-delete-failed', err, { itemId });
    throw err;
  }
}

/**
 * List files in a folder (for reconciliation/audit).
 * @param {string} folderPath e.g., 'Documents/Onboarding/2026/08'
 * @returns {Promise<Array>} file items
 */
async function listFiles(folderPath = 'Documents/Onboarding') {
  const cfg = config.load();
  const driveId = cfg.sharepoint?.driveId;
  if (!driveId) throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');

  try {
    const response = await graphRequest('GET', `/drives/${driveId}/root:/${folderPath}:/children`);
    const files = response.value?.filter(item => !item.folder) || [];
    logger.info('sharepoint-list-files', { folderPath, count: files.length });
    return files;
  } catch (err) {
    if (err.graphStatus === 404) {
      logger.warn('sharepoint-folder-not-found-list', { folderPath });
      return [];
    }
    logger.error('sharepoint-list-files-failed', err, { folderPath });
    throw err;
  }
}

// Clear token cache (mainly for testing)
function _resetTokenCache() {
  _tokenCache = null;
  _tokenCacheTime = 0;
}

module.exports = {
  getAccessToken,
  graphRequest,
  ensureFolderPath,
  createFolderPath,
  uploadPDF,
  getFileInfo,
  deleteFile,
  listFiles,
  _resetTokenCache,
};
