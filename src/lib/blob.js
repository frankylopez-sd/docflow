'use strict';
/**
 * Azure Blob client: upload/download/delete/list + 24h SAS URLs.
 * Primary account first; automatic fallback to the secondary account when the
 * primary write fails. Uses shared-key auth when a key is configured,
 * otherwise managed identity (DefaultAzureCredential).
 */

const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require('@azure/storage-blob');
const config = require('./config');
const logger = require('./logger');
const { retry } = require('./util');

const SAS_TTL_HOURS = 24;

const _clients = {}; // accountName -> { service, credential }

function _getClient(accountName, accountKey) {
  if (_clients[accountName]) return _clients[accountName];
  const url = `https://${accountName}.blob.core.windows.net`;
  let service;
  let credential = null;
  if (accountKey) {
    credential = new StorageSharedKeyCredential(accountName, accountKey);
    service = new BlobServiceClient(url, credential);
  } else {
    // Managed identity path (Azure) — SAS generation then requires a user
    // delegation key, handled in _sasUrl.
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = null;
    service = new BlobServiceClient(url, new DefaultAzureCredential());
  }
  _clients[accountName] = { service, credential, accountName };
  return _clients[accountName];
}

function _primary() {
  const cfg = config.load();
  return _getClient(cfg.storage.accountName, cfg.storage.accountKey);
}

function _secondary() {
  const cfg = config.load();
  if (!cfg.storage.secondaryAccountName) return null;
  return _getClient(cfg.storage.secondaryAccountName, cfg.storage.secondaryAccountKey);
}

function _resetState() {
  for (const k of Object.keys(_clients)) delete _clients[k];
}

async function _sasUrl(client, container, key, ttlHours = SAS_TTL_HOURS) {
  const expiresOn = new Date(Date.now() + ttlHours * 3600 * 1000);
  const blobClient = client.service.getContainerClient(container).getBlobClient(key);

  if (client.credential) {
    const sas = generateBlobSASQueryParameters({
      containerName: container,
      blobName: key,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(Date.now() - 5 * 60 * 1000), // clock-skew grace
      expiresOn,
    }, client.credential).toString();
    return `${blobClient.url}?${sas}`;
  }

  // Managed identity: user delegation SAS
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const delegationKey = await client.service.getUserDelegationKey(startsOn, expiresOn);
  const sas = generateBlobSASQueryParameters({
    containerName: container,
    blobName: key,
    permissions: BlobSASPermissions.parse('r'),
    startsOn,
    expiresOn,
  }, delegationKey, client.accountName).toString();
  return `${blobClient.url}?${sas}`;
}

async function _uploadTo(client, container, key, fileBuffer) {
  const containerClient = client.service.getContainerClient(container);
  await containerClient.createIfNotExists();
  const blockBlob = containerClient.getBlockBlobClient(key);
  await blockBlob.uploadData(fileBuffer, {
    blobHTTPHeaders: { blobContentType: 'application/pdf' },
  });

  // Byte-exact verification: uploaded size must match the source buffer.
  const props = await blockBlob.getProperties();
  if (props.contentLength !== fileBuffer.length) {
    const err = new Error(
      `Blob upload size mismatch for ${container}/${key}: sent ${fileBuffer.length}, stored ${props.contentLength}`
    );
    err.code = 'UPLOAD_SIZE_MISMATCH';
    throw err;
  }
  return blockBlob.url;
}

/**
 * Upload a PDF. Primary account with retry; falls back to the secondary
 * account when the primary keeps failing.
 * @returns {Promise<{url:string, sasUrl:string, account:string, bytes:number}>}
 */
async function uploadPDF(container, key, fileBuffer) {
  if (!Buffer.isBuffer(fileBuffer)) throw new Error('uploadPDF: fileBuffer must be a Buffer');
  const primary = _primary();
  try {
    const url = await retry(() => _uploadTo(primary, container, key, fileBuffer), {
      retries: 1, label: 'blob-upload-primary', shouldRetry: () => true,
    });
    const sasUrl = await _sasUrl(primary, container, key);
    logger.event('blob-uploaded', { container, key, bytes: fileBuffer.length, account: primary.accountName });
    return { url, sasUrl, account: primary.accountName, bytes: fileBuffer.length };
  } catch (primaryErr) {
    const secondary = _secondary();
    if (!secondary) throw primaryErr;
    logger.warn('blob-primary-failed-using-secondary', {
      container, key, error: primaryErr.message,
    });
    const url = await _uploadTo(secondary, container, key, fileBuffer);
    const sasUrl = await _sasUrl(secondary, container, key);
    logger.event('blob-uploaded-secondary', { container, key, bytes: fileBuffer.length });
    return { url, sasUrl, account: secondary.accountName, bytes: fileBuffer.length };
  }
}

/** Download a blob to a Buffer. Checks primary, then secondary. */
async function downloadPDF(container, key) {
  const tryDownload = async (client) => {
    const blobClient = client.service.getContainerClient(container).getBlobClient(key);
    if (typeof blobClient.downloadToBuffer === 'function') {
      return blobClient.downloadToBuffer();
    }
    const res = await blobClient.download();
    const chunks = [];
    for await (const chunk of res.readableStreamBody) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  try {
    return await retry(() => tryDownload(_primary()), { retries: 2, label: 'blob-download', shouldRetry: () => true });
  } catch (err) {
    const secondary = _secondary();
    if (!secondary) throw err;
    logger.warn('blob-download-falling-back-secondary', { container, key });
    return tryDownload(secondary);
  }
}

/**
 * Mint a fresh read SAS for an existing blob — stored SAS links expire after
 * 24h, so human-paced flows (HR approving days later) must re-mint at use.
 */
async function freshSasUrl(container, key, ttlHours = SAS_TTL_HOURS) {
  return _sasUrl(_primary(), container, key, ttlHours);
}

/** Delete a blob (no-op success if it is already gone). */
async function deletePDF(container, key) {
  const client = _primary();
  const blobClient = client.service.getContainerClient(container).getBlobClient(key);
  const res = await blobClient.deleteIfExists();
  logger.event('blob-deleted', { container, key, existed: !!res.succeeded });
  return { success: true, existed: !!res.succeeded };
}

/**
 * List blobs older than ageHours in a container.
 * @returns {Promise<string[]>} blob names
 */
async function listOldFiles(container, ageHours) {
  const client = _primary();
  const containerClient = client.service.getContainerClient(container);
  const cutoff = Date.now() - ageHours * 3600 * 1000;
  const old = [];
  for await (const blob of containerClient.listBlobsFlat()) {
    const modified = blob.properties && blob.properties.lastModified
      ? new Date(blob.properties.lastModified).getTime()
      : 0;
    if (modified && modified < cutoff) old.push(blob.name);
  }
  return old;
}

/** Non-SAS permanent URL (for archive links stored in Monday). */
function blobUrl(container, key) {
  const cfg = config.load();
  return `https://${cfg.storage.accountName}.blob.core.windows.net/${container}/${key}`;
}

module.exports = {
  uploadPDF,
  downloadPDF,
  freshSasUrl,
  deletePDF,
  listOldFiles,
  blobUrl,
  _resetState,
};
