'use strict';
/**
 * Retry Logic Tests: Comprehensive coverage of transient failure handling.
 *
 * Tests cover:
 * - Network-level transient errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNABORTED)
 * - HTTP transient errors (429, 408, 500-599)
 * - Exponential backoff timing and jitter
 * - Retry exhaustion with proper error propagation
 * - Custom shouldRetry predicates
 * - Rate limiter integration during retries
 * - Mixed scenarios (transient then success, transient then permanent)
 * - Permanent errors (4xx non-429/408, network errors marked non-transient)
 */

const { retry, sleep, RateLimiter } = require('../lib/util');
const logger = require('../lib/logger');

// Mock logger to verify logging behavior
jest.mock('../lib/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  event: jest.fn(),
}));

describe('retry() - Transient Failure Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // NETWORK-LEVEL TRANSIENT ERRORS
  // ============================================================================

  describe('Network Transient Errors', () => {
    it('should retry on ECONNRESET', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('Connection reset');
          err.code = 'ECONNRESET';
          throw err;
        }
        return 'success';
      };

      const result = await retry(fn, { retries: 3, baseDelayMs: 10, label: 'test-econnreset' });
      expect(result).toBe('success');
      expect(attempts).toBe(3);
      expect(logger.warn).toHaveBeenCalledWith(
        'retrying:test-econnreset',
        expect.objectContaining({ attempt: 1, delayMs: 10 })
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'retrying:test-econnreset',
        expect.objectContaining({ attempt: 2, delayMs: 20 })
      );
    });

    it('should retry on ETIMEDOUT', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Request timeout');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'timeout-recovered';
      };

      const result = await retry(fn, { retries: 2, baseDelayMs: 10 });
      expect(result).toBe('timeout-recovered');
      expect(attempts).toBe(2);
    });

    it('should retry on ENOTFOUND (DNS)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('DNS lookup failed');
          err.code = 'ENOTFOUND';
          throw err;
        }
        return 'dns-resolved';
      };

      const result = await retry(fn, { retries: 2, baseDelayMs: 10 });
      expect(result).toBe('dns-resolved');
    });

    it('should retry on ECONNABORTED', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Connection aborted');
          err.code = 'ECONNABORTED';
          throw err;
        }
        return 'aborted-then-ok';
      };

      const result = await retry(fn, { retries: 2, baseDelayMs: 10 });
      expect(result).toBe('aborted-then-ok');
    });
  });

  // ============================================================================
  // HTTP TRANSIENT STATUS CODES
  // ============================================================================

  describe('HTTP Transient Status Codes', () => {
    it('should retry on 429 (Too Many Requests)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Rate limited');
          err.response = { status: 429 };
          throw err;
        }
        return 'rate-limit-recovered';
      };

      const result = await retry(fn, { retries: 2, baseDelayMs: 10 });
      expect(result).toBe('rate-limit-recovered');
      expect(attempts).toBe(2);
    });

    it('should retry on 408 (Request Timeout)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Request timeout');
          err.response = { status: 408 };
          throw err;
        }
        return 'request-timeout-recovered';
      };

      const result = await retry(fn, { retries: 2, baseDelayMs: 10 });
      expect(result).toBe('request-timeout-recovered');
    });

    it('should retry on 5xx (Server Errors)', async () => {
      const testCases = [500, 502, 503, 504];

      for (const statusCode of testCases) {
        jest.clearAllMocks();
        let attempts = 0;

        const fn = async () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error(`Server error ${statusCode}`);
            err.response = { status: statusCode };
            throw err;
          }
          return 'server-error-recovered';
        };

        const result = await retry(fn, { retries: 2, baseDelayMs: 10 });
        expect(result).toBe('server-error-recovered');
        expect(attempts).toBe(2);
      }
    });
  });

  // ============================================================================
  // EXPONENTIAL BACKOFF
  // ============================================================================

  describe('Exponential Backoff', () => {
    it('should use exponential backoff: 1x, 2x, 4x', async () => {
      let attempts = 0;
      const timings = [];
      const startTime = Date.now();

      const fn = async () => {
        attempts++;
        timings.push(Date.now() - startTime);
        if (attempts < 4) {
          const err = new Error('Transient');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      };

      const result = await retry(fn, { retries: 3, baseDelayMs: 20 });

      expect(result).toBe('success');
      expect(attempts).toBe(4);
      // Verify exponential backoff occurred (approximate due to system timing)
      // timings[0] should be ~0ms (immediate)
      // timings[1] should be ~20ms (after first delay)
      // timings[2] should be ~60ms (after 20+40ms)
      // timings[3] should be ~140ms (after 20+40+80ms)
      expect(timings[1] - timings[0]).toBeGreaterThanOrEqual(10);
      expect(timings[2] - timings[1]).toBeGreaterThanOrEqual(30);
      expect(timings[3] - timings[2]).toBeGreaterThanOrEqual(70);
    });

    it('should respect custom baseDelayMs', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Transient');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      };

      const result = await retry(fn, { retries: 1, baseDelayMs: 50 });
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should use environment variable DOCFLOW_RETRY_BASE_MS', async () => {
      process.env.DOCFLOW_RETRY_BASE_MS = '30';
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Transient');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      };

      const result = await retry(fn, { retries: 1 });
      expect(result).toBe('success');
      expect(attempts).toBe(2);
      delete process.env.DOCFLOW_RETRY_BASE_MS;
    });
  });

  // ============================================================================
  // RETRY EXHAUSTION
  // ============================================================================

  describe('Retry Exhaustion', () => {
    it('should fail after retries exhausted', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const err = new Error('Always fails');
        err.code = 'ETIMEDOUT';
        throw err;
      };

      await expect(retry(fn, { retries: 2, baseDelayMs: 10 })).rejects.toThrow('Always fails');
      expect(attempts).toBe(3); // initial + 2 retries
      expect(logger.error).toHaveBeenCalledWith(
        'retry-exhausted:operation',
        expect.any(Error),
        expect.objectContaining({ attempt: 2, retryable: true })
      );
    });

    it('should throw original error with proper context', async () => {
      const originalErr = new Error('Original error message');
      originalErr.code = 'ETIMEDOUT';
      originalErr.details = 'some-detail';

      const fn = async () => {
        throw originalErr;
      };

      try {
        await retry(fn, { retries: 1, baseDelayMs: 10, label: 'critical-op' });
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBe(originalErr);
        expect(err.message).toBe('Original error message');
        expect(err.details).toBe('some-detail');
      }
    });
  });

  // ============================================================================
  // PERMANENT ERRORS (SHOULD NOT RETRY)
  // ============================================================================

  describe('Permanent Errors (No Retry)', () => {
    it('should not retry on 400 (Bad Request)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const err = new Error('Bad request');
        err.response = { status: 400 };
        throw err;
      };

      await expect(retry(fn, { retries: 3, baseDelayMs: 10 })).rejects.toThrow('Bad request');
      expect(attempts).toBe(1); // No retry
      expect(logger.error).toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should not retry on 401 (Unauthorized)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const err = new Error('Unauthorized');
        err.response = { status: 401 };
        throw err;
      };

      await expect(retry(fn, { retries: 3, baseDelayMs: 10 })).rejects.toThrow('Unauthorized');
      expect(attempts).toBe(1);
    });

    it('should not retry on 403 (Forbidden)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const err = new Error('Forbidden');
        err.response = { status: 403 };
        throw err;
      };

      await expect(retry(fn, { retries: 3, baseDelayMs: 10 })).rejects.toThrow('Forbidden');
      expect(attempts).toBe(1);
    });

    it('should not retry on 404 (Not Found)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const err = new Error('Not found');
        err.response = { status: 404 };
        throw err;
      };

      await expect(retry(fn, { retries: 3, baseDelayMs: 10 })).rejects.toThrow('Not found');
      expect(attempts).toBe(1);
    });

    it('should not retry on error marked non-transient', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const err = new Error('Deliberate error');
        err.transient = false;
        throw err;
      };

      await expect(retry(fn, { retries: 3, baseDelayMs: 10 })).rejects.toThrow('Deliberate error');
      expect(attempts).toBe(1);
    });

    it('should handle errors without response or code gracefully', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error('Unknown error');
      };

      await expect(retry(fn, { retries: 1, baseDelayMs: 10 })).rejects.toThrow('Unknown error');
      expect(attempts).toBe(1); // Should fail immediately
    });
  });

  // ============================================================================
  // CUSTOM shouldRetry PREDICATE
  // ============================================================================

  describe('Custom shouldRetry Predicate', () => {
    it('should use custom shouldRetry function', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('Custom error');
          err.code = 'CUSTOM_TRANSIENT';
          throw err;
        }
        return 'success';
      };

      const customShouldRetry = (err) => err.code === 'CUSTOM_TRANSIENT';

      const result = await retry(fn, {
        retries: 2,
        baseDelayMs: 10,
        shouldRetry: customShouldRetry,
      });
      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('custom shouldRetry can identify retry-worthy responses', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Quota exceeded in custom API');
          err.response = { status: 403, data: { errorCode: 'QUOTA_EXCEEDED' } };
          throw err;
        }
        return 'custom-recovered';
      };

      const customShouldRetry = (err) => {
        return err.response?.data?.errorCode === 'QUOTA_EXCEEDED';
      };

      const result = await retry(fn, {
        retries: 2,
        baseDelayMs: 10,
        shouldRetry: customShouldRetry,
      });
      expect(result).toBe('custom-recovered');
      expect(attempts).toBe(2);
    });
  });

  // ============================================================================
  // MIXED SCENARIOS
  // ============================================================================

  describe('Mixed Scenarios', () => {
    it('should recover from multiple transients then succeed', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error('First failure');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        if (attempts === 2) {
          const err = new Error('Second failure');
          err.code = 'ECONNRESET';
          throw err;
        }
        return 'recovered';
      };

      const result = await retry(fn, { retries: 3, baseDelayMs: 10 });
      expect(result).toBe('recovered');
      expect(attempts).toBe(3);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('should fail when transient error followed by permanent error', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error('Transient');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        // Second attempt: permanent error
        const err = new Error('Unauthorized');
        err.response = { status: 401 };
        throw err;
      };

      await expect(retry(fn, { retries: 2, baseDelayMs: 10 })).rejects.toThrow('Unauthorized');
      expect(attempts).toBe(2);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should attempt correct number of times with retries=0', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const err = new Error('Transient');
        err.code = 'ETIMEDOUT';
        throw err;
      };

      await expect(retry(fn, { retries: 0, baseDelayMs: 10 })).rejects.toThrow('Transient');
      expect(attempts).toBe(1); // Only initial attempt
    });
  });

  // ============================================================================
  // ASYNC/AWAIT EDGE CASES
  // ============================================================================

  describe('Async/Await Edge Cases', () => {
    it('should pass attempt number to function', async () => {
      const attempts = [];
      const fn = async (attemptNum) => {
        attempts.push(attemptNum);
        if (attemptNum < 2) {
          const err = new Error('Try again');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return attemptNum;
      };

      const result = await retry(fn, { retries: 2, baseDelayMs: 10 });
      expect(attempts).toEqual([0, 1, 2]);
      expect(result).toBe(2);
    });

    it('should work with async functions that resolve normally', async () => {
      const fn = async () => 'immediate-success';
      const result = await retry(fn, { retries: 0 });
      expect(result).toBe('immediate-success');
    });
  });

  // ============================================================================
  // LOGGING
  // ============================================================================

  describe('Logging', () => {
    it('should log retry attempts with label', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Transient');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      };

      await retry(fn, { retries: 1, baseDelayMs: 10, label: 'important-call' });
      expect(logger.warn).toHaveBeenCalledWith(
        'retrying:important-call',
        expect.objectContaining({
          attempt: 1,
          delayMs: 10,
        })
      );
    });

    it('should log final error with retryable flag', async () => {
      const fn = async () => {
        const err = new Error('Network down');
        err.code = 'ENOTFOUND';
        throw err;
      };

      try {
        await retry(fn, { retries: 1, baseDelayMs: 10, label: 'dns-lookup' });
      } catch (e) {
        // Expected
      }

      expect(logger.error).toHaveBeenCalledWith(
        'retry-exhausted:dns-lookup',
        expect.any(Error),
        expect.objectContaining({
          retryable: true,
        })
      );
    });

    it('should include error message in warning log', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Specific error message');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      };

      await retry(fn, { retries: 1, baseDelayMs: 10 });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error: 'Specific error message',
        })
      );
    });
  });
});

// ============================================================================
// RateLimiter TESTS
// ============================================================================

describe('RateLimiter - Transient Failure Scenario', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should queue requests when at limit', async () => {
    const limiter = new RateLimiter(2, 100, 'test-limiter');

    const acquisitions = [];
    const startTime = Date.now();

    // Acquire first two immediately
    await limiter.acquire();
    acquisitions.push(Date.now() - startTime);

    await limiter.acquire();
    acquisitions.push(Date.now() - startTime);

    expect(limiter.inFlight).toBe(2);

    // Third will wait for window to pass
    const p3 = limiter.acquire().then(() => acquisitions.push(Date.now() - startTime));

    // Wait for the third to complete
    await p3;

    expect(acquisitions.length).toBe(3);
    // Third acquisition should be delayed by approximately the window time
    expect(acquisitions[2] - acquisitions[1]).toBeGreaterThanOrEqual(90);
  });

  it('should handle rapid acquire/release cycles', async () => {
    const limiter = new RateLimiter(3, 100);
    const logs = [];

    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      logs.push(`call-${i}`);

      if (i === 2) {
        // Wait for window to expire
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    }

    expect(logs.length).toBe(5);
  });

  it('inFlight should report accurate count', async () => {
    const limiter = new RateLimiter(2, 100);

    await limiter.acquire();
    expect(limiter.inFlight).toBe(1);

    await limiter.acquire();
    expect(limiter.inFlight).toBe(2);

    // Window expires
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(limiter.inFlight).toBe(0);
  });
});

// ============================================================================
// INTEGRATION: Retry + Rate Limiter
// ============================================================================

describe('Retry + RateLimiter Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should respect rate limit during retries', async () => {
    const limiter = new RateLimiter(1, 100); // Only 1 call per 100ms
    const callTimes = [];

    const fn = async (attempt) => {
      await limiter.acquire();
      callTimes.push(Date.now());

      if (attempt < 2) {
        const err = new Error('Transient');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return 'success';
    };

    const result = await retry(fn, { retries: 2, baseDelayMs: 20, label: 'rate-limited-call' });

    expect(result).toBe('success');
    // Should have attempted 3 times (init + 2 retries), respecting rate limit
  });
});
