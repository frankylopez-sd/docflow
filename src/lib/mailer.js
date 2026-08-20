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

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Wrap plain template text in the MedWatchers-branded HTML shell: teal
 * header, readable body (URLs become real links), quiet footer. The TEXT
 * stays team-editable in Monday; branding lives here so every email matches.
 */
function renderHtml(bodyText) {
  const paragraphs = _escapeHtml(bodyText)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0b7a6b;font-weight:bold;">$1</a>')
    .replace(/\n/g, '<br>\n');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f2f4f3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f3;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;">
<tr><td style="background:#0b7a6b;padding:20px 32px;">
  <span style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:0.5px;">MedWatchers</span>
  <span style="color:#bfe5de;font-size:13px;padding-left:10px;">HR &amp; Onboarding</span>
</td></tr>
<tr><td style="padding:28px 32px;color:#20302c;font-size:15px;line-height:1.6;">
${paragraphs}
</td></tr>
<tr><td style="padding:16px 32px;background:#f7faf9;border-top:1px solid #e3ebe8;color:#7d8f8a;font-size:12px;line-height:1.5;">
  MedWatchers HR &middot; this email was sent by our onboarding system &mdash; just reply to reach a real person on the HR team.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
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
 * @param {Object} opts {to, subject, body, attachments?: [{name, content:Buffer}|{name, contentBytes:base64}]}
 * @returns {Promise<{sent:boolean, reason?:string}>} never throws on
 *          "not configured" — callers decide between send and draft-comment.
 */
async function sendMail({ to, subject, body, attachments }) {
  if (!isConfigured()) return { sent: false, reason: 'graph mail not configured' };
  if (!to || !/@/.test(String(to))) return { sent: false, reason: `invalid recipient: ${to}` };

  const gm = config.load().graphMail;
  const token = await _getToken();
  const message = {
    subject,
    // Branded HTML shell around the team-editable text (see renderHtml)
    body: { contentType: 'HTML', content: renderHtml(body) },
    toRecipients: [{ emailAddress: { address: String(to).trim() } }],
  };
  if (Array.isArray(attachments) && attachments.length > 0) {
    message.attachments = attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentBytes: a.contentBytes || Buffer.from(a.content).toString('base64'),
    }));
  }
  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(gm.sender)}/sendMail`,
    { message, saveToSentItems: true },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
  );
  logger.event('graph-mail-sent', { to, subject, sender: gm.sender, attachments: (attachments || []).length });
  return { sent: true };
}

/** test hook */
function _resetTokenCache() { _token = { value: null, expiresAt: 0 }; }

module.exports = { isConfigured, renderTemplate, renderHtml, sendMail, _resetTokenCache };
