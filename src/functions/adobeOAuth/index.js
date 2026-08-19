'use strict';

const axios = require('axios');
const config = require('../../lib/config');
const logger = require('../../lib/logger');

/**
 * adobeOAuth: one-time Adobe Sign OAuth connector.
 *   GET /api/adobeOAuth?start=1  -> redirects to Adobe's consent screen
 *   GET /api/adobeOAuth?code=... -> exchanges the code, stores the refresh
 *                                   token in a PRIVATE blob for ops pickup
 * The refresh token is never displayed in the browser or logged.
 */

const REDIRECT_URI = 'https://doc-automation-func.azurewebsites.net/api/adobeOAuth';
const SCOPES = 'agreement_read:account agreement_write:account agreement_send:account webhook_read:account webhook_write:account library_read:account';

function html(status, title, message) {
  return {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Segoe UI,sans-serif;max-width:34em;margin:12vh auto;padding:0 1.5em;line-height:1.6"><h2>${title}</h2><p>${message}</p></body>`,
  };
}

module.exports = async function (context, req) {
  const cfg = config.load();
  const q = (req && req.query) || {};

  try {
    const clientId = cfg.adobe.signClientId;
    const clientSecret = cfg.adobe.signClientSecret;
    if (!clientId || !clientSecret) {
      context.res = html(500, '⚠️ Not configured', 'ADOBE_SIGN_CLIENT_ID / ADOBE_SIGN_CLIENT_SECRET are not set on the app.');
      return;
    }

    // Step 1: kick off the consent flow
    if (q.start) {
      const authorize = 'https://secure.na1.adobesign.com/public/oauth/v2'
        + `?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
        + `&response_type=code&client_id=${encodeURIComponent(clientId)}`
        + `&scope=${encodeURIComponent(SCOPES)}&state=docflow`;
      context.res = { status: 302, headers: { Location: authorize }, body: '' };
      return;
    }

    // Adobe sent the user back with an error (e.g. scope not enabled on the app)
    if (q.error) {
      logger.warn('adobe-oauth-consent-error', { error: q.error, description: q.error_description });
      context.res = html(400, '🛑 Adobe said no', `Adobe returned: <b>${q.error}</b> — ${q.error_description || ''}. Check the app's configured scopes and redirect URI, then try again.`);
      return;
    }

    // Step 2: exchange the authorization code
    if (q.code) {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code: q.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
      });
      const res = await axios.post(`${cfg.adobe.signApiUrl}/oauth/v2/token`, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
      });

      const { refresh_token, api_access_point } = res.data;
      if (!refresh_token) throw new Error('token exchange returned no refresh_token');

      // Park the secrets in a PRIVATE blob for ops to move into app settings
      const { BlobServiceClient } = require('@azure/storage-blob');
      const svc = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage);
      const container = svc.getContainerClient('secrets');
      await container.createIfNotExists();
      const payload = JSON.stringify({ refresh_token, api_access_point, obtainedAt: new Date().toISOString() });
      await container.getBlockBlobClient('adobe-sign-oauth.json').uploadData(Buffer.from(payload), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });

      logger.event('adobe-oauth-connected', { apiAccessPoint: api_access_point });
      context.res = html(200, '✅ Adobe Sign connected!',
        'The signing connection is captured. You can close this tab — the rest is automatic. 🎉');
      return;
    }

    context.res = html(200, 'Adobe Sign connector',
      `Append <code>?start=1</code> to this URL to begin the one-time connection.`);
  } catch (error) {
    logger.error('adobe-oauth-error', { error: error.message, detail: error.response ? JSON.stringify(error.response.data).slice(0, 300) : null });
    context.res = html(500, '❌ Connection failed', `${error.message}. The details are in the system logs — ping Francisco/IT.`);
  }
};
