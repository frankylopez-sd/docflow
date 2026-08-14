'use strict';
/**
 * Circuit Breaker pattern for external API calls.
 * Prevents cascading failures by stopping requests to services that are down,
 * then periodically testing if the service has recovered.
 *
 * States:
 *   CLOSED   - service is healthy, pass through all requests
 *   OPEN     - service is failing, fail fast without trying
 *   HALF_OPEN - service was failing, testing if recovered
 *
 * Usage:
 *   const breaker = new CircuitBreaker('adobe', {
 *     failureThreshold: 5,           // open after 5 failures
 *     successThreshold: 2,           // close after 2 successes in half-open
 *     timeout: 60000,                // try recovery after 60s
 *   });
 *   const result = await breaker.execute(asyncFn);
 */

const logger = require('./logger');

const STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class CircuitBreaker {
  /**
   * @param {string} name - service name (adobe, monday, sharepoint, adp, blob)
   * @param {Object} opts
   *   - failureThreshold: number of failures to trigger OPEN (default: 5)
   *   - successThreshold: number of successes to close from HALF_OPEN (default: 2)
   *   - timeout: ms to wait before retrying (default: 60000)
   *   - halfOpenRequests: max concurrent requests in HALF_OPEN (default: 1)
   *   - onStateChange: callback(state, prev) when state transitions
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.state = STATES.CLOSED;
    this.failureThreshold = opts.failureThreshold != null ? opts.failureThreshold : 5;
    this.successThreshold = opts.successThreshold != null ? opts.successThreshold : 2;
    this.timeout = opts.timeout != null ? opts.timeout : 60000;
    this.halfOpenRequests = opts.halfOpenRequests != null ? opts.halfOpenRequests : 1;
    this.onStateChange = opts.onStateChange || null;

    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextRetryTime = null;
    this.halfOpenInFlight = 0;

    // Metrics
    this.stats = {
      totalCalls: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      rejectedByBreaker: 0,
      stateTransitions: [],
    };
  }

  /**
   * Execute an async function through the circuit breaker.
   * @param {Function} fn - async function to execute
   * @param {Object} opts - optional { label, shouldRetry }
   * @returns {Promise} result of fn()
   * @throws error if circuit is OPEN or fn fails
   */
  async execute(fn, opts = {}) {
    const label = opts.label || this.name;

    // Check if we should open the circuit
    if (this.state === STATES.OPEN) {
      if (Date.now() < this.nextRetryTime) {
        this.stats.rejectedByBreaker++;
        const err = new Error(`Circuit breaker OPEN for ${this.name} (retry in ${Math.ceil((this.nextRetryTime - Date.now()) / 1000)}s)`);
        err.code = 'CIRCUIT_BREAKER_OPEN';
        err.service = this.name;
        logger.warn(`circuit-open:${label}`, { service: this.name });
        throw err;
      }
      // Transition to HALF_OPEN to test recovery
      this._transitionTo(STATES.HALF_OPEN);
    }

    // Check HALF_OPEN capacity
    if (this.state === STATES.HALF_OPEN && this.halfOpenInFlight >= this.halfOpenRequests) {
      this.stats.rejectedByBreaker++;
      const err = new Error(`Circuit breaker HALF_OPEN for ${this.name} (capacity exceeded)`);
      err.code = 'CIRCUIT_BREAKER_HALF_OPEN';
      err.service = this.name;
      logger.warn(`circuit-half-open-full:${label}`, { service: this.name });
      throw err;
    }

    this.stats.totalCalls++;
    if (this.state === STATES.HALF_OPEN) this.halfOpenInFlight++;

    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (err) {
      this._recordFailure(err);
      throw err;
    } finally {
      if (this.state === STATES.HALF_OPEN) this.halfOpenInFlight--;
    }
  }

  _recordSuccess() {
    this.stats.totalSuccesses++;

    if (this.state === STATES.CLOSED) {
      // Reset failure count on success in CLOSED state
      this.failureCount = 0;
      return;
    }

    if (this.state === STATES.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this._transitionTo(STATES.CLOSED);
        this.failureCount = 0;
        this.successCount = 0;
      }
    }
  }

  _recordFailure(err) {
    this.stats.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === STATES.CLOSED) {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        logger.error(`circuit-opening:${this.name}`, err, {
          failureCount: this.failureCount,
          threshold: this.failureThreshold,
        });
        this._transitionTo(STATES.OPEN);
        this.nextRetryTime = Date.now() + this.timeout;
      }
    } else if (this.state === STATES.HALF_OPEN) {
      // Single failure reverts to OPEN
      this._transitionTo(STATES.OPEN);
      this.nextRetryTime = Date.now() + this.timeout;
      this.successCount = 0;
    }
  }

  _transitionTo(newState) {
    if (newState === this.state) return;
    const prevState = this.state;
    this.state = newState;
    this.stats.stateTransitions.push({ from: prevState, to: newState, time: Date.now() });
    logger.info(`circuit-state-change:${this.name}`, { from: prevState, to: newState });
    if (this.onStateChange) this.onStateChange(newState, prevState);
  }

  /** Manually close the circuit (e.g., after recovery). */
  reset() {
    this._transitionTo(STATES.CLOSED);
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextRetryTime = null;
    logger.info(`circuit-reset:${this.name}`, {});
  }

  /** Get current state and metrics. */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextRetryTime: this.nextRetryTime,
      stats: this.stats,
    };
  }
}

/**
 * Global registry of circuit breakers per service.
 * Centralized management + monitoring.
 */
class CircuitBreakerManager {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Get or create a circuit breaker for a service.
   * @param {string} serviceName - adobe, monday, sharepoint, adp, blob
   * @param {Object} opts - CircuitBreaker options
   */
  getBreaker(serviceName, opts = {}) {
    if (!this.breakers.has(serviceName)) {
      this.breakers.set(serviceName, new CircuitBreaker(serviceName, opts));
    }
    return this.breakers.get(serviceName);
  }

  /**
   * Execute through the breaker for a service.
   * Creates breaker if not exists.
   */
  async execute(serviceName, fn, opts = {}) {
    const breaker = this.getBreaker(serviceName, opts.breakerOpts);
    return breaker.execute(fn, opts);
  }

  /** Get state of all breakers. */
  getAllStates() {
    return Array.from(this.breakers.values()).map((b) => b.getState());
  }

  /** Find breakers in OPEN or HALF_OPEN state. */
  getOpenBreakers() {
    return Array.from(this.breakers.values())
      .filter((b) => b.state !== STATES.CLOSED)
      .map((b) => b.getState());
  }

  /** Reset all breakers. */
  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// Global singleton manager
const manager = new CircuitBreakerManager();

module.exports = {
  CircuitBreaker,
  CircuitBreakerManager,
  manager,
  STATES,
};
