'use strict';
/**
 * API Client wrapper combining Circuit Breaker + Retry patterns.
 * Provides common integration point for all external APIs with:
 * - Circuit breaking (fail-fast when service is down)
 * - Exponential backoff retry (handle transient failures)
 * - Rate limiting (respect API quotas)
 * - Metrics collection (observability)
 */

const { manager: circuitBreakerManager, STATES } = require('./circuitBreaker');
const { retry } = require('./util');
const logger = require('./logger');

/**
 * Call an external API with circuit breaker + retry.
 *
 * Decision flow:
 *   1. Check circuit breaker state
 *   2. If OPEN -> fail fast
 *   3. If CLOSED/HALF_OPEN -> call retry() with exponential backoff
 *   4. Circuit breaker records success/failure and may transition
 *
 * @param {string} serviceName - adobe, monday, sharepoint, adp, blob
 * @param {Function} fn - async () => result (the API call)
 * @param {Object} opts
 *   - retries: number of retries (default: 3)
 *   - baseDelayMs: initial retry delay (default: 500)
 *   - label: operation label for logging
 *   - shouldRetry: custom retry predicate
 *   - breakerOpts: circuit breaker config
 *   - timeout: request timeout ms (handled by client)
 *
 * @returns {Promise} result or throws error
 * @throws CircuitBreakerOpenError | RetryExhaustedError | API error
 */
async function callApi(serviceName, fn, opts = {}) {
  const label = opts.label || `${serviceName}-call`;
  const breakerOpts = opts.breakerOpts || {};

  // Build default breaker options by service
  if (!breakerOpts.failureThreshold) {
    breakerOpts.failureThreshold = getDefaultThreshold(serviceName).failureThreshold;
  }
  if (!breakerOpts.timeout) {
    breakerOpts.timeout = getDefaultThreshold(serviceName).timeout;
  }

  return circuitBreakerManager.execute(serviceName, async () => {
    // Call with exponential backoff retry
    return retry(fn, {
      retries: opts.retries,
      baseDelayMs: opts.baseDelayMs,
      label,
      shouldRetry: opts.shouldRetry,
    });
  }, { label, breakerOpts });
}

/**
 * Get default circuit breaker thresholds by service.
 * Services with tighter SLAs get stricter thresholds.
 */
function getDefaultThreshold(serviceName) {
  const defaults = {
    adobe: {
      failureThreshold: 3,     // Adobe is critical; fail fast
      successThreshold: 2,
      timeout: 30000,          // 30s before retry
      halfOpenRequests: 1,
    },
    monday: {
      failureThreshold: 5,     // Monday is resilient
      successThreshold: 2,
      timeout: 60000,          // 60s before retry
      halfOpenRequests: 2,
    },
    sharepoint: {
      failureThreshold: 3,     // SharePoint auth is critical
      successThreshold: 2,
      timeout: 45000,
      halfOpenRequests: 1,
    },
    adp: {
      failureThreshold: 4,     // ADP user sync is less frequent
      successThreshold: 2,
      timeout: 60000,
      halfOpenRequests: 1,
    },
    blob: {
      failureThreshold: 5,     // Blob storage has built-in redundancy
      successThreshold: 2,
      timeout: 45000,
      halfOpenRequests: 2,
    },
  };

  return defaults[serviceName] || {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60000,
    halfOpenRequests: 1,
  };
}

/**
 * Health check endpoint for external APIs.
 * Returns state of all circuit breakers + last failure details.
 *
 * Used by: /api/health, monitoring dashboards
 */
function getHealthStatus() {
  const breakers = circuitBreakerManager.getAllStates();
  const open = circuitBreakerManager.getOpenBreakers();

  const healthy = breakers.every((b) => b.state === STATES.CLOSED);
  const status = healthy ? 'healthy' : 'degraded';

  return {
    status,
    timestamp: new Date().toISOString(),
    apis: breakers,
    open: open.map((b) => ({ service: b.name, retryAt: b.nextRetryTime })),
  };
}

/**
 * Reset circuit breaker for a service (manual recovery).
 * Useful after confirming a service has recovered.
 */
function resetBreaker(serviceName) {
  const breaker = circuitBreakerManager.getBreaker(serviceName);
  breaker.reset();
  logger.info(`breaker-manual-reset:${serviceName}`, { state: breaker.getState() });
}

module.exports = {
  callApi,
  getHealthStatus,
  resetBreaker,
  getDefaultThreshold,
  circuitBreakerManager,
};
