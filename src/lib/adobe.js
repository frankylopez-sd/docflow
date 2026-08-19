'use strict';
/**
 * Adobe clients: PDF Services (Document Generation) + Adobe Sign (envelopes).
 * REST via axios (instead of the heavyweight @adobe/pdfservices-node-sdk) so
 * every call is mockable offline and cold-start stays fast.
 */

const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');
const logger = require('./logger');
const { retry, sleep, RateLimiter } = require('./util');

const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh 10 min before expiry
const POLL_INTERVAL_MS = () => parseInt(process.env.DOCFLOW_ADOBE_POLL_MS, 10) || 2000;
const MAX_POLLS = 60;

// module-level token cache: { pdf: {token, expiresAt}, sign: {...} }
const _tokens = { pdf: null, sign: null };
let _rateLimiter = null;

function _limiter() {
  if (!_rateLimiter) {
    const cfg = config.load();
    _rateLimiter = new RateLimiter(cfg.adobe.rateLimitPerMin, 60 * 1000, 'adobe');
  }
  return _rateLimiter;
}

/** Test helper: clear cached tokens/limiter. */
function _resetState() {
  _tokens.pdf = null;
  _tokens.sign = null;
  _rateLimiter = null;
}

// ---------------------------------------------------------------------------
// OAuth token management
// ---------------------------------------------------------------------------

async function _fetchPdfServicesToken() {
  const cfg = config.load();
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.adobe.clientId,
    client_secret: cfg.adobe.clientSecret,
    scope: 'openid,AdobeID,DCAPI',
  });
  const res = await axios.post(`${cfg.adobe.imsUrl}/ims/token/v3`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in * 1000),
  };
}

async function _fetchSignToken() {
  const cfg = config.load();
  if (cfg.adobe.signIntegrationKey) {
    // Static integration key never expires from our perspective.
    return { token: cfg.adobe.signIntegrationKey, expiresAt: Number.MAX_SAFE_INTEGER };
  }
  if (!cfg.adobe.signRefreshToken) {
    throw new Error('Adobe Sign auth not configured: set ADOBE_SIGN_INTEGRATION_KEY or ADOBE_SIGN_REFRESH_TOKEN');
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.adobe.signRefreshToken,
    client_id: cfg.adobe.signClientId || cfg.adobe.clientId,
    client_secret: cfg.adobe.signClientSecret || cfg.adobe.clientSecret,
  });
  const res = await axios.post(`${cfg.adobe.signApiUrl}/oauth/v2/refresh`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in * 1000),
  };
}

/**
 * Return a valid bearer token for 'pdf' or 'sign', refreshing when within
 * 10 minutes of expiry.
 */
async function getToken(kind) {
  const cached = _tokens[kind];
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return cached.token;
  }
  const fresh = await retry(
    kind === 'pdf' ? _fetchPdfServicesToken : _fetchSignToken,
    { retries: 3, label: `adobe-token-${kind}` }
  );
  _tokens[kind] = fresh;
  logger.event('adobe-token-refreshed', { kind });
  return fresh.token;
}

async function _pdfHeaders() {
  const cfg = config.load();
  return {
    Authorization: `Bearer ${await getToken('pdf')}`,
    'x-api-key': cfg.adobe.clientId,
    'Content-Type': 'application/json',
  };
}

async function _signHeaders() {
  return { Authorization: `Bearer ${await getToken('sign')}` };
}

// ---------------------------------------------------------------------------
// Merge-field validation
// ---------------------------------------------------------------------------

/**
 * Validate a data object against a template schema.
 * @param {Object} templateSchema {fields:[{name, required}] } or [names]
 * @param {Object} data           merge data
 * @returns {Object} { fields, missing } — throws when required fields absent
 */
function extractMergeFields(templateSchema, data) {
  let fields;
  if (Array.isArray(templateSchema)) {
    fields = templateSchema.map((f) => (typeof f === 'string' ? { name: f, required: true } : f));
  } else if (templateSchema && Array.isArray(templateSchema.fields)) {
    fields = templateSchema.fields.map((f) => (typeof f === 'string' ? { name: f, required: true } : f));
  } else {
    throw new Error('extractMergeFields: template schema must be an array or {fields:[...]}');
  }

  const missing = fields
    .filter((f) => f.required !== false)
    .filter((f) => data[f.name] == null || String(data[f.name]).trim() === '')
    .map((f) => f.name);

  if (missing.length > 0) {
    const err = new Error(`Merge data missing required fields: ${missing.join(', ')}`);
    err.code = 'MISSING_MERGE_FIELDS';
    err.missing = missing;
    throw err;
  }
  return { fields: fields.map((f) => f.name), missing: [] };
}

// ---------------------------------------------------------------------------
// PDF Services — Document Generation
// ---------------------------------------------------------------------------

/**
 * Generate a PDF from an uploaded template asset + merge data.
 * @param {string} templateId  PDF Services asset id of the template
 * @param {Object} data        merge data ({firstName, lastName, ...})
 * @param {Object} [schema]    optional field schema to validate against
 * @returns {Promise<{pdfId:string, buffer:Buffer}>}
 */
async function createPDF(templateId, data, schema) {
  if (!templateId) throw new Error('createPDF: templateId is required');
  if (!data || typeof data !== 'object') throw new Error('createPDF: data object is required');
  if (schema) extractMergeFields(schema, data);

  const cfg = config.load();
  await _limiter().acquire();

  // 1. submit generation job (retry transient failures)
  const jobLocation = await retry(async () => {
    const headers = await _pdfHeaders();
    const res = await axios.post(
      `${cfg.adobe.pdfServicesUrl}/operation/documentgeneration`,
      { assetID: templateId, outputFormat: 'pdf', jsonDataForMerge: data },
      { headers, timeout: 30000 }
    );
    const location = res.headers && (res.headers.location || res.headers.Location);
    if (!location) throw new Error('PDF Services did not return a job location header');
    return location;
  }, { retries: 3, label: 'adobe-pdf-submit' });

  // 2. poll until done
  let downloadUri = null;
  let pdfId = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    const headers = await _pdfHeaders();
    const res = await retry(
      () => axios.get(jobLocation, { headers, timeout: 30000 }),
      { retries: 3, label: 'adobe-pdf-poll' }
    );
    const status = res.data && res.data.status;
    if (status === 'done') {
      downloadUri = res.data.asset && res.data.asset.downloadUri;
      pdfId = (res.data.asset && res.data.asset.assetID) || null;
      break;
    }
    if (status === 'failed') {
      const detail = res.data.error ? JSON.stringify(res.data.error) : 'unknown';
      throw new Error(`PDF generation job failed: ${detail}`);
    }
    await sleep(POLL_INTERVAL_MS());
  }
  if (!downloadUri) throw new Error('PDF generation timed out waiting for job completion');

  // 3. download the result (pre-signed URI — no auth headers)
  const fileRes = await retry(
    () => axios.get(downloadUri, { responseType: 'arraybuffer', timeout: 60000 }),
    { retries: 3, label: 'adobe-pdf-download' }
  );
  const buffer = Buffer.from(fileRes.data);
  logger.event('pdf-generated', { templateId, pdfId, bytes: buffer.length });
  return { pdfId: pdfId || `pdf_${Date.now()}`, buffer };
}

// ---------------------------------------------------------------------------
// Adobe Sign — envelopes (agreements)
// ---------------------------------------------------------------------------

/**
 * Upload a PDF as a transient document (required before creating an agreement).
 * @returns {Promise<string>} transientDocumentId
 */
async function uploadTransientDocument(buffer, fileName = 'document.pdf') {
  const cfg = config.load();
  await _limiter().acquire();
  const headers = await _signHeaders();

  return retry(async () => {
    const form = new FormData();
    form.append('File', buffer, { filename: fileName, contentType: 'application/pdf' });
    form.append('Mime-Type', 'application/pdf');
    const res = await axios.post(
      `${cfg.adobe.signApiUrl}/api/rest/v6/transientDocuments`,
      form,
      { headers: { ...headers, ...form.getHeaders() }, timeout: 60000, maxBodyLength: Infinity }
    );
    return res.data.transientDocumentId;
  }, { retries: 3, label: 'sign-transient-upload' });
}

/**
 * Create a signing envelope (agreement) with serial signing order.
 * @param {Buffer|string} pdf     PDF buffer, or an https URL to fetch first
 * @param {Array}  signers        [{email, name?, role?}] in signing order
 * @param {Object} [opts]         { name, order='SEQUENTIAL', message }
 * @returns {Promise<{agreementId:string, signers:Array}>}
 */
async function createEnvelope(pdf, signers, opts = {}) {
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error('createEnvelope: at least one signer is required');
  }
  for (const s of signers) {
    if (!s.email) throw new Error('createEnvelope: every signer needs an email');
  }
  const cfg = config.load();

  let buffer = pdf;
  if (typeof pdf === 'string') {
    const res = await retry(
      () => axios.get(pdf, { responseType: 'arraybuffer', timeout: 60000 }),
      { retries: 3, label: 'sign-fetch-pdf' }
    );
    buffer = Buffer.from(res.data);
  }
  if (!Buffer.isBuffer(buffer)) throw new Error('createEnvelope: pdf must be a Buffer or URL string');

  const transientDocumentId = await uploadTransientDocument(buffer, opts.fileName || 'document.pdf');

  const body = {
    fileInfos: [{ transientDocumentId }],
    name: opts.name || 'DocFlow Agreement',
    participantSetsInfo: signers.map((s, i) => ({
      order: i + 1, // serial order: HR -> Manager -> Employee
      role: s.role || 'SIGNER',
      memberInfos: [{ email: s.email, ...(s.name ? { name: s.name } : {}) }],
    })),
    signatureType: 'ESIGN',
    state: 'IN_PROCESS',
    ...(opts.message ? { message: opts.message } : {}),
  };

  await _limiter().acquire();
  const agreementId = await retry(async () => {
    const headers = await _signHeaders();
    const res = await axios.post(
      `${cfg.adobe.signApiUrl}/api/rest/v6/agreements`,
      body,
      { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    return res.data.id;
  }, { retries: 3, label: 'sign-create-agreement' });

  logger.event('sign-envelope-created', { agreementId, signerCount: signers.length });
  return {
    agreementId,
    signers: signers.map((s, i) => ({ email: s.email, order: i + 1, status: 'WAITING' })),
  };
}

/**
 * Ensure a webhook is registered so Adobe notifies us when agreements
 * complete. Idempotent-ish: Adobe rejects exact duplicates; we swallow that.
 */
async function ensureWebhook(webhookUrl) {
  const cfg = config.load();
  const url = webhookUrl || cfg.adobe.webhookUrl;
  if (!url) throw new Error('ensureWebhook: no webhook URL configured (ADOBE_WEBHOOK_URL)');

  const headers = await _signHeaders();
  try {
    const res = await axios.post(
      `${cfg.adobe.signApiUrl}/api/rest/v6/webhooks`,
      {
        name: 'docflow-agreement-events',
        scope: 'ACCOUNT',
        state: 'ACTIVE',
        webhookSubscriptionEvents: ['AGREEMENT_WORKFLOW_COMPLETED', 'AGREEMENT_ACTION_COMPLETED'],
        webhookUrlInfo: { url },
      },
      { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    logger.event('sign-webhook-registered', { webhookId: res.data.id, url });
    return res.data.id;
  } catch (err) {
    if (err.response && err.response.status === 409) {
      logger.info('sign-webhook-already-exists', { url });
      return null;
    }
    throw err;
  }
}

/** Get agreement status + per-signer progress. */
async function getAgreementStatus(agreementId) {
  const cfg = config.load();
  await _limiter().acquire();
  const res = await retry(async () => {
    const headers = await _signHeaders();
    return axios.get(`${cfg.adobe.signApiUrl}/api/rest/v6/agreements/${agreementId}`, {
      headers, timeout: 30000,
    });
  }, { retries: 3, label: 'sign-get-status' });

  const members = await retry(async () => {
    const headers = await _signHeaders();
    return axios.get(`${cfg.adobe.signApiUrl}/api/rest/v6/agreements/${agreementId}/members`, {
      headers, timeout: 30000,
    });
  }, { retries: 3, label: 'sign-get-members' });

  const signerStatuses = (members.data.participantSets || []).map((ps) => ({
    order: ps.order,
    status: ps.status,
    emails: (ps.memberInfos || []).map((m) => m.email),
  }));
  return { agreementId, status: res.data.status, signers: signerStatuses };
}

/** Download the fully-signed combined PDF. Retries 2x, then throws. */
async function getSignedPDF(agreementId) {
  if (!agreementId) throw new Error('getSignedPDF: agreementId is required');
  const cfg = config.load();
  await _limiter().acquire();
  const res = await retry(async () => {
    const headers = await _signHeaders();
    return axios.get(
      `${cfg.adobe.signApiUrl}/api/rest/v6/agreements/${agreementId}/combinedDocument`,
      { headers, responseType: 'arraybuffer', timeout: 120000 }
    );
  }, { retries: 2, label: 'sign-download-signed' });
  const buffer = Buffer.from(res.data);
  logger.event('signed-pdf-downloaded', { agreementId, bytes: buffer.length });
  return buffer;
}

// ---------------------------------------------------------------------------
// High-level wrappers for document generation and signing
// ---------------------------------------------------------------------------

/**
 * Upload a document as a PDF Services asset (required before doc generation).
 * PDF Services assets are TRANSIENT (~24h) — never persist their IDs.
 * @param {Buffer} buffer     file contents
 * @param {string} mediaType  e.g. docx mime type
 * @returns {Promise<string>} assetID
 */
async function uploadAsset(buffer, mediaType) {
  const cfg = config.load();
  await _limiter().acquire();
  const headers = await _pdfHeaders();

  const res = await retry(async () => axios.post(
    `${cfg.adobe.pdfServicesUrl}/assets`,
    { mediaType },
    { headers, timeout: 30000 }
  ), { retries: 3, label: 'pdf-asset-create' });

  const { uploadUri, assetID } = res.data;
  await retry(async () => axios.put(uploadUri, buffer, {
    headers: { 'Content-Type': mediaType },
    timeout: 60000,
    maxBodyLength: Infinity,
  }), { retries: 3, label: 'pdf-asset-upload' });

  return assetID;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Adobe assets expire (~24h); cache each uploaded template well under that.
const TEMPLATE_ASSET_TTL_MS = 12 * 60 * 60 * 1000;
const _templateAssetCache = new Map(); // templateKey -> {assetID, uploadedAt}

/**
 * Resolve a fresh Adobe asset ID for a template blob.
 * The durable copy lives in blob storage (pdf-templates container) — Adobe's
 * copy is transient, so it is re-uploaded on expiry.
 * @param {string} templateKey blob name within pdf-templates
 */
async function _resolveTemplateAsset(templateKey, force = false) {
  const blob = require('./blob'); // late requires avoid circular imports at load
  const monday = require('./monday');

  // Source of truth: the Template Catalog board (team drops a new .docx on
  // the row to update a letter). A new upload = new Monday asset id = new
  // cache key, so team edits take effect on the very next generation.
  let templateBuffer = null;
  let cacheKey = templateKey;
  try {
    const fromMonday = await monday.getTemplateFile(templateKey);
    if (fromMonday) {
      cacheKey = `${templateKey}:${fromMonday.assetId}`;
      const cached = _templateAssetCache.get(cacheKey);
      if (cached && (Date.now() - cached.uploadedAt) < TEMPLATE_ASSET_TTL_MS && !force) return cached.assetID;
      templateBuffer = fromMonday.buffer;
    }
  } catch (err) {
    logger.warn('template-monday-fetch-failed-falling-back', { templateKey, error: err.message });
  }

  // Fallback: the durable blob copy
  if (!templateBuffer) {
    const cached = _templateAssetCache.get(cacheKey);
    if (cached && (Date.now() - cached.uploadedAt) < TEMPLATE_ASSET_TTL_MS && !force) return cached.assetID;
    templateBuffer = await blob.downloadPDF('pdf-templates', templateKey);
  }

  const assetID = await uploadAsset(templateBuffer, DOCX_MIME);
  _templateAssetCache.set(cacheKey, { assetID, uploadedAt: Date.now() });
  logger.event('adobe-template-asset-uploaded', { templateKey, assetID, source: cacheKey === templateKey ? 'blob' : 'monday' });
  return assetID;
}

/**
 * Generate an offer letter PDF using Adobe PDF Services.
 * Templates live durably in blob storage; a transient Adobe asset is
 * uploaded on demand (and re-uploaded if Adobe reports it expired).
 * @param {Object} mergeData  {firstName, lastName, jobTitle, department, email, supervisor, compensation, frequency, startDate, generatedDate}
 * @param {Object} [opts]     {templateKey} — blob name in pdf-templates; defaults to the clerk letter
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateOfferLetter(mergeData, opts = {}) {
  const schema = [
    'firstName', 'lastName', 'jobTitle', 'department',
    'email', 'supervisor', 'compensation', 'frequency', 'startDate', 'generatedDate'
  ];
  const templateKey = opts.templateKey
    || process.env.ADOBE_TEMPLATE_BLOB_OFFER_LETTER
    || 'offer-letter-clerk.docx';

  let templateId = await _resolveTemplateAsset(templateKey);
  try {
    const { buffer } = await createPDF(templateId, mergeData, schema);
    return buffer;
  } catch (err) {
    // Cached asset may have expired server-side — re-upload once and retry.
    const status = err.response && err.response.status;
    if (status === 404 || status === 400) {
      logger.warn('adobe-template-asset-stale-retrying', { templateKey, status });
      templateId = await _resolveTemplateAsset(templateKey, true);
      const { buffer } = await createPDF(templateId, mergeData, schema);
      return buffer;
    }
    throw err;
  }
}

/**
 * Download the fully-signed PDF (alias for getSignedPDF).
 * @param {string} agreementId Adobe Sign agreement ID
 * @returns {Promise<Buffer>} PDF buffer
 */
async function downloadSignedDocument(agreementId) {
  return getSignedPDF(agreementId);
}

/**
 * The candidate's direct signing URL for an agreement. Adobe issues it a
 * moment after the agreement goes out, so poll briefly; return null when it
 * never materializes (callers fall back to "watch for the Adobe email").
 * @returns {Promise<string|null>}
 */
async function getSigningUrl(agreementId, opts = {}) {
  const { attempts = 5, delayMs = 2000 } = opts;
  const cfg = config.load();
  for (let i = 0; i < attempts; i++) {
    try {
      await _limiter().acquire();
      const headers = await _signHeaders();
      const res = await axios.get(`${cfg.adobe.signApiUrl}/api/rest/v6/agreements/${agreementId}/signingUrls`, {
        headers, timeout: 30000,
      });
      const sets = res.data && res.data.signingUrlSetInfos;
      const url = sets && sets[0] && sets[0].signingUrls && sets[0].signingUrls[0]
        && sets[0].signingUrls[0].esignUrl;
      if (url) return url;
    } catch (err) {
      const status = err.response && err.response.status;
      // 404 = Adobe is still preparing the agreement — keep polling
      if (status && status !== 404) {
        logger.warn('sign-signing-url-failed', { agreementId, status, error: err.message });
        return null;
      }
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  logger.warn('sign-signing-url-unavailable', { agreementId });
  return null;
}

/**
 * Create a signing agreement (wrapper around createEnvelope with better ergonomics).
 * @param {Object} opts {documentUrl, fileName, signers, message, dueDate}
 * @returns {Promise<{id:string, signers:Array}>}
 */
async function createSigningAgreement(opts) {
  const { documentUrl, fileName, signers, message, dueDate } = opts;

  if (!documentUrl) throw new Error('createSigningAgreement: documentUrl is required');
  if (!signers || !Array.isArray(signers)) throw new Error('createSigningAgreement: signers array is required');

  const envelope = await createEnvelope(documentUrl, signers, {
    fileName: fileName || 'document.pdf',
    name: `Offer Letter - ${signers[signers.length - 1].name || 'Employee'}`,
    message: message || 'Please review and sign this document'
  });

  return {
    id: envelope.agreementId,
    signers: envelope.signers,
    dueDate: dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  };
}

module.exports = {
  getToken,
  createPDF,
  extractMergeFields,
  uploadTransientDocument,
  createEnvelope,
  ensureWebhook,
  getAgreementStatus,
  getSignedPDF,
  getSigningUrl,
  downloadSignedDocument,
  generateOfferLetter,
  createSigningAgreement,
  _resetState,
};
