'use strict';
/**
 * sharepointClient.js: High-level SharePoint integration library
 *
 * Extends the lower-level sharepoint.js with:
 * - Folder structure organization: /DocFlow/{year}/{month}/{employeeName}/
 * - Automatic permissions management for employee access
 * - Metadata enrichment and document linking
 * - Integration shortcuts back to Monday items
 * - Fallback & error handling
 *
 * Usage:
 *   const client = require('./sharepointClient');
 *   const result = await client.uploadSignedDocument({
 *     pdfBuffer: Buffer,
 *     metadata: { employeeName, docType, agreementId, itemId, boardId }
 *   });
 */

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const sharepoint = require('./sharepoint');
const { retry, sleep } = require('./util');

const DEFAULT_GRAPH_URL = 'https://graph.microsoft.com/v1.0';

/**
 * Calculate the folder path for a document based on employee and date.
 * Follows structure: /DocFlow/{year}/{month}/{employeeName}/
 * @param {string} employeeName - Employee name (will be sanitized)
 * @param {Date} date - Document date (defaults to now)
 * @returns {string} folder path
 */
function calculateFolderPath(employeeName, date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  // Sanitize employee name: remove special chars, replace spaces with hyphens
  const sanitized = employeeName
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 100); // limit to 100 chars

  return `DocFlow/${year}/${month}/${sanitized}`;
}

/**
 * Ensure folder path exists in SharePoint and return folder item ID.
 * Creates parent folders if needed.
 * @param {string} folderPath - e.g., 'DocFlow/2026/08/john-smith'
 * @returns {Promise<string>} folder item ID
 */
async function ensureFolderPath(folderPath) {
  try {
    const cfg = config.load();
    const driveId = cfg.sharepoint?.driveId;
    if (!driveId) {
      throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID required');
    }

    // Try to get the folder (if it exists)
    const response = await sharepoint.graphRequest('GET', `/drives/${driveId}/root:/${folderPath}`, null);
    logger.info('sharepoint-folder-exists', { folderPath, itemId: response.id });
    return response.id;
  } catch (err) {
    // Folder doesn't exist; create it recursively
    if (err.graphStatus === 404) {
      const cfg = config.load();
      const driveId = cfg.sharepoint?.driveId;
      return createFolderPathRecursive(driveId, folderPath);
    }
    throw err;
  }
}

/**
 * Recursively create folder path in SharePoint.
 * @param {string} driveId
 * @param {string} folderPath  'DocFlow/2026/08/john-smith'
 * @returns {Promise<string>} final folder item ID
 */
async function createFolderPathRecursive(driveId, folderPath) {
  const parts = folderPath.split('/').filter(p => p);
  let currentId = 'root';

  for (const folderName of parts) {
    try {
      // Try to get existing folder
      const listResponse = await sharepoint.graphRequest(
        'GET',
        `/drives/${driveId}/items/${currentId}/children`,
        null
      );
      const found = listResponse.value?.find(item => item.name === folderName && item.folder);
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
      const created = await sharepoint.graphRequest(
        'POST',
        `/drives/${driveId}/items/${currentId}/children`,
        {
          name: folderName,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename',
        }
      );
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
 * Grant read permissions to an employee (by email) for their folder.
 * Non-blocking: failures are logged but don't fail the upload.
 * @param {string} itemId - Folder item ID
 * @param {string} employeeEmail - Employee email
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function grantEmployeeAccess(itemId, employeeEmail) {
  try {
    if (!employeeEmail || !employeeEmail.includes('@')) {
      logger.warn('sharepoint-invalid-email', { itemId, email: employeeEmail });
      return { success: false, error: 'invalid_email' };
    }

    const cfg = config.load();
    const driveId = cfg.sharepoint?.driveId;
    const token = await sharepoint.getAccessToken();

    // Build invitation payload (grant read permissions)
    const invitePayload = {
      recipients: [{ email: employeeEmail }],
      requireSignIn: true,
      sendInvitation: true,
      roles: ['read'], // read-only access
      message: `Your signed documents are ready in DocFlow. Access: ${employeeEmail}`,
    };

    // POST to /drives/{driveId}/items/{itemId}/invite
    const url = `${DEFAULT_GRAPH_URL}/drives/${driveId}/items/${itemId}/invite`;
    const response = await axios.post(url, invitePayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    logger.info('sharepoint-employee-access-granted', { itemId, email: employeeEmail });
    return { success: true };
  } catch (err) {
    logger.warn('sharepoint-grant-access-failed', {
      itemId,
      email: employeeEmail,
      error: err.message,
    });
    // Non-blocking: don't fail the whole upload
    return { success: false, error: err.message };
  }
}

/**
 * Create a shareable link for a folder (organization-readable).
 * @param {string} itemId - Folder item ID
 * @returns {Promise<string>} sharing link URL
 */
async function createShareableLink(itemId) {
  try {
    const cfg = config.load();
    const driveId = cfg.sharepoint?.driveId;
    const token = await sharepoint.getAccessToken();

    const url = `${DEFAULT_GRAPH_URL}/drives/${driveId}/items/${itemId}/createLink`;
    const payload = {
      type: 'view', // read-only link
      scope: 'organization', // org-wide access (not public)
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const shareLink = response.data?.link?.webUrl;
    if (shareLink) {
      logger.info('sharepoint-link-created', { itemId, shareLink });
      return shareLink;
    }
    throw new Error('No webUrl in response');
  } catch (err) {
    logger.warn('sharepoint-create-link-failed', { itemId, error: err.message });
    throw err;
  }
}

/**
 * Create a shortcut/link back to a Monday item from within SharePoint.
 * Adds a comment/property referencing the Monday item.
 * @param {string} itemId - SharePoint file item ID
 * @param {string} mondayItemId - Monday item ID
 * @param {string} boardId - Monday board ID
 * @returns {Promise<{success: boolean}>}
 */
async function createMondayShortcut(itemId, mondayItemId, boardId) {
  try {
    if (!mondayItemId || !boardId) {
      logger.warn('sharepoint-invalid-monday-ref', { itemId, mondayItemId, boardId });
      return { success: false };
    }

    const cfg = config.load();
    const driveId = cfg.sharepoint?.driveId;
    const token = await sharepoint.getAccessToken();
    const mondayUrl = `https://monday.com/boards/${boardId}/pulses/${mondayItemId}`;

    // Attempt to set metadata (custom property) linking back to Monday
    const url = `${DEFAULT_GRAPH_URL}/drives/${driveId}/items/${itemId}`;
    const payload = {
      properties: {
        'mondayItemId': mondayItemId,
        'mondayBoardId': boardId,
        'mondayUrl': mondayUrl,
      },
    };

    await axios.patch(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    logger.info('sharepoint-monday-shortcut-created', { itemId, mondayItemId, mondayUrl });
    return { success: true };
  } catch (err) {
    logger.warn('sharepoint-create-shortcut-failed', {
      itemId,
      mondayItemId,
      error: err.message,
    });
    // Non-blocking
    return { success: false };
  }
}

/**
 * Upload a signed PDF to SharePoint with rich metadata and organization.
 *
 * @param {Object} options
 *   {
 *     pdfBuffer: Buffer,              // PDF file content
 *     employeeName: string,           // Employee name (used for folder path)
 *     employeeEmail?: string,         // Optional: grant read access + send invite
 *     docType: string,                // Document type (e.g., 'Offer Letter', 'NDA')
 *     agreementId: string,            // Adobe Sign agreement ID
 *     itemId?: string,                // Monday item ID (for shortcuts)
 *     boardId?: string,               // Monday board ID (for shortcuts)
 *     fileName?: string,              // Override file name
 *   }
 * @returns {Promise<Object>}
 *   {
 *     success: boolean,
 *     itemId: string,                // SharePoint item ID
 *     fileName: string,
 *     webUrl: string,                // Shareable link to file
 *     folderUrl?: string,            // Shareable link to folder
 *     bytes: number,
 *     metadata: Object,              // What was stored in SharePoint
 *     accessGranted?: boolean,
 *   }
 * @throws {Error} on critical failures (auth, network, etc.)
 */
async function uploadSignedDocument(options = {}) {
  const {
    pdfBuffer,
    employeeName,
    employeeEmail,
    docType = 'Document',
    agreementId,
    itemId,
    boardId,
    fileName,
  } = options;

  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error('uploadSignedDocument: pdfBuffer must be a Buffer');
  }
  if (!employeeName) {
    throw new Error('uploadSignedDocument: employeeName is required');
  }

  try {
    const cfg = config.load();
    if (!cfg.sharepoint.enabled) {
      logger.warn('sharepoint-disabled-skipping-upload', { employeeName });
      return { success: false, skipped: true, reason: 'SharePoint not enabled' };
    }

    const driveId = cfg.sharepoint?.driveId;
    if (!driveId) {
      throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');
    }

    logger.info('sharepoint-upload-start', { employeeName, docType, agreementId });

    // 1. Calculate and ensure folder path
    const folderPath = calculateFolderPath(employeeName);
    const folderId = await ensureFolderPath(folderPath);
    logger.info('sharepoint-folder-ready', { folderPath, folderId });

    // 2. Upload PDF file
    const finalFileName = fileName || `${docType.replace(/[^\w-]/g, '-')}_${Date.now()}.pdf`;
    const uploadUrl = `/drives/${driveId}/items/${folderId}:/${finalFileName}:/content`;
    const uploaded = await sharepoint.graphRequest('PUT', uploadUrl, pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
      },
      retries: 2,
    });

    const uploadedItemId = uploaded.id;
    logger.info('sharepoint-file-uploaded', {
      itemId: uploadedItemId,
      fileName: finalFileName,
      bytes: pdfBuffer.length,
    });

    // 3. Set rich metadata
    const metadata = {
      properties: {
        'docType': docType,
        'employeeName': employeeName,
        'employeeEmail': employeeEmail || 'unknown@medwatchers.com',
        'signedDate': new Date().toISOString(),
        'agreementId': agreementId || '',
        'uploadSource': 'DocFlow',
      },
    };

    try {
      await sharepoint.graphRequest('PATCH', `/drives/${driveId}/items/${uploadedItemId}`, metadata);
      logger.info('sharepoint-metadata-set', { itemId: uploadedItemId });
    } catch (metaErr) {
      logger.warn('sharepoint-metadata-failed', { itemId: uploadedItemId, error: metaErr.message });
      // Non-blocking
    }

    // 4. Grant employee access (non-blocking)
    let accessGranted = false;
    if (employeeEmail) {
      const accessResult = await grantEmployeeAccess(folderId, employeeEmail);
      accessGranted = accessResult.success;
    }

    // 5. Create Monday shortcut (non-blocking)
    if (itemId && boardId) {
      await createMondayShortcut(uploadedItemId, itemId, boardId);
    }

    // 6. Create shareable folder link
    let folderUrl = null;
    try {
      folderUrl = await createShareableLink(folderId);
    } catch (linkErr) {
      logger.warn('sharepoint-folder-link-failed', { folderId, error: linkErr.message });
    }

    logger.event('sharepoint-document-uploaded', {
      employeeName,
      docType,
      agreementId,
      itemId: uploadedItemId,
      folderPath,
      bytes: pdfBuffer.length,
    });

    return {
      success: true,
      itemId: uploadedItemId,
      fileName: finalFileName,
      webUrl: uploaded.webUrl,
      folderUrl,
      bytes: pdfBuffer.length,
      metadata,
      accessGranted,
    };
  } catch (err) {
    logger.error('sharepoint-upload-failed', err, {
      employeeName,
      docType,
      agreementId,
      bytes: pdfBuffer?.length,
    });
    throw err;
  }
}

/**
 * List all documents for an employee.
 * @param {string} employeeName - Employee name
 * @returns {Promise<Array>} array of { name, id, webUrl, size, createdDateTime }
 */
async function listEmployeeDocuments(employeeName) {
  try {
    const cfg = config.load();
    const driveId = cfg.sharepoint?.driveId;
    if (!driveId) throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');

    const folderPath = calculateFolderPath(employeeName);
    const response = await sharepoint.graphRequest(
      'GET',
      `/drives/${driveId}/root:/${folderPath}:/children`
    );

    const files = response.value?.filter(item => !item.folder) || [];
    logger.info('sharepoint-list-employee-docs', { employeeName, count: files.length });

    return files.map(f => ({
      name: f.name,
      id: f.id,
      webUrl: f.webUrl,
      size: f.size,
      createdDateTime: f.createdDateTime,
      lastModifiedDateTime: f.lastModifiedDateTime,
    }));
  } catch (err) {
    if (err.graphStatus === 404) {
      logger.info('sharepoint-employee-folder-not-found', { employeeName });
      return [];
    }
    logger.error('sharepoint-list-employee-docs-failed', err, { employeeName });
    throw err;
  }
}

/**
 * Delete a document from SharePoint.
 * @param {string} itemId - SharePoint item ID
 * @returns {Promise<{success: boolean}>}
 */
async function deleteDocument(itemId) {
  try {
    const cfg = config.load();
    const driveId = cfg.sharepoint?.driveId;
    if (!driveId) throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');

    await sharepoint.graphRequest('DELETE', `/drives/${driveId}/items/${itemId}`);
    logger.event('sharepoint-document-deleted', { itemId });
    return { success: true };
  } catch (err) {
    if (err.graphStatus === 404) {
      logger.warn('sharepoint-document-already-deleted', { itemId });
      return { success: true, alreadyDeleted: true };
    }
    logger.error('sharepoint-delete-failed', err, { itemId });
    throw err;
  }
}

/**
 * Get detailed info about a document (including metadata).
 * @param {string} itemId - SharePoint item ID
 * @returns {Promise<Object>} file metadata
 */
async function getDocumentInfo(itemId) {
  try {
    const cfg = config.load();
    const driveId = cfg.sharepoint?.driveId;
    if (!driveId) throw new Error('SharePoint config missing: SHAREPOINT_DRIVE_ID');

    const info = await sharepoint.graphRequest('GET', `/drives/${driveId}/items/${itemId}`);
    return {
      id: info.id,
      name: info.name,
      size: info.size,
      webUrl: info.webUrl,
      createdDateTime: info.createdDateTime,
      lastModifiedDateTime: info.lastModifiedDateTime,
      properties: info.properties || {},
      metadata: {
        docType: info.properties?.docType,
        employeeName: info.properties?.employeeName,
        agreementId: info.properties?.agreementId,
        signedDate: info.properties?.signedDate,
      },
    };
  } catch (err) {
    logger.error('sharepoint-get-info-failed', err, { itemId });
    throw err;
  }
}

module.exports = {
  // Core upload API
  uploadSignedDocument,

  // Employee management
  grantEmployeeAccess,
  listEmployeeDocuments,

  // Document operations
  deleteDocument,
  getDocumentInfo,

  // Linking & organization
  createShareableLink,
  createMondayShortcut,

  // Folder management
  calculateFolderPath,
  ensureFolderPath,
  createFolderPathRecursive,

  // Re-export lower-level API for advanced use
  sharepoint,
};
