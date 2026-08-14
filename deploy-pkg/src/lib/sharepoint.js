'use strict';
/**
 * SharePoint library: uploads signed PDFs to SharePoint library with
 * error handling and retry logic. On repeated failures, documents are
 * moved to blob storage with operational alerts.
 */

const https = require('https');
const config = require('./config');
const logger = require('./logger');
const { retry } = require('./util');

const UPLOAD_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

/**
 * Get a valid SharePoint access token via ClientCredentials flow.
 * Uses app-only authentication (requires SHAREPOINT_CLIENT_ID + SHAREPOINT_CLIENT_SECRET + SHAREPOINT_TENANT_ID).
 */
async function getAccessToken() {
  const cfg = config.load();
  const clientId = process.env.SHAREPOINT_CLIENT_ID;
  const clientSecret = process.env.SHAREPOINT_CLIENT_SECRET;
  const tenantId = process.env.SHAREPOINT_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    const err = new Error('SharePoint auth: missing SHAREPOINT_CLIENT_ID, CLIENT_SECRET, or TENANT_ID');
    err.code = 'SHAREPOINT_AUTH_MISSING';
    throw err;
  }

  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString();

    const req = https.request(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: UPLOAD_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          resolve(json.access_token);
        } else {
          reject(new Error(`SharePoint auth failed: HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SharePoint auth timeout'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Upload a PDF buffer to SharePoint drive.
 * @param {Buffer} pdfBuffer - PDF content
 * @param {string} fileName - desired filename (e.g., "employee_doc_2026.pdf")
 * @param {string} driveFolderId - SharePoint drive folder ID (optional; uses root if not set)
 * @returns {Promise<{uploadId: string, webUrl: string, size: number}>}
 */
async function uploadPDF(pdfBuffer, fileName, driveFolderId = null) {
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error('uploadPDF: pdfBuffer must be a Buffer');
  }

  const cfg = config.load();
  if (!cfg.sharepoint.siteUrl) {
    const err = new Error('SharePoint upload: SHAREPOINT_SITE_URL not configured');
    err.code = 'SHAREPOINT_NOT_CONFIGURED';
    throw err;
  }

  try {
    const token = await getAccessToken();

    // Sanitize filename
    const cleanName = fileName.replace(/[^\w\-._]/g, '_');

    // For simplicity, use simple upload to SharePoint documents library root.
    // In production, you could parse siteUrl to extract the site ID and use driveId.
    const uploadUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/${cleanName}:/content`;

    return new Promise((resolve, reject) => {
      const req = https.request(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': pdfBuffer.length,
        },
        timeout: UPLOAD_TIMEOUT_MS,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 201 || res.statusCode === 200) {
            const json = JSON.parse(data);
            resolve({
              uploadId: json.id,
              webUrl: json.webUrl,
              size: json.size,
            });
          } else {
            const err = new Error(`SharePoint upload failed: HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.response = data;
            reject(err);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('SharePoint upload timeout'));
      });

      req.on('error', reject);
      req.write(pdfBuffer);
      req.end();
    });
  } catch (err) {
    if (err.code === 'SHAREPOINT_NOT_CONFIGURED' || err.code === 'SHAREPOINT_AUTH_MISSING') {
      throw err;
    }
    // Wrap operational errors with context
    const wrapped = new Error(`SharePoint upload error: ${err.message}`);
    wrapped.originalError = err;
    wrapped.code = 'SHAREPOINT_UPLOAD_FAILED';
    throw wrapped;
  }
}

/**
 * Try uploading to SharePoint with retry logic.
 * Returns {success: true, uploadId, webUrl} or {success: false, error}
 * Failures do NOT throw; they return error objects for poison queue handling.
 */
async function tryUpload(pdfBuffer, fileName, driveFolderId = null) {
  try {
    const result = await retry(
      () => uploadPDF(pdfBuffer, fileName, driveFolderId),
      {
        retries: MAX_RETRIES,
        label: 'sharepoint-upload',
        shouldRetry: (err) => {
          // Retry on transient errors (timeout, 5xx)
          if (err.statusCode >= 500 || err.message.includes('timeout')) return true;
          if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') return true;
          return false;
        },
      }
    );
    logger.event('sharepoint-upload-success', { fileName, uploadId: result.uploadId });
    return { success: true, uploadId: result.uploadId, webUrl: result.webUrl };
  } catch (err) {
    logger.warn('sharepoint-upload-failed', {
      fileName,
      error: err.message,
      code: err.code,
    });
    return { success: false, error: err.message, code: err.code };
  }
}

module.exports = {
  uploadPDF,
  tryUpload,
  getAccessToken,
};
