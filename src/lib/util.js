'use strict';
/** Shared retry + rate-limit primitives used by all external API clients. */

const logger = require('./logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isTransient(err) {
  if (err && err.transient === true) return true;
  if (err && (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' ||
              err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND')) return true;
  const status = err && err.response && err.response.status;
  // 429 + 5xx are retryable; 4xx (other than 429/408) are caller bugs.
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/**
 * Retry an async fn with exponential backoff.
 * @param {Function} fn        async () => result
 * @param {Object}   opts      { retries=3, baseDelayMs, label, shouldRetry }
 */
async function retry(fn, opts = {}) {
  const retries = opts.retries != null ? opts.retries : 3;
  const baseDelayMs = opts.baseDelayMs != null
    ? opts.baseDelayMs
    : parseInt(process.env.DOCFLOW_RETRY_BASE_MS, 10) || 500;
  const shouldRetry = opts.shouldRetry || _isTransient;
  const label = opts.label || 'operation';

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = shouldRetry(err);
      if (attempt >= retries || !retryable) {
        logger.error(`retry-exhausted:${label}`, err, { attempt, retryable });
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt); // 1x, 2x, 4x ...
      logger.warn(`retrying:${label}`, { attempt: attempt + 1, delayMs: delay, error: err.message });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Sliding-window rate limiter with a FIFO queue. acquire() resolves when a
 * slot is free, so callers queue instead of blowing quota.
 */
class RateLimiter {
  constructor(maxCalls, windowMs, label = 'rate-limiter') {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
    this.label = label;
    this.timestamps = [];
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length && this.timestamps[0] <= cutoff) this.timestamps.shift();
  }

  async acquire() {
    for (;;) {
      const now = Date.now();
      this._prune(now);
      if (this.timestamps.length < this.maxCalls) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = this.timestamps[0] + this.windowMs - now + 1;
      logger.warn(`rate-limit-queued:${this.label}`, { waitMs, inWindow: this.timestamps.length });
      await sleep(Math.max(waitMs, 1));
    }
  }

  /** How many calls are currently counted in the window (for tests/metrics). */
  get inFlight() {
    this._prune(Date.now());
    return this.timestamps.length;
  }
}

/**
 * Live progress narrator. While a long step runs, post a comment on the card
 * every `intervalMs` saying exactly what the machine is doing right now — so a
 * waiting human never stares at a silent card. Call the returned stop() in a
 * finally block; it never posts after being stopped.
 *
 * @param {Function} post async (text) => any — usually monday.logAction bound to an item
 * @param {Object} state mutable { phase: string } the caller keeps updating
 * @returns {{stop: Function, setPhase: Function}}
 */
function startProgress(post, state, intervalMs = 30000) {
  const startedAt = Date.now();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    Promise.resolve(post(`⏳ ${secs}s — ${state.phase}.`)).catch(() => {});
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref(); // never hold the process open
  return {
    setPhase(phase) { state.phase = phase; },
    stop() { stopped = true; clearInterval(timer); },
  };
}

module.exports = { sleep, retry, RateLimiter, startProgress };
