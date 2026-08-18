'use strict';
/**
 * Unit tests for priorityQueueService
 * Run with: npm test -- priorityQueueService.test.js
 */

const priorityQueue = require('./priorityQueueService');

describe('priorityQueueService', () => {

  describe('determinePriority', () => {
    test('detects VP as high priority', () => {
      const row = {
        name: 'John Smith',
        byTitle: { Position: 'VP Engineering' }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('detects CEO as high priority', () => {
      const row = {
        name: 'Jane Doe',
        byTitle: { Position: 'Chief Executive Officer' }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('detects CFO as high priority', () => {
      const row = {
        name: 'Bob Jones',
        byTitle: { Position: 'CFO' }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('detects CTO as high priority', () => {
      const row = {
        name: 'Alice Smith',
        byTitle: { Position: 'Chief Technology Officer' }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('detects President as high priority', () => {
      const row = {
        name: 'Charlie Brown',
        byTitle: { Position: 'President of Operations' }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('detects batch imports as low priority', () => {
      const row = {
        name: 'Batch Item',
        byTitle: { 'Batch Import': 'true' }
      };
      expect(priorityQueue.determinePriority(row)).toBe('low');
    });

    test('defaults to normal priority', () => {
      const row = {
        name: 'Regular Employee',
        byTitle: { Position: 'Software Engineer' }
      };
      expect(priorityQueue.determinePriority(row)).toBe('normal');
    });

    test('respects explicit HIGH priority override', () => {
      const row = {
        name: 'Special Case',
        byTitle: {
          Position: 'Software Engineer',
          Priority: 'HIGH'
        }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('respects explicit URGENT priority override', () => {
      const row = {
        name: 'Special Case',
        byTitle: {
          Position: 'Manager',
          Priority: 'URGENT'
        }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('respects explicit VIP priority override', () => {
      const row = {
        name: 'Important Person',
        byTitle: {
          Position: 'Consultant',
          Priority: 'VIP'
        }
      };
      expect(priorityQueue.determinePriority(row)).toBe('high');
    });

    test('handles missing byTitle gracefully', () => {
      const row = {
        name: 'John Smith'
      };
      expect(priorityQueue.determinePriority(row)).toBe('normal');
    });

    test('handles empty row gracefully', () => {
      expect(priorityQueue.determinePriority()).toBe('normal');
      expect(priorityQueue.determinePriority({})).toBe('normal');
    });

    test('case-insensitive position matching', () => {
      const testCases = [
        { position: 'vp engineering', expected: 'high' },
        { position: 'VP ENGINEERING', expected: 'high' },
        { position: 'Vp Engineering', expected: 'high' },
        { position: 'ceo', expected: 'high' },
        { position: 'CEO', expected: 'high' },
        { position: 'Chief Executive Officer', expected: 'high' },
      ];

      testCases.forEach(tc => {
        const row = {
          name: 'Test Person',
          byTitle: { Position: tc.position }
        };
        expect(priorityQueue.determinePriority(row)).toBe(tc.expected);
      });
    });
  });

  describe('processMessage', () => {
    test('parses valid JSON message', async () => {
      const messageText = JSON.stringify({
        itemId: '123',
        boardId: '456',
        _enqueuedAt: new Date().toISOString()
      });

      const result = await priorityQueue.processMessage(messageText, 'normal');
      expect(result.processed).toBe(true);
      expect(result.message.itemId).toBe('123');
    });

    test('handles invalid JSON gracefully', async () => {
      const messageText = 'not valid json';
      const result = await priorityQueue.processMessage(messageText, 'normal');
      expect(result.processed).toBe(false);
      expect(result.message).toBe(null);
    });

    test('calculates message age correctly', async () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const messageText = JSON.stringify({
        itemId: '123',
        _enqueuedAt: fiveMinutesAgo
      });

      const result = await priorityQueue.processMessage(messageText, 'normal');
      expect(result.ageMs).toBeGreaterThan(4.9 * 60 * 1000);
      expect(result.ageMs).toBeLessThan(5.1 * 60 * 1000);
    });

    test('promotes low-priority message after 30 minutes', async () => {
      const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      const messageText = JSON.stringify({
        itemId: '123',
        _enqueuedAt: thirtyOneMinutesAgo
      });

      const result = await priorityQueue.processMessage(messageText, 'low');
      expect(result.shouldPromote).toBe(true);
      expect(result.priority).toBe('low');
    });

    test('does not promote low-priority message before 30 minutes', async () => {
      const twentyNineMinutesAgo = new Date(Date.now() - 29 * 60 * 1000).toISOString();
      const messageText = JSON.stringify({
        itemId: '123',
        _enqueuedAt: twentyNineMinutesAgo
      });

      const result = await priorityQueue.processMessage(messageText, 'low');
      expect(result.shouldPromote).toBe(false);
    });

    test('promotes normal-priority message after 60 minutes', async () => {
      const sixtyOneMinutesAgo = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      const messageText = JSON.stringify({
        itemId: '123',
        _enqueuedAt: sixtyOneMinutesAgo
      });

      const result = await priorityQueue.processMessage(messageText, 'normal');
      expect(result.shouldPromote).toBe(true);
    });

    test('never promotes high-priority messages', async () => {
      const ninetyNineMinutesAgo = new Date(Date.now() - 99 * 60 * 1000).toISOString();
      const messageText = JSON.stringify({
        itemId: '123',
        _enqueuedAt: ninetyNineMinutesAgo
      });

      const result = await priorityQueue.processMessage(messageText, 'high');
      expect(result.shouldPromote).toBe(false);
    });
  });

  describe('promoteMessage', () => {
    test('creates promotion metadata', async () => {
      const message = {
        itemId: '123',
        boardId: '456',
        _priority: 'low',
        _enqueuedAt: new Date().toISOString()
      };

      const result = await priorityQueue.promoteMessage(message, 'low', 'normal');
      expect(result.success).toBe(true);

      const promoted = JSON.parse(result.message);
      expect(promoted._priority).toBe('normal');
      expect(promoted._promotedFrom).toBe('low');
      expect(promoted._promotedAt).toBeDefined();
      expect(promoted._previousEnqueuedAt).toBeDefined();
    });

    test('includes original message data in promotion', async () => {
      const message = {
        itemId: '789',
        boardId: '321',
        employee: 'John Smith',
        _enqueuedAt: new Date().toISOString()
      };

      const result = await priorityQueue.promoteMessage(message, 'low', 'normal');
      const promoted = JSON.parse(result.message);

      expect(promoted.itemId).toBe('789');
      expect(promoted.boardId).toBe('321');
      expect(promoted.employee).toBe('John Smith');
    });

    test('rejects invalid priority transitions', async () => {
      const message = { itemId: '123' };

      try {
        await priorityQueue.promoteMessage(message, 'invalid', 'normal');
        fail('Should have thrown error');
      } catch (err) {
        expect(err.message).toContain('Invalid priority levels');
      }
    });
  });

  describe('routeMessage', () => {
    test('requires message parameter', async () => {
      try {
        await priorityQueue.routeMessage(null);
        fail('Should have thrown error');
      } catch (err) {
        expect(err.message).toContain('queueMessage required');
      }
    });

    test('returns routing info for high priority', async () => {
      const message = {
        itemId: '123',
        boardId: '456',
        employee: 'VP Candidate'
      };

      const result = await priorityQueue.routeMessage(message, 'high');
      expect(result.priority).toBe('high');
      expect(result.queueName).toBe('docflow-generate-high');
      expect(result.binding).toBe('generateQueueHigh');
    });

    test('returns routing info for normal priority', async () => {
      const message = {
        itemId: '123',
        boardId: '456'
      };

      const result = await priorityQueue.routeMessage(message, 'normal');
      expect(result.priority).toBe('normal');
      expect(result.queueName).toBe('docflow-generate');
      expect(result.binding).toBe('generateQueueNormal');
    });

    test('returns routing info for low priority', async () => {
      const message = {
        itemId: '123',
        boardId: '456'
      };

      const result = await priorityQueue.routeMessage(message, 'low');
      expect(result.priority).toBe('low');
      expect(result.queueName).toBe('docflow-generate-batch');
      expect(result.binding).toBe('generateQueueLow');
    });

    test('includes message metadata in output', async () => {
      const message = {
        itemId: '123',
        boardId: '456'
      };

      const result = await priorityQueue.routeMessage(message, 'normal');
      const routed = JSON.parse(result.message);

      expect(routed._priority).toBe('normal');
      expect(routed._enqueuedAt).toBeDefined();
      expect(routed.itemId).toBe('123');
    });
  });

  describe('QUEUE_CONFIG', () => {
    test('has all three priority levels configured', () => {
      expect(priorityQueue.QUEUE_CONFIG.high).toBeDefined();
      expect(priorityQueue.QUEUE_CONFIG.normal).toBeDefined();
      expect(priorityQueue.QUEUE_CONFIG.low).toBeDefined();
    });

    test('has correct queue names', () => {
      expect(priorityQueue.QUEUE_CONFIG.high.name).toBe('docflow-generate-high');
      expect(priorityQueue.QUEUE_CONFIG.normal.name).toBe('docflow-generate');
      expect(priorityQueue.QUEUE_CONFIG.low.name).toBe('docflow-generate-batch');
    });

    test('has worker counts specified', () => {
      expect(priorityQueue.QUEUE_CONFIG.high.workerCount).toBe(2);
      expect(priorityQueue.QUEUE_CONFIG.normal.workerCount).toBe(4);
      expect(priorityQueue.QUEUE_CONFIG.low.workerCount).toBe(1);
    });

    test('has TTL minutes configured', () => {
      expect(priorityQueue.QUEUE_CONFIG.high.ttlMinutes).toBe(60);
      expect(priorityQueue.QUEUE_CONFIG.normal.ttlMinutes).toBe(480);
      expect(priorityQueue.QUEUE_CONFIG.low.ttlMinutes).toBe(1440);
    });
  });

  describe('PROMOTION_THRESHOLDS', () => {
    test('has promotion thresholds defined', () => {
      expect(priorityQueue.PROMOTION_THRESHOLDS.lowToNormal).toBeDefined();
      expect(priorityQueue.PROMOTION_THRESHOLDS.normalToHigh).toBeDefined();
    });

    test('low to normal threshold is 30 minutes', () => {
      expect(priorityQueue.PROMOTION_THRESHOLDS.lowToNormal).toBe(30 * 60 * 1000);
    });

    test('normal to high threshold is 60 minutes', () => {
      expect(priorityQueue.PROMOTION_THRESHOLDS.normalToHigh).toBe(60 * 60 * 1000);
    });
  });

  describe('healthCheck', () => {
    test('returns health object with required fields', async () => {
      const health = await priorityQueue.healthCheck();
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('issues');
      expect(health).toHaveProperty('timestamp');
      expect(Array.isArray(health.issues)).toBe(true);
    });
  });

  describe('getMetrics', () => {
    test('returns metrics object with required structure', async () => {
      const metrics = await priorityQueue.getMetrics();
      expect(metrics).toHaveProperty('timestamp');
      expect(metrics).toHaveProperty('queues');
      expect(metrics).toHaveProperty('summary');
    });

    test('includes all three priority levels in metrics', async () => {
      const metrics = await priorityQueue.getMetrics();
      expect(metrics.queues.high).toBeDefined();
      expect(metrics.queues.normal).toBeDefined();
      expect(metrics.queues.low).toBeDefined();
    });

    test('summary includes total and by-priority counts', async () => {
      const metrics = await priorityQueue.getMetrics();
      expect(metrics.summary).toHaveProperty('total');
      expect(metrics.summary).toHaveProperty('highPriority');
      expect(metrics.summary).toHaveProperty('normalPriority');
      expect(metrics.summary).toHaveProperty('lowPriority');
    });
  });
});
