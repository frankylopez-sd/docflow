'use strict';
/**
 * poisonDrain (finding A57): the 30-minute poison-queue observability sweep.
 * It inspects "<queue>-poison" depths and raises a loud alert when any hold a
 * message — never mutating a queue, never crashing the host on an inspect error.
 */

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), event: jest.fn(), metric: jest.fn(), flush: jest.fn(),
}));
jest.mock('../lib/queue', () => ({ getQueueDepth: jest.fn() }));

const logger = require('../lib/logger');
const queue = require('../lib/queue');
const poisonDrain = require('../functions/poisonDrain');

beforeEach(() => { jest.clearAllMocks(); });

describe('poisonDrain', () => {
  test('all poison queues empty — no alert raised', async () => {
    queue.getQueueDepth.mockResolvedValue(0);
    const summary = await poisonDrain.drainPoisonQueues();
    expect(summary.checked).toBe(poisonDrain.SOURCE_QUEUES.length);
    expect(summary.totalPoison).toBe(0);
    expect(summary.alerts).toHaveLength(0);
    expect(logger.event).not.toHaveBeenCalledWith('poison-queue-alert', expect.any(Object));
  });

  test('a non-empty poison queue raises a loud alert', async () => {
    queue.getQueueDepth.mockImplementation(async (q) => (q === 'docflow-archive-poison' ? 3 : 0));
    const summary = await poisonDrain.drainPoisonQueues();
    expect(summary.totalPoison).toBe(3);
    expect(summary.alerts).toEqual([{ queue: 'docflow-archive-poison', depth: 3 }]);
    expect(logger.event).toHaveBeenCalledWith('poison-queue-alert',
      expect.objectContaining({ queue: 'docflow-archive-poison', depth: 3 }));
  });

  test('an inspection error is logged, not thrown', async () => {
    queue.getQueueDepth.mockRejectedValue(new Error('no queue SDK'));
    const summary = await poisonDrain.drainPoisonQueues();
    expect(summary.errors).toBe(poisonDrain.SOURCE_QUEUES.length);
    expect(logger.warn).toHaveBeenCalledWith('poison-drain-check', expect.any(Object));
  });

  test('timer entry point runs without throwing', async () => {
    queue.getQueueDepth.mockResolvedValue(0);
    await expect(poisonDrain({ bindings: {} }, { isPastDue: false })).resolves.toBeUndefined();
  });
});
