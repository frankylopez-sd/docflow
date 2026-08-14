/**
 * Unit tests for webhookErrors module.
 * Demonstrates all error scenarios and their HTTP responses.
 *
 * Run with: npm test -- webhookErrors.test.js
 */

const assert = require('assert');
const {
  ErrorTypes,
  WebhookError,
  validateSignature,
  validateHireData,
  queueErrorToWebhookError,
} = require('../../src/lib/webhookErrors');

describe('WebhookErrors', () => {
  describe('validateSignature', () => {
    it('should allow requests when no secret is configured', () => {
      const result = validateSignature('Bearer some.token', null);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.reason, 'no-secret-configured');
    });

    it('should reject with 401 when authorization header missing', () => {
      const err = assert.throws(
        () => validateSignature(null, 'secret'),
        WebhookError
      );
      assert.strictEqual(err.type, ErrorTypes.SIGNATURE_MISSING);
      assert.strictEqual(err.response.status, 401);
      assert.strictEqual(err.response.retryable, false);
    });

    it('should reject with 401 when JWT has wrong number of parts', () => {
      const err = assert.throws(
        () => validateSignature('Bearer invalid.token', 'secret'),
        WebhookError
      );
      assert.strictEqual(err.type, ErrorTypes.TOKEN_MALFORMED);
      assert.strictEqual(err.response.status, 401);
    });

    it('should reject with 401 when signature is invalid', () => {
      const crypto = require('crypto');
      const secret = 'my-webhook-secret';
      const payload = { userId: 'user123' };
      const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'; // {"alg":"HS256","typ":"JWT"}
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

      // Create a JWT with wrong signature
      const badSig = Buffer.from('badsignature').toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const badToken = `${header}.${payloadB64}.${badSig}`;

      const err = assert.throws(
        () => validateSignature(`Bearer ${badToken}`, secret),
        WebhookError
      );
      assert.strictEqual(err.type, ErrorTypes.SIGNATURE_INVALID);
      assert.strictEqual(err.response.status, 401);
    });

    it('should reject with 401 when token is expired', () => {
      const crypto = require('crypto');
      const secret = 'my-webhook-secret';

      // Create a JWT that expired 1 hour ago
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      const expiredPayload = {
        userId: 'user123',
        exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
      };
      const payload = Buffer.from(JSON.stringify(expiredPayload))
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      const token = `${header}.${payload}.${sig}`;

      const err = assert.throws(
        () => validateSignature(`Bearer ${token}`, secret),
        WebhookError
      );
      assert.strictEqual(err.type, ErrorTypes.TOKEN_EXPIRED);
      assert.strictEqual(err.response.status, 401);
    });
  });

  describe('validateHireData', () => {
    const cols = {
      email: 'eml',
      startDate: 'sdt',
      position: 'pos',
      manager: 'mgr',
    };

    it('should pass when all required fields are present', () => {
      const row = {
        name: 'John Doe',
        columns: {
          eml: 'john@example.com',
          sdt: '2024-01-01',
          pos: 'Engineer',
          mgr: 'Jane Manager',
        },
      };

      const result = validateHireData(row, cols);
      assert.strictEqual(result.allValid, true);
      assert.strictEqual(result.warnings.length, 0);
    });

    it('should warn when optional fields missing (422 but queued)', () => {
      const row = {
        name: 'John Doe',
        columns: {
          eml: 'john@example.com',
          sdt: '2024-01-01',
          pos: 'Engineer',
          // mgr missing (optional but recommended)
        },
      };

      const result = validateHireData(row, cols);
      assert.strictEqual(result.allValid, false);
      assert(result.warnings.some(w => w.includes('manager')));
    });

    it('should warn when required fields missing', () => {
      const row = {
        name: 'John Doe',
        columns: {
          eml: 'john@example.com',
          // startDate missing (required)
          pos: 'Engineer',
        },
      };

      const result = validateHireData(row, cols);
      assert.strictEqual(result.allValid, false);
      assert(result.warnings.some(w => w.includes('startDate')));
    });
  });

  describe('queueErrorToWebhookError', () => {
    it('should map 503 errors to QUEUE_SERVICE_UNAVAILABLE (503)', () => {
      const err = new Error('HTTP 503: Service Unavailable');
      const webhookErr = queueErrorToWebhookError(err);

      assert.strictEqual(webhookErr.type, ErrorTypes.QUEUE_SERVICE_UNAVAILABLE);
      assert.strictEqual(webhookErr.response.status, 503);
      assert.strictEqual(webhookErr.response.retryable, true);
    });

    it('should map timeout errors to QUEUE_SERVICE_UNAVAILABLE (503, retryable)', () => {
      const err = new Error('Request timeout on queue operation');
      const webhookErr = queueErrorToWebhookError(err);

      assert.strictEqual(webhookErr.response.status, 503);
      assert.strictEqual(webhookErr.response.retryable, true);
    });

    it('should map generic queue errors to QUEUE_SUBMISSION_FAILED (503, retryable)', () => {
      const err = new Error('Failed to add message to queue');
      err.code = 'QueueNotFound';
      const webhookErr = queueErrorToWebhookError(err);

      assert.strictEqual(webhookErr.response.status, 503);
      assert.strictEqual(webhookErr.response.retryable, true);
    });

    it('should map unknown errors to INTERNAL_ERROR (500, retryable)', () => {
      const err = new Error('Something went wrong');
      const webhookErr = queueErrorToWebhookError(err);

      assert.strictEqual(webhookErr.type, ErrorTypes.INTERNAL_ERROR);
      assert.strictEqual(webhookErr.response.status, 500);
      assert.strictEqual(webhookErr.response.retryable, true);
    });
  });

  describe('WebhookError', () => {
    it('should have proper structure for 401 errors', () => {
      const err = new WebhookError(
        ErrorTypes.SIGNATURE_INVALID,
        'JWT signature mismatch',
        { expectedLen: 32, providedLen: 30 }
      );

      assert.strictEqual(err.response.status, 401);
      assert.strictEqual(err.response.retryable, false);
      assert.deepStrictEqual(err.getResponse(), {
        status: 401,
        body: { error: 'invalid signature' },
      });
    });

    it('should have proper structure for 422 warnings', () => {
      const err = new WebhookError(
        ErrorTypes.HIRE_DATA_INCOMPLETE,
        'Missing optional fields',
        { warnings: ['Missing manager'] }
      );

      assert.strictEqual(err.response.status, 422);
      assert.strictEqual(err.response.retryable, false);
      assert.strictEqual(err.response.body.queued, true);
    });

    it('should have proper structure for 503 queue errors', () => {
      const err = new WebhookError(
        ErrorTypes.QUEUE_SUBMISSION_FAILED,
        'Queue unavailable',
        { code: 'ServiceUnavailable' }
      );

      assert.strictEqual(err.response.status, 503);
      assert.strictEqual(err.response.retryable, true);
      assert.strictEqual(err.response.body.retry, true);
    });

    it('should be retryable() only for 5xx errors', () => {
      const err401 = new WebhookError(ErrorTypes.SIGNATURE_INVALID, 'Bad sig');
      const err503 = new WebhookError(ErrorTypes.QUEUE_SERVICE_UNAVAILABLE, 'Queue down');

      assert.strictEqual(err401.isRetryable(), false);
      assert.strictEqual(err503.isRetryable(), true);
    });
  });

  describe('HTTP status code guarantees', () => {
    it('should return 401 for all authentication failures', () => {
      const cases = [
        ErrorTypes.SIGNATURE_INVALID,
        ErrorTypes.SIGNATURE_MISSING,
        ErrorTypes.TOKEN_EXPIRED,
        ErrorTypes.TOKEN_MALFORMED,
      ];

      for (const type of cases) {
        const err = new WebhookError(type, 'test');
        assert.strictEqual(err.response.status, 401, `${type} should be 401`);
        assert.strictEqual(err.response.retryable, false, `${type} should not be retryable`);
      }
    });

    it('should return 503 for all queue/infrastructure failures', () => {
      const cases = [
        ErrorTypes.QUEUE_SUBMISSION_FAILED,
        ErrorTypes.QUEUE_SERVICE_UNAVAILABLE,
      ];

      for (const type of cases) {
        const err = new WebhookError(type, 'test');
        assert.strictEqual(err.response.status, 503, `${type} should be 503`);
        assert.strictEqual(err.response.retryable, true, `${type} should be retryable`);
      }
    });

    it('should return 422 for data validation warnings (but queued)', () => {
      const err = new WebhookError(ErrorTypes.HIRE_DATA_INCOMPLETE, 'test');
      assert.strictEqual(err.response.status, 422);
      assert.strictEqual(err.response.body.queued, true);
      assert.strictEqual(err.response.retryable, false);
    });
  });
});
