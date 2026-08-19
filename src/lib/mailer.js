'use strict';
/**
 * Microsoft Graph mail: send email AS a MedWatchers mailbox (client
 * credentials → POST /users/{sender}/sendMail). Deliberately optional —
 * until GRAPH_CLIENT_ID + GRAPH_CLIENT_SECRET + MAIL_SENDER exist in app
 * settings, isConfigured() is false and every caller falls back to posting
 * a ready-to-send draft comment (the pre-email behavior). Zero-risk arming.
 */

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

let _token = { value: null, expiresAt: 0 };

function isConfigured() {
  const gm = config.load().graphMail || {};
  return Boolean(gm.tenantId && gm.clientId && gm.clientSecret && gm.sender);
}

/**
 * Fill {{placeholders}} in a template string. Unknown tags are left intact
 * so a typo in the Monday template is visible in the sent copy, not silently
 * blanked out.
 */
function renderTemplate(str, data) {
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    (data && data[key] != null && data[key] !== '' ? String(data[key]) : match));
}

async function _getToken() {
  if (_token.value && Date.now() < _token.expiresAt - 60000) return _token.value;
  const gm = config.load().graphMail;
  const res = await axios.post(
    `https://login.microsoftonline.com/${gm.tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: gm.clientId,
      client_secret: gm.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  _token = {
    value: res.data.access_token,
    expiresAt: Date.now() + (Number(res.data.expires_in) || 3600) * 1000,
  };
  return _token.value;
}

/**
 * Send one email from the configured HR mailbox.
 * @returns {Promise<{sent:boolean, reason?:string}>} never throws on
 *          "not configured" — callers decide between send and draft-comment.
 */
async function sendMail({ to, subject, body }) {
  if (!isConfigured()) return { sent: false, reason: 'graph mail not configured' };
  if (!to || !/@/.test(String(to))) return { sent: false, reason: `invalid recipient: ${to}` };

  const gm = config.load().graphMail;
  const token = await _getToken();
  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(gm.sender)}/sendMail`,
    {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: String(to).trim() } }],
      },
      saveToSentItems: true,
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
  );
  logger.event('graph-mail-sent', { to, subject, sender: gm.sender });
  return { sent: true };
}

/** test hook */
function _resetTokenCache() { _token = { value: null, expiresAt: 0 }; }

module.exports = { isConfigured, renderTemplate, sendMail, _resetTokenCache };
