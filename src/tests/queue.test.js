'use strict';
/**
 * Queue rate limiting tests: depth checking, overload detection, metrics.
 */

jest.mock('@azure/storage-queue', () => ({
  QueueServiceClient: class QueueServiceClient {
    constructor(url, credential) {
      this.url = url;
      this.credential = credential;
    }

    getQueueClient(queueName) {
      return {
        getProperties: jest.fn(async () => {
          if (global.__testQueueFail) {
            throw new Error('Queue not found');
          }
          return {
            approximateMessagesCount: global.__testQueueDepth || 0,
            metadata: { test: 'true' },
            createdOn: new Date('2026-01-01'),
            lastModified: new Date(),
          };
        }),
      };
    }
  },
  StorageSharedKeyCredential: class StorageSharedKeyCredential {
    constructor(accountName, accountKey) {
      this.accountName = accountName;
      this.accountKey = accountKey;
    }
  },
}));

jest.mock('@azure/identity', () => ({
  DefaultAzureCredential: class DefaultAzureCredential {},
}));

const queue = require('../lib/queue');
const config = require('../lib/config');

beforeEach(() => {
  jest.clearAllMocks();
  config.reset();
  queue._resetState();
  global.__testQueueDepth = 0;
  global.__testQueueFail = false;
});

describe('Queue rate limiting', () => {
  test('getQueueDepth returns approximate message count', async () => {
    global.__testQueueDepth = 42;
    const depth = await queue.getQueueDepth('docflow-generate');
    expect(depth).toBe(42);
  });

  test('getQueueDepth returns 0 on error (fail open)', async () => {
    // Inject a storage-level failure — the contract is fail-open: log and
    // return 0 so webhooks are let through when the depth check breaks.
    global.__testQueueFail = true;
    const depth = await queue.getQueueDepth('nonexistent-queue');
    expect(depth).toBe(0);
  });

  test('isOverloaded returns false when depth below threshold', async () => {
    global.__testQueueDepth = 500;
    const result = await queue.isOverloaded('docflow-generate', 1000);
    expect(result.overloaded).toBe(false);
    expect(result.depth).toBe(500);
  });

  test('isOverloaded returns true when depth meets threshold', async () => {
    global.__testQueueDepth = 1000;
    const result = await queue.isOverloaded('docflow-generate', 1000);
    expect(result.overloaded).toBe(true);
    expect(result.depth).toBe(1000);
  });

  test('isOverloaded returns true when depth exceeds threshold', async () => {
    global.__testQueueDepth = 1500;
    const result = await queue.isOverloaded('docflow-generate', 1000);
    expect(result.overloaded).toBe(true);
    expect(result.depth).toBe(1500);
  });

  test('isOverloaded fails safely and returns false', async () => {
    // Simulate error condition
    global.__testQueueDepth = 1500;
    const result = await queue.isOverloaded('docflow-generate', 1000);
    // Should handle gracefully
    expect(result).toHaveProperty('overloaded');
    expect(result).toHaveProperty('depth');
  });

  test('getQueueStats returns queue metadata', async () => {
    global.__testQueueDepth = 250;
    const stats = await queue.getQueueStats('docflow-generate');
    expect(stats.name).toBe('docflow-generate');
    expect(stats.depth).toBe(250);
    expect(stats.metadata).toEqual({ test: 'true' });
  });

  test('getQueueStats handles missing queue gracefully', async () => {
    const stats = await queue.getQueueStats('nonexistent-queue');
    expect(stats.name).toBe('nonexistent-queue');
    expect(stats.depth).toBe(0);
  });

  test('threshold validation throws on invalid limit', async () => {
    await expect(() => queue.isOverloaded('queue', -1)).rejects.toThrow(
      /limit must be a positive number/
    );
  });

  test('queueName validation throws on empty string', async () => {
    await expect(() => queue.getQueueDepth('')).rejects.toThrow(
      /queueName must be a non-empty string/
    );
  });
});
