'use strict';
/**
 * Storage module tests: blob + job queue operations.
 */

jest.mock('../lib/config');
jest.mock('../lib/blob');
jest.mock('../lib/logger');

const config = require('../lib/config');
const blob = require('../lib/blob');
const logger = require('../lib/logger');
const storage = require('../lib/storage');

describe('Storage Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.load.mockReturnValue({
      storage: {
        tempContainer: 'pdf-temp',
        archiveContainer: 'pdf-archive',
      },
    });
    storage._resetQueue();

    // Mock logger methods
    logger.event = jest.fn();
    logger.warn = jest.fn();
    logger.error = jest.fn();

    // Default: queue index doesn't exist (first time)
    blob.downloadPDF.mockRejectedValue({ code: 'BlobNotFound' });
    blob.uploadPDF.mockResolvedValue({
      url: 'https://test.blob.core.windows.net/test',
      sasUrl: 'https://test.blob.core.windows.net/test?sas',
      account: 'testaccount',
      bytes: 0,
    });
  });

  describe('uploadBlob', () => {
    it('should upload a blob and return metadata', async () => {
      const buffer = Buffer.from('test pdf content');
      blob.uploadPDF.mockResolvedValue({
        url: 'https://test.blob.core.windows.net/pdf-temp/test.pdf',
        sasUrl: 'https://test.blob.core.windows.net/pdf-temp/test.pdf?sas',
        account: 'testaccount',
        bytes: buffer.length,
      });

      const result = await storage.uploadBlob('test.pdf', buffer);

      expect(blob.uploadPDF).toHaveBeenCalledWith('pdf-temp', 'test.pdf', buffer);
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('sasUrl');
      expect(result.bytes).toBe(buffer.length);
      expect(logger.event).toHaveBeenCalledWith('storage-blob-uploaded', expect.any(Object));
    });

    it('should reject invalid inputs', async () => {
      await expect(storage.uploadBlob('test.pdf', 'not-a-buffer'))
        .rejects.toThrow('buffer must be a Buffer');
      await expect(storage.uploadBlob('', Buffer.from('test')))
        .rejects.toThrow('name must be a non-empty string');
      await expect(storage.uploadBlob(null, Buffer.from('test')))
        .rejects.toThrow('name must be a non-empty string');
    });
  });

  describe('downloadBlob', () => {
    it('should download a blob', async () => {
      const buffer = Buffer.from('test pdf content');
      blob.downloadPDF.mockResolvedValue(buffer);

      const result = await storage.downloadBlob('test.pdf');

      expect(blob.downloadPDF).toHaveBeenCalledWith('pdf-temp', 'test.pdf');
      expect(result).toBe(buffer);
      expect(logger.event).toHaveBeenCalledWith('storage-blob-downloaded', expect.any(Object));
    });

    it('should reject invalid inputs', async () => {
      await expect(storage.downloadBlob(''))
        .rejects.toThrow('name must be a non-empty string');
      await expect(storage.downloadBlob(null))
        .rejects.toThrow('name must be a non-empty string');
    });
  });

  describe('queueJob', () => {
    it('should enqueue a job and return jobId', async () => {
      const job = { itemId: '12345', boardId: '99999', eventType: 'webhook' };

      const jobId = await storage.queueJob(job);

      expect(jobId).toBeTruthy();
      expect(jobId).toMatch(/99999-12345-/);
      expect(blob.uploadPDF).toHaveBeenCalled();
      expect(logger.event).toHaveBeenCalledWith('storage-job-queued', expect.any(Object));
    });

    it('should reject invalid inputs', async () => {
      await expect(storage.queueJob(null))
        .rejects.toThrow('job must be an object');
      await expect(storage.queueJob({}))
        .rejects.toThrow('job.itemId is required');
      await expect(storage.queueJob({ itemId: null }))
        .rejects.toThrow('job.itemId is required');
    });

    it('should include all job data with metadata', async () => {
      const job = { itemId: '12345', boardId: '99999', eventType: 'webhook', custom: 'data' };

      await storage.queueJob(job);

      // Find the upload call that has the job JSON (not the index)
      const uploadCalls = blob.uploadPDF.mock.calls.filter(c => c[1].includes('jobs/'));
      expect(uploadCalls.length).toBeGreaterThan(0);

      const jobBuffer = uploadCalls[0][2];
      const jobData = JSON.parse(jobBuffer.toString('utf8'));
      expect(jobData).toHaveProperty('jobId');
      expect(jobData).toHaveProperty('enqueuedAt');
      expect(jobData).toHaveProperty('status', 'pending');
      expect(jobData.custom).toBe('data');
    });
  });

  describe('dequeueJob', () => {
    it('should dequeue a job and mark as processing', async () => {
      const job = { itemId: '12345', boardId: '99999', eventType: 'webhook' };
      const jobId = await storage.queueJob(job);

      // Reset mocks and set up specific responses
      blob.downloadPDF.mockReset();

      // When dequeue is called, it loads the index (which has jobId in pending)
      const indexBuffer = Buffer.from(JSON.stringify({
        pending: [jobId],
        processing: {},
        completed: [],
      }));

      const jobBuffer = Buffer.from(JSON.stringify({
        jobId,
        itemId: '12345',
        boardId: '99999',
        status: 'pending',
      }));

      // First call: load index
      // Second call: load job
      blob.downloadPDF
        .mockResolvedValueOnce(indexBuffer)
        .mockResolvedValueOnce(jobBuffer);

      const result = await storage.dequeueJob();

      expect(result).toBeTruthy();
      expect(result.jobId).toBe(jobId);
      expect(logger.event).toHaveBeenCalledWith('storage-job-dequeued', expect.any(Object));
    });

    it('should return null if queue is empty', async () => {
      blob.downloadPDF.mockRejectedValue({ code: 'BlobNotFound' });

      const result = await storage.dequeueJob();

      expect(result).toBeNull();
    });
  });

  describe('completeJob', () => {
    it('should mark job as completed', async () => {
      const jobBuffer = Buffer.from(JSON.stringify({
        jobId: 'test-job',
        itemId: '12345',
        status: 'processing',
      }));
      const indexBuffer = Buffer.from(JSON.stringify({
        pending: [],
        processing: { 'test-job': {} },
        completed: [],
      }));

      blob.downloadPDF
        .mockResolvedValueOnce(indexBuffer)
        .mockResolvedValueOnce(jobBuffer);

      await storage.completeJob('test-job', { pdfUrl: 'test' });

      expect(blob.uploadPDF).toHaveBeenCalled();
      expect(logger.event).toHaveBeenCalledWith('storage-job-completed', { jobId: 'test-job' });
    });

    it('should reject invalid jobId', async () => {
      await expect(storage.completeJob(''))
        .rejects.toThrow('jobId must be a non-empty string');
      await expect(storage.completeJob(null))
        .rejects.toThrow('jobId must be a non-empty string');
    });
  });

  describe('failJob', () => {
    it('should mark job as failed and optionally retry', async () => {
      const jobBuffer = Buffer.from(JSON.stringify({
        jobId: 'test-job',
        itemId: '12345',
        status: 'processing',
      }));
      const indexBuffer = Buffer.from(JSON.stringify({
        pending: [],
        processing: { 'test-job': {} },
        completed: [],
      }));

      blob.downloadPDF
        .mockResolvedValueOnce(indexBuffer)
        .mockResolvedValueOnce(jobBuffer);

      const err = new Error('Test error');
      await storage.failJob('test-job', err, true);

      expect(blob.uploadPDF).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'storage-job-retrying',
        expect.objectContaining({ jobId: 'test-job', error: 'Test error' })
      );
    });
  });

  describe('getJob', () => {
    it('should retrieve job metadata', async () => {
      const jobData = { jobId: 'test-job', itemId: '12345', status: 'pending' };
      const jobBuffer = Buffer.from(JSON.stringify(jobData));
      blob.downloadPDF.mockResolvedValue(jobBuffer);

      const result = await storage.getJob('test-job');

      expect(result).toEqual(jobData);
    });

    it('should return null if job not found', async () => {
      blob.downloadPDF.mockRejectedValue({ code: 'BlobNotFound' });

      const result = await storage.getJob('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getQueueStats', () => {
    it('should return queue statistics', async () => {
      blob.uploadPDF.mockResolvedValue({ url: 'test' });
      blob.downloadPDF.mockRejectedValue({ code: 'BlobNotFound' });

      const stats = await storage.getQueueStats();

      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('processing');
      expect(stats).toHaveProperty('completed');
      expect(typeof stats.pending).toBe('number');
    });
  });
});
