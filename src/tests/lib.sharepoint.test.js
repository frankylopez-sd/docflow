'use strict';

const sharepoint = require('../lib/sharepoint');
const config = require('../lib/config');
const logger = require('../lib/logger');

// Mock axios for HTTP testing
jest.mock('axios');
const axios = require('axios');

describe('sharepoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sharepoint._resetTokenCache();
    config.reset();
    process.env.DOCFLOW_LOG_SILENT = 'true';
  });

  afterEach(() => {
    delete process.env.DOCFLOW_LOG_SILENT;
  });

  describe('getAccessToken', () => {
    test('acquires token via client credentials flow', async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';

      axios.post.mockResolvedValueOnce({
        data: {
          access_token: 'test-token-12345',
          expires_in: 3599,
          token_type: 'Bearer',
        },
      });

      const token = await sharepoint.getAccessToken();
      expect(token).toBe('test-token-12345');
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('https://login.microsoftonline.com'),
        expect.any(Object),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );
    });

    test('caches token for ~1 hour', async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';

      axios.post.mockResolvedValueOnce({
        data: { access_token: 'cached-token', expires_in: 3599 },
      });

      const token1 = await sharepoint.getAccessToken();
      axios.post.mockClear();

      const token2 = await sharepoint.getAccessToken();
      expect(token1).toBe(token2);
      expect(axios.post).not.toHaveBeenCalled(); // Used cache
    });

    test('throws if tenant/client config missing', async () => {
      // No config set
      await expect(sharepoint.getAccessToken()).rejects.toThrow(
        /SHAREPOINT_TENANT_ID|SHAREPOINT_CLIENT_ID/
      );
    });

    test('handles token acquisition failure (network error)', async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';

      axios.post.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(sharepoint.getAccessToken()).rejects.toThrow(
        /Failed to acquire SharePoint token/
      );
    });

    test('retries 429 (throttling) on token acquisition', async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';

      const err429 = new Error('Too Many Requests');
      err429.response = { status: 429 };
      axios.post
        .mockRejectedValueOnce(err429)
        .mockResolvedValueOnce({
          data: { access_token: 'retry-token', expires_in: 3599 },
        });

      const token = await sharepoint.getAccessToken();
      expect(token).toBe('retry-token');
      expect(axios.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('graphRequest', () => {
    beforeEach(() => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';

      axios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', expires_in: 3599 },
      });
    });

    test('makes authenticated Graph API request', async () => {
      axios.mockResolvedValueOnce({
        data: { id: 'file-123', name: 'document.pdf', size: 1024 },
      });

      const result = await sharepoint.graphRequest(
        'GET',
        '/drives/drive-id/items/item-id'
      );

      expect(result).toEqual({
        id: 'file-123',
        name: 'document.pdf',
        size: 1024,
      });
      expect(axios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: expect.stringContaining('/drives/drive-id/items/item-id'),
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });

    test('retries 5xx errors with exponential backoff', async () => {
      const err500 = new Error('Service Unavailable');
      err500.response = { status: 500 };
      axios
        .mockRejectedValueOnce(err500)
        .mockRejectedValueOnce(err500)
        .mockResolvedValueOnce({
          data: { id: 'file-123' },
        });

      const result = await sharepoint.graphRequest(
        'GET',
        '/drives/drive-id/items/item-id',
        null,
        { retries: 3 }
      );

      expect(result.id).toBe('file-123');
      expect(axios).toHaveBeenCalledTimes(3);
    });

    test('handles 429 (throttle) with Retry-After header', async () => {
      const err429 = new Error('Too Many Requests');
      err429.response = {
        status: 429,
        headers: { 'retry-after': '2' }, // 2 seconds
      };
      axios
        .mockRejectedValueOnce(err429)
        .mockResolvedValueOnce({
          data: { id: 'file-123' },
        });

      const result = await sharepoint.graphRequest(
        'GET',
        '/drives/drive-id/items/item-id'
      );

      expect(result.id).toBe('file-123');
    });

    test('does not retry 400 Bad Request', async () => {
      const err400 = new Error('Bad Request');
      err400.response = { status: 400 };
      axios.mockRejectedValueOnce(err400);

      await expect(
        sharepoint.graphRequest(
          'GET',
          '/drives/drive-id/items/item-id',
          null,
          { retries: 3 }
        )
      ).rejects.toThrow('Bad Request');

      expect(axios).toHaveBeenCalledTimes(1); // No retries
    });

    test('does not retry 401 Unauthorized', async () => {
      const err401 = new Error('Unauthorized');
      err401.response = { status: 401 };
      axios.mockRejectedValueOnce(err401);

      await expect(
        sharepoint.graphRequest(
          'GET',
          '/drives/drive-id/items/item-id',
          null,
          { retries: 3 }
        )
      ).rejects.toThrow('Unauthorized');

      expect(axios).toHaveBeenCalledTimes(1); // No retries
    });

    test('does not retry 403 Forbidden', async () => {
      const err403 = new Error('Forbidden');
      err403.response = { status: 403 };
      axios.mockRejectedValueOnce(err403);

      await expect(
        sharepoint.graphRequest(
          'GET',
          '/drives/drive-id/items/item-id',
          null,
          { retries: 3 }
        )
      ).rejects.toThrow('Forbidden');

      expect(axios).toHaveBeenCalledTimes(1); // No retries
    });

    test('retries 408 Request Timeout', async () => {
      const err408 = new Error('Request Timeout');
      err408.response = { status: 408 };
      axios
        .mockRejectedValueOnce(err408)
        .mockResolvedValueOnce({
          data: { id: 'file-123' },
        });

      const result = await sharepoint.graphRequest(
        'GET',
        '/drives/drive-id/items/item-id',
        null,
        { retries: 2 }
      );

      expect(result.id).toBe('file-123');
      expect(axios).toHaveBeenCalledTimes(2);
    });
  });

  describe('ensureFolderPath', () => {
    beforeEach(async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';
      process.env.SHAREPOINT_SITE_ID = 'site-id';
      process.env.SHAREPOINT_DRIVE_ID = 'drive-id';

      axios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', expires_in: 3599 },
      });
    });

    test('returns folder ID if path exists', async () => {
      axios.mockResolvedValueOnce({
        data: { id: 'folder-123', name: 'August', folder: {} },
      });

      const folderId = await sharepoint.ensureFolderPath('Onboarding');
      expect(folderId).toBe('folder-123');
    });

    test('creates folder recursively if not exists', async () => {
      const err404 = new Error('Not Found');
      err404.response = { status: 404 };

      // First call: get path (404 - not found)
      axios.mockRejectedValueOnce(err404);

      // Subsequent calls: list children (empty), then create folders
      axios.mockResolvedValueOnce({ data: { value: [] } }); // list for Documents
      axios.mockResolvedValueOnce({ data: { id: 'documents-id' } }); // create Documents
      axios.mockResolvedValueOnce({ data: { value: [] } }); // list for Onboarding
      axios.mockResolvedValueOnce({ data: { id: 'onboarding-id' } }); // create Onboarding
      axios.mockResolvedValueOnce({ data: { value: [] } }); // list for 2026
      axios.mockResolvedValueOnce({ data: { id: 'year-id' } }); // create 2026
      axios.mockResolvedValueOnce({ data: { value: [] } }); // list for 08
      axios.mockResolvedValueOnce({ data: { id: 'month-id' } }); // create 08
      axios.mockResolvedValueOnce({ data: { value: [] } }); // list for Onboarding (doctype)
      axios.mockResolvedValueOnce({ data: { id: 'doctype-id' } }); // create Onboarding (doctype)

      const folderId = await sharepoint.ensureFolderPath('Onboarding');
      expect(folderId).toBe('doctype-id');
    });
  });

  describe('uploadPDF', () => {
    beforeEach(async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';
      process.env.SHAREPOINT_SITE_ID = 'site-id';
      process.env.SHAREPOINT_DRIVE_ID = 'drive-id';

      axios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', expires_in: 3599 },
      });
    });

    test('uploads PDF and returns file info', async () => {
      const pdfBuffer = Buffer.from('PDF content');

      // Mock folder path check (exists)
      axios.mockResolvedValueOnce({
        data: { id: 'folder-id', folder: {} },
      });

      // Mock upload
      axios.mockResolvedValueOnce({
        data: {
          id: 'file-123',
          name: 'onboarding.pdf',
          webUrl: 'https://medwatchers.sharepoint.com/Documents/onboarding.pdf',
        },
      });

      // Mock metadata update
      axios.mockResolvedValueOnce({
        data: { id: 'file-123' },
      });

      const result = await sharepoint.uploadPDF(pdfBuffer, {
        fileName: 'onboarding.pdf',
        docType: 'Onboarding',
        employeeName: 'John Doe',
        agreementId: 'agreement-uuid',
      });

      expect(result).toMatchObject({
        id: 'file-123',
        name: 'onboarding.pdf',
        bytes: pdfBuffer.length,
      });
    });

    test('throws if fileBuffer is not a Buffer', async () => {
      await expect(
        sharepoint.uploadPDF('not a buffer', {})
      ).rejects.toThrow('fileBuffer must be a Buffer');
    });

    test('continues if metadata tagging fails (non-blocking)', async () => {
      const pdfBuffer = Buffer.from('PDF content');
      const metadataErr = new Error('PATCH failed');
      metadataErr.response = { status: 500 };

      // Mock folder check
      axios.mockResolvedValueOnce({
        data: { id: 'folder-id' },
      });

      // Mock upload (success)
      axios.mockResolvedValueOnce({
        data: {
          id: 'file-123',
          name: 'onboarding.pdf',
          webUrl: 'https://...',
        },
      });

      // Mock metadata (fail)
      axios.mockRejectedValueOnce(metadataErr);

      const result = await sharepoint.uploadPDF(pdfBuffer, {
        fileName: 'onboarding.pdf',
      });

      expect(result.id).toBe('file-123'); // Still succeeds
    });
  });

  describe('getFileInfo', () => {
    beforeEach(async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';
      process.env.SHAREPOINT_DRIVE_ID = 'drive-id';

      axios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', expires_in: 3599 },
      });
    });

    test('retrieves file metadata from Graph', async () => {
      axios.mockResolvedValueOnce({
        data: {
          id: 'file-123',
          name: 'document.pdf',
          size: 2048,
          webUrl: 'https://medwatchers.sharepoint.com/document.pdf',
          createdDateTime: '2026-08-13T18:30:00Z',
          properties: { docType: 'Onboarding' },
        },
      });

      const info = await sharepoint.getFileInfo('file-123');
      expect(info.id).toBe('file-123');
      expect(info.name).toBe('document.pdf');
      expect(info.size).toBe(2048);
      expect(info.properties.docType).toBe('Onboarding');
    });

    test('throws if file not found', async () => {
      const err404 = new Error('Not Found');
      err404.response = { status: 404 };
      axios.mockRejectedValueOnce(err404);

      await expect(sharepoint.getFileInfo('invalid-id')).rejects.toThrow(
        'Not Found'
      );
    });
  });

  describe('deleteFile', () => {
    beforeEach(async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';
      process.env.SHAREPOINT_DRIVE_ID = 'drive-id';

      axios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', expires_in: 3599 },
      });
    });

    test('deletes file and returns success', async () => {
      axios.mockResolvedValueOnce({ data: {} }); // DELETE returns 204 (empty)

      const result = await sharepoint.deleteFile('file-123');
      expect(result.success).toBe(true);
    });

    test('succeeds gracefully if file already deleted', async () => {
      const err404 = new Error('Not Found');
      err404.response = { status: 404 };
      axios.mockRejectedValueOnce(err404);

      const result = await sharepoint.deleteFile('already-deleted');
      expect(result.success).toBe(true);
      expect(result.alreadyDeleted).toBe(true);
    });
  });

  describe('listFiles', () => {
    beforeEach(async () => {
      process.env.SHAREPOINT_TENANT_ID = 'tenant-id';
      process.env.SHAREPOINT_CLIENT_ID = 'client-id';
      process.env.SHAREPOINT_CLIENT_SECRET = 'client-secret';
      process.env.SHAREPOINT_DRIVE_ID = 'drive-id';

      axios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', expires_in: 3599 },
      });
    });

    test('lists files in folder', async () => {
      axios.mockResolvedValueOnce({
        data: {
          value: [
            { id: 'file-1', name: 'doc1.pdf', folder: undefined },
            { id: 'file-2', name: 'doc2.pdf', folder: undefined },
            { id: 'folder-1', name: 'subfolder', folder: {} }, // Excluded (folder)
          ],
        },
      });

      const files = await sharepoint.listFiles('Documents/Onboarding/2026/08');
      expect(files).toHaveLength(2);
      expect(files[0].name).toBe('doc1.pdf');
      expect(files[1].name).toBe('doc2.pdf');
    });

    test('returns empty array if folder not found', async () => {
      const err404 = new Error('Not Found');
      err404.response = { status: 404 };
      axios.mockRejectedValueOnce(err404);

      const files = await sharepoint.listFiles('nonexistent/path');
      expect(files).toEqual([]);
    });
  });
});
