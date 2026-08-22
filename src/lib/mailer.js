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

// Brand facts pulled from https://www.medwatchers.com (Webflow site, 2026-08).
// --primary500:#0066ff · --primary600:#0052cc · --text-color-brand:#1f62ff ·
// dark text #1a1925 · light gray #f7f7f8 · tagline "Better Outcomes Start Here".
const BRAND = {
  primary: '#0066ff',
  primaryDark: '#0052cc',
  link: '#1f62ff',
  text: '#1a1925',
  lightGray: '#f7f7f8',
  logoUrl: 'https://cdn.prod.website-files.com/68d970bd7751f74e5d50acbe/68d974a59ebc84637c3a1d17_Medwatchers_Logo_Primary_250501_RGB.png',
  tagline: 'Better Outcomes Start Here',
  site: 'https://www.medwatchers.com',
  hrEmail: 'MedwatchersHR@medwatchers.com',
};

/**
 * Convert the team-edited PLAIN text (source of truth: the Email Templates
 * board) into safe email HTML: escape everything, blank lines split
 * paragraphs, single newlines become <br>, URLs inside sentences become
 * links, and any line that is JUST a URL becomes a centered brand button
 * (that's how the Adobe signing link / Monday form link get their button).
 */
function _bodyToHtml(bodyText) {
  const urlRe = /(https?:\/\/[^\s<]+[^\s<.,;:!?)'"\]])/g;
  const blocks = String(bodyText || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n').map((rawLine) => {
      const line = rawLine.trim();
      const m = line.match(/^\(?(https?:\/\/[^\s<]+?)\)?$/); // standalone URL line → button
      if (m) {
        const href = _escapeHtml(m[1]);
        return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:14px auto;"><tr>`
          + `<td align="center" bgcolor="${BRAND.primary}" style="border-radius:6px;background:${BRAND.primary};">`
          + `<a href="${href}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:Arial,'Segoe UI',sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">Open link &rarr;</a>`
          + `</td></tr></table>`;
      }
      return _escapeHtml(rawLine)
        .replace(urlRe, `<a href="$1" target="_blank" style="color:${BRAND.link};font-weight:bold;">$1</a>`);
    });
    // join lines: <br> between text lines, but not around button tables
    let html = '';
    lines.forEach((l, i) => {
      const isBtn = l.startsWith('<table');
      const prevBtn = i > 0 && lines[i - 1].startsWith('<table');
      if (i > 0 && !isBtn && !prevBtn) html += '<br>\n';
      else if (i > 0) html += '\n';
      html += l;
    });
    return `<div style="margin:0 0 16px 0;">${html}</div>`;
  }).join('\n');
}

/**
 * Wrap plain template text in the MedWatchers-branded HTML shell matching
 * medwatchers.com: white header with the site logo, brand-blue accent bar,
 * white content on dark text, light-gray footer. The TEXT stays
 * team-editable in Monday; branding lives here so every email matches.
 */
function wrapBrandedHtml({ bodyText, preheader } = {}) {
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${_escapeHtml(preheader)}</div>`
    : '';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:${BRAND.lightGray};">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.lightGray};padding:24px 0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:Arial,'Segoe UI',Helvetica,sans-serif;">
<tr><td align="center" style="background:#ffffff;padding:24px 32px 18px 32px;">
  <a href="${BRAND.site}" target="_blank" style="text-decoration:none;">
    <img src="${BRAND.logoUrl}" alt="MedWatchers" width="200" style="display:block;max-width:200px;width:200px;height:auto;border:0;">
  </a>
</td></tr>
<tr><td style="background:${BRAND.primary};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px;color:${BRAND.text};font-size:15px;line-height:1.6;">
${_bodyToHtml(bodyText)}
</td></tr>
<tr><td style="padding:20px 32px;background:${BRAND.lightGray};border-top:1px solid #eeeef0;color:#6b6b76;font-size:12px;line-height:1.6;" align="center">
  <span style="color:${BRAND.text};font-weight:bold;">MedWatchers Inc.</span> &middot; ${BRAND.tagline}<br>
  Questions? <a href="mailto:${BRAND.hrEmail}" style="color:${BRAND.link};">${BRAND.hrEmail}</a> &middot; <a href="${BRAND.site}" target="_blank" style="color:${BRAND.link};">medwatchers.com</a><br>
  This email was sent by our onboarding system &mdash; just reply to reach a real person on the HR team.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** Back-compat alias — the shell used to be built here. */
function renderHtml(bodyText) { return wrapBrandedHtml({ bodyText }); }

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
    // Branded HTML shell around the team-editable text (see wrapBrandedHtml)
    body: { contentType: 'HTML', content: wrapBrandedHtml({ bodyText: body, preheader: subject }) },
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

module.exports = { isConfigured, renderTemplate, renderHtml, wrapBrandedHtml, sendMail, _resetTokenCache, BRAND };
