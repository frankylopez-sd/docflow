'use strict';
/**
 * Monday.com GraphQL client with Circuit Breaker integration.
 *
 * When to use circuit breaker:
 * - Monday API has generous rate limits (10 req/sec default)
 * - GraphQL errors can indicate temporary service issues or real bugs
 * - Board operations are frequent (webhooks, status updates)
 * - A single Monday outage affects multiple workflows
 *
 * Decision matrix:
 *   Operation              | Threshold | Timeout | Rationale
 *   ---------------------- | --------- | ------- | ---------------------------------
 *   Read templates         | 5 failures| 60s     | Non-blocking, can retry
 *   Read row              | 5 failures| 60s     | Blocking but idempotent
 *   Update status         | 5 failures| 60s     | Webhook can retry
 *   GraphQL query (generic)| 5 failures| 60s     | Monday is resilient
 *
 * Monday GraphQL errors are categorized:
 *   Transient: complexity, rate_limit, timeout, network -> RETRY
 *   Permanent: invalid_query, auth_error, not_found -> FAIL
 *   Unknown: any others -> FAIL SAFE (assume transient on first few)
 */

const monday = require('../monday');
const { callApi } = require('../apiClient');

const _originalFunctions = { ...monday };

/**
 * Generic GraphQL query execution with circuit breaker.
 * Catches both network failures + GraphQL errors.
 */
async function _gql(query, variables = {}, label = 'monday-query') {
  return callApi('monday', async () => {
    return _originalFunctions._gql(query, variables, label);
  }, {
    label: `monday-gql-${label}`,
    shouldRetry: (err) => {
      // GraphQL errors already have transient flag set by _gql
      if (err.transient === true) return true;
      if (err.transient === false) return false;
      // Network errors are transient
      return err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' ||
             err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND';
    },
    breakerOpts: {
      failureThreshold: 5,
      timeout: 60000,
    },
  });
}

/**
 * Read a single board item with circuit breaker.
 * Used during webhook processing -> retry with circuit protection.
 */
async function readRow(boardId, itemId) {
  return callApi('monday', async () => {
    return _originalFunctions.readRow(boardId, itemId);
  }, {
    label: `monday-read-row-${itemId}`,
    breakerOpts: {
      failureThreshold: 5,
      timeout: 60000,
    },
  });
}

/**
 * Read template catalog with circuit breaker.
 * Called at function start -> if fails, document generation can't start.
 * Fail fast to give user immediate feedback.
 */
async function readTemplates(boardId) {
  return callApi('monday', async () => {
    return _originalFunctions.readTemplates(boardId);
  }, {
    label: `monday-read-templates`,
    breakerOpts: {
      failureThreshold: 5,
      timeout: 60000,
    },
  });
}

/**
 * Update item status with circuit breaker.
 * Runs after operations complete -> can tolerate longer retry window.
 * If Monday is down, webhook will retry via dead-letter queue.
 */
async function updateStatus(boardId, itemId, values, opts = {}) {
  return callApi('monday', async () => {
    return _originalFunctions.updateStatus(boardId, itemId, values, opts);
  }, {
    label: `monday-update-status-${itemId}`,
    breakerOpts: {
      failureThreshold: 5,
      timeout: 60000,
    },
  });
}

/**
 * Update multiple items with circuit breaker.
 */
async function updateItems(boardId, items, opts = {}) {
  return callApi('monday', async () => {
    return _originalFunctions.updateItems(boardId, items, opts);
  }, {
    label: `monday-update-items-batch`,
    breakerOpts: {
      failureThreshold: 5,
      timeout: 60000,
    },
  });
}

// Test helper
function _resetState() {
  _originalFunctions._resetState();
}

// Export wrapped versions + test utilities
module.exports = {
  _gql,
  readRow,
  readTemplates,
  updateStatus,
  updateItems,
  _resetState,
};
