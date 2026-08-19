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
    startDate: get(c.startDate, 'Hired Start Date') || get(null, 'Estimated Start Date'),
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
  getColumnValueJson,
  updateOfferStatus,
  updateStatus,
  updateItemStatus,
  updateItemColumn,
  createArchiveRow,
  queueMessage,
  _gql,
  _resetState,
};
