'use strict';

const { processSharePointUpload, findItemByAgreementId } = require('../functions/uploadToSharePoint');
const config = require('../lib/config');
const logger = require('../lib/logger');
const monday = require('../lib/monday');
const sharepoint = require('../lib/sharepoint');
const { downloadSigned } = require('../functions/downloadSigned');

jest.mock('../lib/config');
jest.mock('../lib/logger');
jest.mock('../lib/monday');
jest.mock('../lib/sharepoint');
jest.mock('../functions/downloadSigned');

describe('uploadToSharePoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DOCFLOW_LOG_SILENT = 'true';

    // Default config
    config.load.mockReturnValue({
      sharepoint: {
        enabled: true,
        driveId: 'drive-id',
        siteId: 'site-id',
      },
      monday: {
        onboardingBoardId: 'board-123',
        columns: {
          template: 'text_template',
          agreementId: 'text_agreement',
          sharePointLink: 'link_sharepoint',
        },
      },
    });

    // Default Monday methods
    monday.readRow.mockResolvedValue({
      name: 'John Doe',
      columns: { text_template: 'Onboarding' },
    });

    monday.updateStatus.mockResolvedValue({ success: true });
    monday.updateItemColumn.mockResolvedValue(true);
    monday.logAction.mockResolvedValue(true);

    // Default SharePoint methods
    sharepoint.uploadPDF.mockResolvedValue({
      id: 'sp-file-123',
      name: 'onboarding.pdf',
      webUrl: 'https://medwatchers.sharepoint.com/Documents/onboarding.pdf',
      bytes: 1024,
    });

    // Default download
    downloadSigned.mockResolvedValue(Buffer.from('PDF content'));
  });

  afterEach(() => {
    delete process.env.DOCFLOW_LOG_SILENT;
  });

  describe('processSharePointUpload', () => {
    test('uploads PDF and updates Monday', async () => {
      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
        employeeName: 'John Doe',
        docType: 'Onboarding',
      };

      const result = await processSharePointUpload(msg);

      expect(downloadSigned).toHaveBeenCalledWith('agreement-uuid');
      expect(sharepoint.uploadPDF).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          docType: 'Onboarding',
          employeeName: 'John Doe',
          agreementId: 'agreement-uuid',
        }),
        { retries: 2 }
      );
      expect(monday.updateItemColumn).toHaveBeenCalledWith(
        'board-123', 'item-123', 'link_sharepoint',
        expect.objectContaining({ url: expect.stringContaining('sharepoint.com') })
      );
      expect(result).toMatchObject({
        itemId: 'item-123',
        agreementId: 'agreement-uuid',
        spItemId: 'sp-file-123',
      });
    });

    test('resolves itemId from agreementId', async () => {
      monday._gql.mockResolvedValueOnce({
        items_page_by_column_values: {
          items: [{ id: 'item-resolved', name: 'Jane Doe' }],
        },
      });

      const msg = {
        agreementId: 'agreement-uuid',
        // No itemId provided
      };

      const result = await processSharePointUpload(msg);

      expect(monday._gql).toHaveBeenCalled();
      expect(result.itemId).toBe('item-resolved');
    });

    test('fetches row for docType if not provided', async () => {
      monday.readRow.mockResolvedValueOnce({
        name: 'Employee Name',
        columns: { text_template: 'HR Agreement' },
      });

      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
        // No docType provided
      };

      await processSharePointUpload(msg);

      expect(monday.readRow).toHaveBeenCalledWith('board-123', 'item-123');
      // Row template column ("HR Agreement") must be applied — the metadata
      // docType is sanitized for SharePoint folder paths ('HR-Agreement').
      expect(sharepoint.uploadPDF).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          docType: 'HR-Agreement',
          fileName: expect.stringContaining('HR Agreement'),
        }),
        { retries: 2 }
      );
    });

    test('re-sign message (rev 2) adds the rev marker to the file name and comment', async () => {
      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
        employeeName: 'John Doe',
        docType: 'Document', // generic docType -> 'Signed Packet' label
        rev: 2,
      };

      await processSharePointUpload(msg);

      expect(sharepoint.uploadPDF).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          fileName: expect.stringMatching(/^Signed Packet — rev 2 — .+\.pdf$/),
        }),
        { retries: 2 }
      );
      expect(monday.logAction).toHaveBeenCalledWith(
        'item-123',
        expect.stringContaining('This is the latest revision — rev 2 replaces the earlier SharePoint copy')
      );
    });

    test('first sign (rev absent or 1) keeps the plain file name — no rev marker', async () => {
      for (const msg of [
        { agreementId: 'agreement-uuid', itemId: 'item-123', employeeName: 'John Doe', rev: 1 },
        { agreementId: 'agreement-uuid', itemId: 'item-123', employeeName: 'John Doe' }, // legacy payload
      ]) {
        sharepoint.uploadPDF.mockClear();
        await processSharePointUpload(msg);
        const metadata = sharepoint.uploadPDF.mock.calls[0][1];
        expect(metadata.fileName).not.toContain('rev');
      }
    });

    test('returns skipped if SharePoint disabled', async () => {
      config.load.mockReturnValueOnce({
        sharepoint: { enabled: false },
        monday: { onboardingBoardId: 'board-123' },
      });

      const msg = { agreementId: 'agreement-uuid', itemId: 'item-123' };
      const result = await processSharePointUpload(msg);

      expect(result.skipped).toBe(true);
      expect(sharepoint.uploadPDF).not.toHaveBeenCalled();
    });

    test('continues if Monday sharePointLink update fails (non-blocking)', async () => {
      const sharePointErr = new Error('Monday update failed');
      monday.updateItemColumn.mockRejectedValueOnce(sharePointErr);

      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
      };

      const result = await processSharePointUpload(msg);

      expect(result.spItemId).toBe('sp-file-123'); // Still succeeds
      expect(logger.warn).toHaveBeenCalledWith(
        'sharepoint-monday-update-failed',
        expect.any(Object)
      );
    });

    test('posts the SharePoint link as a card comment on success', async () => {
      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
      };

      await processSharePointUpload(msg);

      expect(monday.logAction).toHaveBeenCalledWith(
        'item-123',
        expect.stringContaining('copied to SharePoint')
      );
    });

    test('NEVER writes the status column (⑦ Done must not be clobbered)', async () => {
      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
      };

      await processSharePointUpload(msg);

      expect(monday.updateStatus).not.toHaveBeenCalled();
    });

    test('throws on PDF download failure', async () => {
      const downloadErr = new Error('Adobe API down');
      downloadSigned.mockRejectedValueOnce(downloadErr);

      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
      };

      await expect(processSharePointUpload(msg)).rejects.toThrow(
        'Adobe API down'
      );

      // Failure is explained on the card as a comment — never a status write
      expect(monday.logAction).toHaveBeenCalledWith(
        'item-123',
        expect.stringContaining('SharePoint copy failed')
      );
      expect(monday.updateStatus).not.toHaveBeenCalled();
    });

    test('throws on SharePoint upload failure', async () => {
      const spErr = new Error('SharePoint unavailable');
      sharepoint.uploadPDF.mockRejectedValueOnce(spErr);

      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
      };

      await expect(processSharePointUpload(msg)).rejects.toThrow(
        'SharePoint unavailable'
      );

      // Failure is explained on the card as a comment — never a status write
      expect(monday.logAction).toHaveBeenCalledWith(
        'item-123',
        expect.stringContaining('SharePoint copy failed')
      );
      expect(monday.updateStatus).not.toHaveBeenCalled();
    });

    test('throws if agreementId not found in Monday', async () => {
      monday._gql.mockResolvedValueOnce({
        items_page_by_column_values: { items: [] }, // Not found
      });

      const msg = { agreementId: 'nonexistent-uuid' };

      await expect(processSharePointUpload(msg)).rejects.toThrow(
        /No Monday item found/
      );
    });

    test('gracefully handles Monday error status update on failure', async () => {
      const spErr = new Error('SharePoint failed');
      sharepoint.uploadPDF.mockRejectedValueOnce(spErr);

      const statusErr = new Error('Monday also failed');
      monday.logAction.mockRejectedValueOnce(statusErr);

      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
      };

      await expect(processSharePointUpload(msg)).rejects.toThrow(
        'SharePoint failed'
      );

      // Should log the Monday failure but not double-throw
      expect(logger.error).toHaveBeenCalledWith(
        'sharepoint-error-comment-failed',
        expect.any(Error),
        expect.any(Object)
      );
    });

    test('logs complete event on success', async () => {
      const msg = {
        agreementId: 'agreement-uuid',
        itemId: 'item-123',
      };

      await processSharePointUpload(msg);

      expect(logger.event).toHaveBeenCalledWith(
        'sharepoint-stage-complete',
        expect.objectContaining({
          agreementId: 'agreement-uuid',
          itemId: 'item-123',
          spItemId: 'sp-file-123',
        })
      );
    });
  });

  describe('findItemByAgreementId', () => {
    test('finds item by agreementId', async () => {
      monday._gql.mockResolvedValueOnce({
        items_page_by_column_values: {
          items: [{ id: 'item-found', name: 'Employee Name' }],
        },
      });

      const result = await findItemByAgreementId('agreement-uuid');

      expect(result).toEqual({ itemId: 'item-found', name: 'Employee Name' });
      expect(monday._gql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ value: 'agreement-uuid' }),
        'monday-find-by-agreement'
      );
    });

    test('returns null if item not found', async () => {
      monday._gql.mockResolvedValueOnce({
        items_page_by_column_values: { items: [] },
      });

      const result = await findItemByAgreementId('nonexistent-uuid');

      expect(result).toBeNull();
    });

    test('handles Monday API error gracefully', async () => {
      const apiErr = new Error('Monday API down');
      monday._gql.mockRejectedValueOnce(apiErr);

      await expect(findItemByAgreementId('agreement-uuid')).rejects.toThrow(
        'Monday API down'
      );
    });
  });
});
