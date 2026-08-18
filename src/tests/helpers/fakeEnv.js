'use strict';
/**
 * Shared offline fakes: an in-memory Monday backend + axios route installer
 * covering Adobe IMS / PDF Services / Sign endpoints. Used by the
 * integration and functions test suites.
 */

const crypto = require('crypto');

const PDF_BYTES = Buffer.from('%PDF-1.7 generated-offer-letter');
const SIGNED_BYTES = Buffer.from('%PDF-1.7 signed-offer-letter-with-signatures');

function makeBackend() {
  const rows = {
    555: {
      id: '555',
      name: 'Jane Doe',
      boardId: '111',
      base: [
        { id: 'email', text: 'jane@medwatchers.com', title: 'Email' },
        { id: 'date_start', text: '2026-08-15', title: 'Start Date' },
        { id: 'text_position', text: 'Pharmacy Tech', title: 'Position' },
        { id: 'text_manager', text: 'Mayra R', title: 'Manager' },
        { id: 'text_template', text: 'Offer Letter', title: 'Template' },
        // Hire-record columns (live Onboarding board ids — see config.monday.columns)
        { id: 'text_mm6570q4', text: 'Jane', title: 'First Name' },
        { id: 'text_mm65jrfy', text: 'Doe', title: 'Last Name' },
        { id: 'text_mm65hxkh', text: 'jane@medwatchers.com', title: 'Work Email' },
        { id: 'dropdown_mm65th43', text: 'Pharmacy Tech', title: 'ADP Job Title' },
        { id: 'dropdown_mm658qx8', text: 'Pharmacy', title: 'ADP Department' },
        { id: 'dropdown_mm65wk46', text: 'Mayra R', title: 'Supervisor' },
        { id: 'numeric_mm65mx3m', text: '65000', title: 'Pay Rate' },
        { id: 'dropdown_mm658n1t', text: 'Annual', title: 'Pay Frequency' },
      ],
      written: {}, // columnId -> raw written value
    },
  };
  const archiveItems = [];

  function serialize(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    if (val.label) return val.label;
    if (val.text && !val.url) return val.text;
    if (val.url) return val.url;
    if (val.date) return val.date;
    return JSON.stringify(val);
  }

  function columnValuesFor(row) {
    const merged = new Map();
    for (const c of row.base) merged.set(c.id, { id: c.id, text: c.text, value: null, column: { title: c.title } });
    for (const [id, raw] of Object.entries(row.written)) {
      merged.set(id, { id, text: serialize(raw), value: JSON.stringify(raw), column: { title: id } });
    }
    return [...merged.values()];
  }

  function handle(body) {
    const q = body.query;
    const vars = body.variables || {};

    if (q.includes('change_multiple_column_values')) {
      const row = rows[vars.itemId];
      if (!row) return { data: { data: { change_multiple_column_values: null } } };
      Object.assign(row.written, JSON.parse(vars.columnValues));
      return { data: { data: { change_multiple_column_values: { id: row.id } } } };
    }

    if (q.includes('create_item')) {
      const item = { id: String(700 + archiveItems.length), name: vars.itemName, columns: JSON.parse(vars.columnValues) };
      archiveItems.push(item);
      return { data: { data: { create_item: { id: item.id } } } };
    }

    if (q.includes('items_page_by_column_values')) {
      // matches either the agreement-id lookup or the status ("Sent for Sign") scan
      const wanted = vars.value;
      const matches = Object.values(rows).filter((r) =>
        serialize(r.written[vars.columnId]) === wanted ||
        serialize(r.written.text_agreement) === wanted
      );
      return {
        data: {
          data: {
            items_page_by_column_values: {
              items: matches.map((m) => ({ id: m.id, name: m.name, column_values: columnValuesFor(m) })),
            },
          },
        },
      };
    }

    if (q.includes('boards')) {
      return {
        data: {
          data: {
            boards: [{
              items_page: {
                items: [{
                  id: '901',
                  name: 'Offer Letter',
                  column_values: [
                    { id: 'c1', text: 'TPL-123', value: null, column: { title: 'Adobe Template ID' } },
                    { id: 'c2', text: 'firstName,lastName,email,startDate,position', value: null, column: { title: 'Data Fields' } },
                    { id: 'c3', text: 'hr@medwatchers.com,{employee}', value: null, column: { title: 'Signers' } },
                  ],
                }],
              },
            }],
          },
        },
      };
    }

    // plain item read(s)
    const ids = vars.itemId || vars.itemIds || [];
    const found = ids.map((id) => rows[id]).filter(Boolean).map((row) => ({
      id: row.id,
      name: row.name,
      board: { id: row.boardId },
      column_values: columnValuesFor(row),
    }));
    return { data: { data: { items: found } } };
  }

  return { rows, archiveItems, handle, serialize };
}

/**
 * Wire axios.post/axios.get mocks to the fake backend + fake Adobe.
 * overrides: { pdfGenFails, signFails, agreementStatus }
 */
function installRoutes(axios, backend, overrides = {}) {
  axios.post.mockImplementation(async (url, body) => {
    if (url.includes('api.monday.com')) return backend.handle(body);
    if (url.includes('/ims/token/v3')) {
      return { data: { access_token: 'pdf-token', expires_in: 86400 } };
    }
    if (url.includes('/oauth/v2/refresh')) {
      return { data: { access_token: 'sign-refreshed-token', expires_in: 3600 } };
    }
    if (url.endsWith('/assets')) {
      // PDF Services asset creation (template upload staging)
      return { data: { uploadUri: 'https://pdf.mock/upload/tpl', assetID: 'TPL-ASSET-1' } };
    }
    if (url.includes('/operation/documentgeneration')) {
      if (overrides.pdfGenFails) {
        const err = new Error('Adobe PDF Services unavailable');
        err.response = { status: 500 };
        throw err;
      }
      return { data: {}, headers: { location: 'https://pdf.mock/job/1' } };
    }
    if (url.includes('/transientDocuments')) {
      if (overrides.signFails) {
        const err = new Error('Adobe Sign unavailable');
        err.response = { status: 503 };
        throw err;
      }
      return { data: { transientDocumentId: 'TR-1' } };
    }
    if (url.includes('/api/rest/v6/webhooks')) {
      if (overrides.webhookConflict) {
        const err = new Error('duplicate webhook');
        err.response = { status: 409 };
        throw err;
      }
      return { data: { id: 'WH-1' } };
    }
    if (url.includes('/api/rest/v6/agreements')) {
      return { data: { id: 'AGR-42' } };
    }
    throw new Error(`unexpected POST ${url}`);
  });

  // uploadAsset PUTs the template bytes to the staging URI.
  if (!axios.put) axios.put = jest.fn();
  axios.put.mockImplementation(async (url) => {
    if (url.includes('pdf.mock/upload')) return { status: 200, data: {} };
    throw new Error(`unexpected PUT ${url}`);
  });

  axios.get.mockImplementation(async (url) => {
    if (url === 'https://pdf.mock/job/1') {
      return { data: { status: 'done', asset: { downloadUri: 'https://pdf.mock/dl/1', assetID: 'ASSET-9' } } };
    }
    if (url === 'https://pdf.mock/dl/1') return { data: PDF_BYTES };
    if (url.includes('/combinedDocument')) return { data: SIGNED_BYTES };
    if (url.includes('/members')) {
      return {
        data: {
          participantSets: [
            { order: 1, status: 'COMPLETED', memberInfos: [{ email: 'hr@medwatchers.com' }] },
            { order: 2, status: 'COMPLETED', memberInfos: [{ email: 'jane@medwatchers.com' }] },
          ],
        },
      };
    }
    if (url.includes('/api/rest/v6/agreements/')) {
      return { data: { status: overrides.agreementStatus || 'SIGNED' } };
    }
    if (url.includes('.blob.core.windows.net')) return { data: PDF_BYTES };
    throw new Error(`unexpected GET ${url}`);
  });
}

function makeMondayJwt(secret) {
  const b64url = (s) => Buffer.from(s).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function checkboxEvent(jwt) {
  return {
    headers: { authorization: jwt },
    body: {
      event: {
        type: 'update_column_value',
        boardId: 111,
        pulseId: 555,
        columnId: 'checkbox',
        value: { checked: true },
      },
    },
  };
}

module.exports = { PDF_BYTES, SIGNED_BYTES, makeBackend, installRoutes, makeMondayJwt, checkboxEvent };
