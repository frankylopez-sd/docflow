'use strict';
/**
 * Monday.com GraphQL client (API v2). All calls go through _gql(), which
 * applies the shared rate limiter (10/sec default) + 3x exponential-backoff
 * retry, and surfaces GraphQL errors as real errors.
 */

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const { retry, RateLimiter } = require('./util');

let _rateLimiter = null;

function _limiter() {
  if (!_rateLimiter) {
    const cfg = config.load();
    _rateLimiter = new RateLimiter(cfg.monday.rateLimitPerSec, 1000, 'monday');
  }
  return _rateLimiter;
}

function _resetState() {
  _rateLimiter = null;
}

async function _gql(query, variables = {}, label = 'monday-query') {
  const cfg = config.load();
  await _limiter().acquire();
  return retry(async () => {
    const res = await axios.post(
      cfg.monday.apiUrl,
      { query, variables },
      {
        headers: {
          Authorization: cfg.monday.token,
          'Content-Type': 'application/json',
          'API-Version': '2024-10',
        },
        timeout: 30000,
      }
    );
    if (res.data.errors && res.data.errors.length) {
      const msg = res.data.errors.map((e) => e.message).join('; ');
      const err = new Error(`Monday GraphQL error: ${msg}`);
      // Complexity/rate errors are transient — retry them.
      err.transient = /complexity|rate limit|budget/i.test(msg);
      throw err;
    }
    return res.data.data;
  }, { retries: 3, label });
}

function _parseColumnValue(cv) {
  // Prefer human text; fall back to parsed JSON value.
  if (cv.text != null && cv.text !== '') return cv.text;
  if (cv.value) {
    try { return JSON.parse(cv.value); } catch (_) { return cv.value; }
  }
  return null;
}

/**
 * Read one item with all column values.
 * @returns {Promise<Object>} {itemId, name, columns:{colId:value}, byTitle:{title:value}}
 */
async function readRow(boardId, itemId) {
  const query = `
    query ($itemId: [ID!]) {
      items (ids: $itemId) {
        id
        name
        board { id }
        column_values { id text value column { title } }
      }
    }`;
  const data = await _gql(query, { itemId: [String(itemId)] }, 'monday-read-row');
  const item = data.items && data.items[0];
  if (!item) throw new Error(`Monday item ${itemId} not found on board ${boardId}`);

  const columns = {};
  const byTitle = {};
  for (const cv of item.column_values || []) {
    const v = _parseColumnValue(cv);
    columns[cv.id] = v;
    if (cv.column && cv.column.title) byTitle[cv.column.title] = v;
  }
  return { itemId: item.id, boardId: item.board ? item.board.id : boardId, name: item.name, columns, byTitle };
}

/**
 * Fetch the hire record from the Onboarding board and map board columns to
 * canonical hire fields. Queue messages carry only {boardId, itemId} —
 * Monday is the database of record, so workers hydrate from here.
 * @returns {Promise<Object>} canonical hire fields (firstName, lastName, ...)
 */
async function fetchHireData(boardId, itemId) {
  const cfg = config.load();
  const c = cfg.monday.columns;
  const row = await readRow(boardId, itemId);

  const get = (colId, title) => {
    const v = row.columns[colId];
    if (v != null && v !== '' && typeof v !== 'object') return v;
    if (title && row.byTitle[title] != null && row.byTitle[title] !== '') return row.byTitle[title];
    return null;
  };

  // Item name is "First Last" — last-resort fallback for names.
  const nameParts = String(row.name || '').trim().split(/\s+/);

  return {
    itemId: row.itemId,
    boardId: row.boardId,
    name: row.name,
    firstName: get(c.firstName, 'First Name') || nameParts[0] || null,
    lastName: get(c.lastName, 'Last Name') || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null),
    workEmail: get(c.workEmail, 'Email'),
    adpJobTitle: get(c.jobTitle),
    adpDepartment: get(c.department),
    supervisor: get(c.supervisorName),
    payRate: get(c.payRate),
    payFrequency: get(c.payFrequency),
    payClass: get(c.payClass),
    flsaStatus: get(c.flsaStatus),
    workerType: get(c.workerType),
    startDate: get(c.startDate, 'Hired Start Date') || get(null, 'Estimated Start Date')
      || get(cfg.monday.formSync.targetColumns.startDate),
  };
}

/**
 * Read one column's raw JSON value (e.g. a link column's {url, text}).
 * @returns {Promise<Object|null>} parsed value JSON, or null when unset
 */
async function getColumnValueJson(boardId, itemId, columnId) {
  const query = `
    query ($itemId: [ID!], $columnId: [String!]) {
      items (ids: $itemId) {
        column_values (ids: $columnId) { id value }
      }
    }`;
  const data = await _gql(query, { itemId: [String(itemId)], columnId: [String(columnId)] }, 'monday-read-column-json');
  const cv = data.items && data.items[0] && data.items[0].column_values && data.items[0].column_values[0];
  if (!cv || !cv.value) return null;
  try { return JSON.parse(cv.value); } catch (_) { return null; }
}

/**
 * Update the offer-lifecycle status column (HR review gate vocabulary).
 */
async function updateOfferStatus(boardId, itemId, label) {
  const cfg = config.load();
  return updateItemColumn(boardId, itemId, cfg.monday.columns.offerStatus, { label });
}

/**
 * Find items on a board whose Name matches (contains, then exact preferred).
 * @returns {Promise<Array<{id:string,name:string}>>}
 */
async function findItemsByName(boardId, name) {
  const query = `
    query ($boardId: [ID!], $name: CompareValue!) {
      boards (ids: $boardId) {
        items_page (limit: 20, query_params: { rules: [{ column_id: "name", compare_value: $name, operator: contains_text }] }) {
          items { id name }
        }
      }
    }`;
  const data = await _gql(query, { boardId: [String(boardId)], name: String(name) }, 'monday-find-by-name');
  const items = (data.boards && data.boards[0] && data.boards[0].items_page && data.boards[0].items_page.items) || [];
  const exact = items.filter((i) => i.name.trim().toLowerCase() === String(name).trim().toLowerCase());
  return exact.length > 0 ? exact : items;
}

/**
 * Whether an item already has any updates (used for webhook-retry dedupe).
 */
async function hasUpdates(itemId) {
  const query = `
    query ($itemId: [ID!]) {
      items (ids: $itemId) { updates (limit: 1) { id } }
    }`;
  const data = await _gql(query, { itemId: [String(itemId)] }, 'monday-has-updates');
  const updates = data.items && data.items[0] && data.items[0].updates;
  return Array.isArray(updates) && updates.length > 0;
}

/**
 * Whether an item already has an update containing the given text — a
 * targeted dedupe that ignores unrelated updates (e.g. ATS import notes).
 */
async function hasUpdateContaining(itemId, needle) {
  const query = `
    query ($itemId: [ID!]) {
      items (ids: $itemId) { updates (limit: 25) { text_body } }
    }`;
  const data = await _gql(query, { itemId: [String(itemId)] }, 'monday-has-update-containing');
  const updates = (data.items && data.items[0] && data.items[0].updates) || [];
  return updates.some((u) => u && typeof u.text_body === 'string' && u.text_body.includes(needle));
}

/** Current time in Pacific local time (the team's clock). */
function ptTimestamp() {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(new Date());
  return `${formatted} PT`;
}

/**
 * Log an action on an item as a timestamped update: a Pacific-time stamp,
 * a plain-language line anyone can read, and the technical detail beneath it.
 * @param {string|number} itemId
 * @param {string} plain      what happened / what to do, in human words
 * @param {string} [technical] the precise technical explanation
 */
async function logAction(itemId, plain, technical) {
  // Comments stay warm and human — the technical detail goes to telemetry only.
  if (technical) logger.event('action-technical-detail', { itemId, technical });
  const body = `🕐 ${ptTimestamp()}\n${plain}`;
  return postUpdate(itemId, body);
}

/**
 * Post a visible update (comment) on an item — Monday notifies subscribers.
 */
async function postUpdate(itemId, body) {
  const mutation = `
    mutation ($itemId: ID!, $body: String!) {
      create_update (item_id: $itemId, body: $body) { id }
    }`;
  const data = await _gql(mutation, { itemId: String(itemId), body }, 'monday-post-update');
  if (!data.create_update || !data.create_update.id) {
    throw new Error(`Monday postUpdate: mutation returned no id for item ${itemId}`);
  }
  logger.event('monday-update-posted', { itemId });
  return data.create_update.id;
}

/**
 * ADP handoff readiness: check every required ADP field column on the hire.
 * @returns {Promise<{complete:boolean, filled:number, total:number, missing:string[]}>}
 */
async function adpReadiness(boardId, itemId) {
  const cfg = config.load();
  const fields = cfg.monday.adpFieldColumns || {};
  const row = await readRow(boardId, itemId);
  const missing = [];
  for (const [field, colId] of Object.entries(fields)) {
    const v = row.columns[colId];
    const empty = v == null || v === '' || (typeof v === 'object' && !v.label && !v.text && !v.date);
    if (empty) missing.push(field);
  }
  const total = Object.keys(fields).length;
  return { complete: missing.length === 0, filled: total - missing.length, total, missing };
}

/**
 * Downstream kickoff: create a Background Check item for a completed hire and
 * link it back to the hire row on the Onboarding board.
 * @returns {Promise<string|null>} new background-check item id
 */
async function createBackgroundCheck(hireBoardId, hireItemId, employeeName) {
  const cfg = config.load();
  const bg = cfg.monday.backgroundCheck;
  if (!bg || !bg.boardId) return null;

  // Idempotency: if the hire already links a background check, don't open
  // another one (queue redelivery / webhook duplicates).
  const existing = await getColumnValueJson(hireBoardId, hireItemId, bg.hireRelationColumn).catch(() => null);
  const linked = existing && (existing.linkedPulseIds || existing.item_ids || []);
  if (Array.isArray(linked) && linked.length > 0) {
    logger.event('background-check-already-linked', { hireItemId });
    return null;
  }

  const columnValues = {
    [bg.columns.candidate]: String(employeeName || ''),
    [bg.columns.status]: { label: 'Not Started' },
    [bg.columns.priority]: { label: 'High' },
    [bg.columns.checkType]: { labels: ['Criminal', 'Employment'] },
  };

  const mutation = `
    mutation ($boardId: ID!, $groupId: String, $itemName: String!, $columnValues: JSON) {
      create_item (board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues, create_labels_if_missing: true) {
        id
      }
    }`;
  const data = await _gql(mutation, {
    boardId: String(bg.boardId),
    groupId: bg.groupId,
    itemName: `BG Check — ${employeeName || hireItemId}`,
    columnValues: JSON.stringify(columnValues),
  }, 'monday-create-bg-check');

  const bgItemId = data.create_item && data.create_item.id;
  if (!bgItemId) throw new Error('createBackgroundCheck: create_item returned no id');

  // Link the hire row to its background check (non-fatal if the relation write fails)
  try {
    await updateItemColumn(hireBoardId, hireItemId, bg.hireRelationColumn, { item_ids: [Number(bgItemId)] });
  } catch (err) {
    logger.warn('bg-check-relation-link-failed', { hireItemId, bgItemId, error: err.message });
  }

  logger.event('background-check-created', { hireItemId, bgItemId, employeeName });
  return bgItemId;
}

/**
 * Team-editable templates: fetch the LATEST template file uploaded to the
 * Template Catalog row matching this template key. Returns null when the
 * catalog has no file (callers fall back to blob storage).
 * @returns {Promise<{buffer:Buffer, assetId:string, name:string}|null>}
 */
async function getTemplateFile(templateKey) {
  const cfg = config.load();
  const tf = cfg.monday.templateFiles;
  const query = `
    query ($boardId: [ID!]) {
      boards (ids: $boardId) {
        items_page (limit: 50) {
          items {
            id
            name
            column_values (ids: ["${tf.keyColumn}"]) { id text }
            assets (column_ids: ["${tf.fileColumn}"]) { id public_url created_at }
          }
        }
      }
    }`;
  const data = await _gql(query, { boardId: [String(cfg.monday.templateCatalogId)] }, 'monday-template-file');
  const items = (data.boards && data.boards[0] && data.boards[0].items_page && data.boards[0].items_page.items) || [];
  const row = items.find((i) => {
    const key = i.column_values && i.column_values[0] && i.column_values[0].text;
    return key && key.includes(templateKey);
  });
  if (!row || !Array.isArray(row.assets) || row.assets.length === 0) return null;

  // Latest upload wins — the team updates a template by dropping a new file
  const latest = row.assets.reduce((a, b) => (String(a.created_at) > String(b.created_at) ? a : b));
  const res = await axios.get(latest.public_url, { responseType: 'arraybuffer', timeout: 30000 });
  logger.event('template-file-from-monday', { templateKey, catalogItemId: row.id, assetId: latest.id });
  return { buffer: Buffer.from(res.data), assetId: String(latest.id), name: row.name };
}

/**
 * Read the template catalog board.
 * @returns {Promise<Array>} [{itemId, templateName, adobeTemplateId, dataFields, signers}]
 */
async function readTemplates(boardId) {
  const cfg = config.load();
  const id = boardId || cfg.monday.templateCatalogId;
  const query = `
    query ($boardId: [ID!]) {
      boards (ids: $boardId) {
        items_page (limit: 100) {
          items {
            id
            name
            column_values { id text value column { title } }
          }
        }
      }
    }`;
  const data = await _gql(query, { boardId: [String(id)] }, 'monday-read-templates');
  const board = data.boards && data.boards[0];
  if (!board) throw new Error(`Monday template catalog board ${id} not found`);

  return (board.items_page.items || []).map((item) => {
    const byTitle = {};
    for (const cv of item.column_values || []) {
      if (cv.column && cv.column.title) byTitle[cv.column.title] = _parseColumnValue(cv);
    }
    let dataFields = byTitle['Data Fields'] || byTitle['dataFields'] || [];
    if (typeof dataFields === 'string') {
      dataFields = dataFields.split(',').map((s) => s.trim()).filter(Boolean);
    }
    let signers = byTitle['Signers'] || byTitle['signers'] || [];
    if (typeof signers === 'string') {
      signers = signers.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return {
      itemId: item.id,
      templateName: item.name,
      adobeTemplateId: byTitle['Adobe Template ID'] || byTitle['adobeTemplateId'] || null,
      dataFields,
      signers,
    };
  });
}

/**
 * Write status + tracking columns back to an item, then read back to verify.
 * @param {Object} values {status, agreementId, pdfUrl, signedPdfUrl, signerDetails}
 */
async function updateStatus(boardId, itemId, values, opts = {}) {
  const cfg = config.load();
  const cols = cfg.monday.columns;
  const columnValues = {};

  if (values.status != null) columnValues[cols.status] = { label: values.status };
  if (values.agreementId != null) columnValues[cols.agreementId] = values.agreementId;
  if (values.pdfUrl != null) columnValues[cols.pdfUrl] = { url: values.pdfUrl, text: values.pdfLinkText || 'PDF' };
  if (values.signedPdfUrl != null) columnValues[cols.signedPdfUrl] = { url: values.signedPdfUrl, text: 'Signed PDF' };
  if (values.signerDetails != null) {
    columnValues[cols.signerDetails] = {
      text: typeof values.signerDetails === 'string' ? values.signerDetails : JSON.stringify(values.signerDetails),
    };
  }
  // Stamp last-touched date only when the board has a timestamp column mapped
  // (writing to a nonexistent column ID fails the whole mutation).
  if (cols.timestamp && values.stampTimestamp !== false && opts.stampTimestamp !== false) {
    columnValues[cols.timestamp] = { date: new Date().toISOString().slice(0, 10) };
  }

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $columnValues, create_labels_if_missing: true) {
        id
      }
    }`;
  const data = await retry(
    () => _gql(mutation, {
      boardId: String(boardId),
      itemId: String(itemId),
      columnValues: JSON.stringify(columnValues),
    }, 'monday-update-status'),
    { retries: 2, label: 'monday-update-status-outer', shouldRetry: () => true }
  );

  if (!data.change_multiple_column_values || !data.change_multiple_column_values.id) {
    throw new Error(`Monday updateStatus: mutation returned no id for item ${itemId}`);
  }

  // Read-back verification (skippable for non-critical writes).
  if (opts.verify !== false && values.status != null) {
    const row = await readRow(boardId, itemId);
    const written = row.columns[cols.status];
    const writtenLabel = written && written.label ? written.label : written;
    if (writtenLabel !== values.status) {
      logger.warn('monday-status-verify-mismatch', {
        itemId, expected: values.status, actual: JSON.stringify(written),
      });
    }
  }

  logger.event('monday-status-updated', { boardId, itemId, status: values.status || '(cols only)' });
  return { success: true, itemId: data.change_multiple_column_values.id };
}

/**
 * Create a row on the archive board.
 * @param {Object} row {employee, docType, signedDate, signers, pdfLink, agreementId}
 * @returns {Promise<string>} new itemId
 */
async function createArchiveRow(boardId, row) {
  const cfg = config.load();
  const id = boardId || cfg.monday.archiveBoardId;
  if (!id) throw new Error('createArchiveRow: no archive board configured (MONDAY_ARCHIVE_BOARD_ID)');

  const cols = cfg.monday.columns;
  const columnValues = {
    [cols.agreementId]: row.agreementId || '',
    [cols.signedPdfUrl]: row.pdfLink ? { url: row.pdfLink, text: 'Signed PDF' } : undefined,
    [cols.signerDetails]: row.signers
      ? { text: typeof row.signers === 'string' ? row.signers : JSON.stringify(row.signers) }
      : undefined,
    [cols.timestamp]: { date: (row.signedDate || new Date().toISOString()).slice(0, 10) },
  };
  Object.keys(columnValues).forEach((k) => columnValues[k] === undefined && delete columnValues[k]);

  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item (board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }`;
  const itemName = `${row.employee || 'Unknown'} — ${row.docType || 'Document'}`;
  const data = await _gql(mutation, {
    boardId: String(id),
    itemName,
    columnValues: JSON.stringify(columnValues),
  }, 'monday-create-archive-row');

  if (!data.create_item || !data.create_item.id) {
    throw new Error('Monday createArchiveRow: create_item returned no id');
  }
  logger.event('monday-archive-row-created', { boardId: id, itemId: data.create_item.id });
  return data.create_item.id;
}

/**
 * Batch several item reads into one query (rate-limit friendly).
 * @returns {Promise<Array>} rows in the same shape as readRow
 */
async function readRows(boardId, itemIds) {
  const query = `
    query ($itemIds: [ID!]) {
      items (ids: $itemIds) {
        id
        name
        column_values { id text value column { title } }
      }
    }`;
  const data = await _gql(query, { itemIds: itemIds.map(String) }, 'monday-read-rows-batch');
  return (data.items || []).map((item) => {
    const columns = {};
    const byTitle = {};
    for (const cv of item.column_values || []) {
      const v = _parseColumnValue(cv);
      columns[cv.id] = v;
      if (cv.column && cv.column.title) byTitle[cv.column.title] = v;
    }
    return { itemId: item.id, boardId, name: item.name, columns, byTitle };
  });
}

/**
 * Convenience wrapper: update just the status column.
 */
async function updateItemStatus(boardId, itemId, statusLabel) {
  return updateStatus(boardId, itemId, { status: statusLabel });
}

/**
 * Convenience wrapper: update just a single column.
 */
async function updateItemColumn(boardId, itemId, columnId, value) {
  const cfg = config.load();
  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $columnValues, create_labels_if_missing: true) {
        id
      }
    }`;
  const columnValues = { [columnId]: value };
  const data = await _gql(mutation, {
    boardId: String(boardId),
    itemId: String(itemId),
    columnValues: JSON.stringify(columnValues),
  }, 'monday-update-column');

  if (!data.change_multiple_column_values || !data.change_multiple_column_values.id) {
    throw new Error(`Monday updateItemColumn: mutation returned no id for item ${itemId}`);
  }

  logger.event('monday-column-updated', { boardId, itemId, columnId });
  return true;
}

/**
 * Update multiple columns at once with arbitrary raw values.
 */
async function updateItemColumns(boardId, itemId, columnValues) {
  if (!columnValues || Object.keys(columnValues).length === 0) return false;
  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $columnValues, create_labels_if_missing: true) {
        id
      }
    }`;
  const data = await _gql(mutation, {
    boardId: String(boardId),
    itemId: String(itemId),
    columnValues: JSON.stringify(columnValues),
  }, 'monday-update-columns');
  if (!data.change_multiple_column_values || !data.change_multiple_column_values.id) {
    throw new Error(`Monday updateItemColumns: mutation returned no id for item ${itemId}`);
  }
  logger.event('monday-columns-updated', { boardId, itemId, count: Object.keys(columnValues).length });
  return true;
}

/**
 * Queue a message to an Azure Service Bus queue (for local testing).
 */
async function queueMessage(queueName, messageObj) {
  // In production, this would use Azure Queue Storage.
  // For testing/local, this is mocked.
  logger.event('monday-queue-message', { queueName, messageKeys: Object.keys(messageObj) });
  return true;
}

module.exports = {
  readRow,
  readRows,
  readTemplates,
  fetchHireData,
  getTemplateFile,
  getColumnValueJson,
  updateOfferStatus,
  createBackgroundCheck,
  findItemsByName,
  postUpdate,
  logAction,
  hasUpdates,
  hasUpdateContaining,
  updateItemColumns,
  adpReadiness,
  updateStatus,
  updateItemStatus,
  updateItemColumn,
  createArchiveRow,
  queueMessage,
  _gql,
  _resetState,
};
