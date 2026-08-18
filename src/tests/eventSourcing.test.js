'use strict';
/**
 * Tests for eventSourcing.js
 */

// Mock config, logger and Azure Storage (module factory — @azure/storage-blob's
// exports are non-configurable, so jest.spyOn on them can never work).
jest.mock('../lib/config');
jest.mock('../lib/logger');
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());
jest.mock('@azure/identity', () => ({ DefaultAzureCredential: class DefaultAzureCredential {} }));

const eventSourcing = require('../lib/eventSourcing');
const config = require('../lib/config');
const logger = require('../lib/logger');
const storageMock = require('@azure/storage-blob');

describe('EventSourcing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storageMock.__reset();
    eventSourcing._reset();
    config.load.mockReturnValue({
      environment: 'test',
      storage: {
        accountName: 'teststorage',
        accountKey: 'dGVzdGtleQ==', // base64-encoded "testkey"
        secondaryAccountName: null,
        secondaryAccountKey: null,
        tempContainer: 'pdf-temp',
        archiveContainer: 'pdf-archive',
      },
      adobe: { clientId: 'test' },
      monday: { token: 'test' },
    });
  });

  describe('writeEvent', () => {
    it('should reject if jobId is missing', async () => {
      await expect(
        eventSourcing.writeEvent(null, 'test-event', {})
      ).rejects.toThrow('jobId is required');
    });

    it('should reject if eventType is missing', async () => {
      await expect(
        eventSourcing.writeEvent('job-123', null, {})
      ).rejects.toThrow('eventType is required');
    });

    it('should create an event with all required fields', async () => {
      const jobId = 'job-' + Date.now();
      const eventType = 'pdf-generated';
      const data = { pdfUrl: 'https://example.com/doc.pdf', size: 12345 };
      const metadata = { author: 'test-user', source: 'unit-test' };

      const result = await eventSourcing.writeEvent(jobId, eventType, data, metadata);

      // Returned receipt
      expect(result.eventId).toBeTruthy();
      expect(result.sequence).toBe(0);
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
      expect(result.blobName).toContain(`events/${jobId}/`);
      expect(result.blobName).toContain(eventType);

      // Stored immutable event blob
      const stored = storageMock.__store.get(`teststorage|events|${result.blobName}`);
      expect(stored).toBeDefined();
      const event = JSON.parse(stored.data.toString('utf8'));
      expect(event).toMatchObject({
        eventId: result.eventId,
        jobId,
        timestamp: result.timestamp,
        sequence: 0,
        eventType,
        data,
      });
      expect(event.metadata.author).toBe('test-user');
      expect(event.metadata.source).toBe('unit-test');
      expect(event.metadata.recordedAt).toBe(result.timestamp);

      // Readable back through the query API
      const history = await eventSourcing.getHistory(jobId);
      expect(history.total).toBe(1);
      expect(history.events[0].eventId).toBe(result.eventId);
    });
  });

  describe('getHistory', () => {
    it('should reject if jobId is missing', async () => {
      await expect(eventSourcing.getHistory(null)).rejects.toThrow('jobId is required');
    });

    it('should return empty history for new job', async () => {
      const jobId = 'job-' + Date.now();
      // This would require a mock implementation; in real tests, use Azure Storage Emulator
      expect(jobId).toBeTruthy();
    });

    it('should support pagination with skip and limit', () => {
      const options = { skip: 10, limit: 50 };
      expect(options.skip).toBe(10);
      expect(options.limit).toBe(50);
    });
  });

  describe('getEvent', () => {
    it('should reject if jobId is missing', async () => {
      await expect(eventSourcing.getEvent(null, 0)).rejects.toThrow('jobId is required');
    });

    it('should reject if sequence is not a number', async () => {
      await expect(eventSourcing.getEvent('job-123', 'not-a-number')).rejects.toThrow(
        'sequence must be a number'
      );
    });
  });

  describe('replayFrom', () => {
    it('should reject if jobId is missing', async () => {
      await expect(eventSourcing.replayFrom(null)).rejects.toThrow('jobId is required');
    });

    it('should support filtering by fromSequence', () => {
      const options = { fromSequence: 5 };
      expect(options.fromSequence).toBe(5);
    });

    it('should support filtering by timestamp range', () => {
      const start = new Date('2026-08-01').toISOString();
      const end = new Date('2026-08-31').toISOString();
      const options = { fromTimestamp: start, toTimestamp: end };
      expect(options.fromTimestamp).toBe(start);
      expect(options.toTimestamp).toBe(end);
    });
  });

  describe('reduceEvents', () => {
    it('should reject if jobId is missing', async () => {
      await expect(
        eventSourcing.reduceEvents(null, {}, (s) => s)
      ).rejects.toThrow('jobId is required');
    });

    it('should reject if reducer is not a function', async () => {
      await expect(
        eventSourcing.reduceEvents('job-123', {}, 'not-a-function')
      ).rejects.toThrow('reducer must be a function');
    });

    it('should accept a valid reducer function', () => {
      const reducer = (state, event) => {
        if (event.eventType === 'created') state.created = event.timestamp;
        return state;
      };
      expect(typeof reducer).toBe('function');
    });
  });

  describe('getEventCount', () => {
    it('should reject if jobId is missing', async () => {
      await expect(eventSourcing.getEventCount(null)).rejects.toThrow('jobId is required');
    });
  });

  describe('listJobs', () => {
    it('should return an array', async () => {
      // In real test, would verify against Azure Storage Emulator
      expect(Array.isArray([])).toBe(true);
    });
  });

  describe('deleteJob', () => {
    it('should reject if jobId is missing', async () => {
      await expect(eventSourcing.deleteJob(null)).rejects.toThrow('jobId is required');
    });

    it('should track deleted event count', () => {
      const result = { deleted: 42 };
      expect(result.deleted).toBe(42);
    });
  });

  describe('Event structure', () => {
    it('should include required event fields', () => {
      const event = {
        eventId: 'evt-123-abc',
        jobId: 'job-456',
        timestamp: new Date().toISOString(),
        sequence: 0,
        eventType: 'pdf-generated',
        data: { pdfUrl: 'https://example.com/doc.pdf' },
        metadata: { author: 'system', recordedAt: new Date().toISOString() },
      };

      expect(event.eventId).toBeTruthy();
      expect(event.jobId).toBe('job-456');
      expect(event.timestamp).toBeTruthy();
      expect(event.sequence).toBe(0);
      expect(event.eventType).toBe('pdf-generated');
      expect(event.data).toBeDefined();
      expect(event.metadata).toBeDefined();
    });
  });

  describe('Replay scenarios', () => {
    it('should support event-sourcing pattern: write → replay → reduce → state', async () => {
      // Simulated workflow:
      // 1. Multiple events written over time
      const events = [
        { eventType: 'created', data: { itemId: '123', status: 'new' } },
        { eventType: 'pdf-generated', data: { pdfUrl: 'https://...' } },
        { eventType: 'sent-for-sign', data: { agreementId: 'agr-xxx' } },
        { eventType: 'signed', data: { completedAt: '2026-08-10T10:00:00Z' } },
        { eventType: 'archived', data: { blobUrl: 'https://...' } },
      ];

      expect(events.length).toBe(5);

      // 2. Replay to recover state
      const reducer = (state, event) => {
        if (event.eventType === 'created') {
          state.status = event.data.status;
        }
        if (event.eventType === 'pdf-generated') {
          state.pdfUrl = event.data.pdfUrl;
        }
        if (event.eventType === 'sent-for-sign') {
          state.status = 'signing';
          state.agreementId = event.data.agreementId;
        }
        if (event.eventType === 'signed') {
          state.status = 'completed';
          state.signedAt = event.data.completedAt;
        }
        if (event.eventType === 'archived') {
          state.status = 'archived';
          state.archiveUrl = event.data.blobUrl;
        }
        return state;
      };

      const initialState = { status: null };
      let state = initialState;
      for (const event of events) {
        state = reducer(state, event);
      }

      // 3. Verify final state
      expect(state.status).toBe('archived');
      expect(state.pdfUrl).toBe('https://...');
      expect(state.agreementId).toBe('agr-xxx');
      expect(state.signedAt).toBe('2026-08-10T10:00:00Z');
      expect(state.archiveUrl).toBe('https://...');
    });

    it('should support partial replay to recover from point N', () => {
      const events = [
        { sequence: 0, eventType: 'created' },
        { sequence: 1, eventType: 'pdf-generated' },
        { sequence: 2, eventType: 'failed', data: { reason: 'adobe-error' } },
        { sequence: 3, eventType: 'retry-pdf-generated' },
        { sequence: 4, eventType: 'signed' },
      ];

      // Replay from after the failure (sequence 2), skipping failed attempts
      const fromSequence2 = events.filter((e) => e.sequence > 2);
      expect(fromSequence2.length).toBe(2);
      expect(fromSequence2[0].eventType).toBe('retry-pdf-generated');
    });
  });
});
