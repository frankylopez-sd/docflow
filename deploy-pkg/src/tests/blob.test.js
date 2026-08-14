'use strict';
/** Unit tests: Azure Blob client against the in-memory mock SDK. */

jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const storageMock = require('@azure/storage-blob');
const config = require('../lib/config');
const blob = require('../lib/blob');

beforeEach(() => {
  storageMock.__reset();
  config.reset();
  blob._resetState();
  delete process.env.STORAGE_ACCOUNT_NAME_SECONDARY;
  delete process.env.STORAGE_ACCOUNT_KEY_SECONDARY;
});

describe('uploadPDF', () => {
  test('uploads byte-exact and returns url + SAS url', async () => {
    const data = Buffer.from('%PDF-1.7 payload-bytes-here');
    const result = await blob.uploadPDF('pdf-temp', 'item_doc_1.pdf', data);

    expect(result.bytes).toBe(data.length);
    expect(result.url).toBe('https://teststore.blob.core.windows.net/pdf-temp/item_doc_1.pdf');
    expect(result.sasUrl).toContain('sig=');
    expect(result.account).toBe('teststore');

    const stored = storageMock.__store.get('teststore|pdf-temp|item_doc_1.pdf');
    expect(Buffer.compare(stored.data, data)).toBe(0); // byte-exact
  });

  test('SAS url expires ~24h out', async () => {
    const before = Date.now();
    const result = await blob.uploadPDF('pdf-temp', 'sas_check.pdf', Buffer.from('%PDF'));
    const seMatch = /se=([^&]+)/.exec(result.sasUrl);
    expect(seMatch).not.toBeNull();
    const expiry = new Date(decodeURIComponent(seMatch[1])).getTime();
    const hours = (expiry - before) / 3600000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  test('detects size mismatch (byte-exact verification)', async () => {
    storageMock.__corrupt.add('teststore');
    await expect(
      blob.uploadPDF('pdf-temp', 'corrupt.pdf', Buffer.from('%PDF corrupted-on-wire'))
    ).rejects.toThrow(/size mismatch/);
  });

  test('falls back to the secondary account when primary fails', async () => {
    process.env.STORAGE_ACCOUNT_NAME_SECONDARY = 'backupstore';
    process.env.STORAGE_ACCOUNT_KEY_SECONDARY = 'YmFja3VwLWtleQ==';
    config.reset();
    blob._resetState();
    storageMock.__failUpload.add('teststore');

    const data = Buffer.from('%PDF failover-payload');
    const result = await blob.uploadPDF('pdf-archive', 'failover.pdf', data);

    expect(result.account).toBe('backupstore');
    const stored = storageMock.__store.get('backupstore|pdf-archive|failover.pdf');
    expect(Buffer.compare(stored.data, data)).toBe(0);
  });

  test('rejects non-Buffer input', async () => {
    await expect(blob.uploadPDF('pdf-temp', 'x.pdf', 'not-a-buffer')).rejects.toThrow(/Buffer/);
  });
});

describe('downloadPDF', () => {
  test('returns the same bytes that were uploaded', async () => {
    const data = Buffer.from('%PDF round-trip-bytes');
    await blob.uploadPDF('pdf-temp', 'roundtrip.pdf', data);
    const downloaded = await blob.downloadPDF('pdf-temp', 'roundtrip.pdf');
    expect(Buffer.compare(downloaded, data)).toBe(0);
  });

  test('throws for a missing blob', async () => {
    await expect(blob.downloadPDF('pdf-temp', 'does-not-exist.pdf')).rejects.toThrow(/BlobNotFound/);
  });
});

describe('deletePDF', () => {
  test('deletes an existing blob (file gone afterwards)', async () => {
    await blob.uploadPDF('pdf-temp', 'to-delete.pdf', Buffer.from('%PDF'));
    const result = await blob.deletePDF('pdf-temp', 'to-delete.pdf');
    expect(result.success).toBe(true);
    expect(result.existed).toBe(true);
    expect(storageMock.__store.has('teststore|pdf-temp|to-delete.pdf')).toBe(false);
    await expect(blob.downloadPDF('pdf-temp', 'to-delete.pdf')).rejects.toThrow();
  });

  test('deleting a missing blob still succeeds (idempotent)', async () => {
    const result = await blob.deletePDF('pdf-temp', 'never-existed.pdf');
    expect(result.success).toBe(true);
    expect(result.existed).toBe(false);
  });
});

describe('listOldFiles', () => {
  test('returns only files older than the age threshold', async () => {
    await blob.uploadPDF('pdf-temp', 'old-file.pdf', Buffer.from('%PDF old'));
    await blob.uploadPDF('pdf-temp', 'fresh-file.pdf', Buffer.from('%PDF new'));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    storageMock.__setLastModified('teststore', 'pdf-temp', 'old-file.pdf', eightDaysAgo);

    const old = await blob.listOldFiles('pdf-temp', 168); // 7 days
    expect(old).toEqual(['old-file.pdf']);
  });

  test('returns empty when nothing is old enough', async () => {
    await blob.uploadPDF('pdf-temp', 'brand-new.pdf', Buffer.from('%PDF'));
    const old = await blob.listOldFiles('pdf-temp', 1);
    expect(old).toEqual([]);
  });
});

describe('blobUrl', () => {
  test('builds the permanent archive url', () => {
    expect(blob.blobUrl('pdf-archive', '555_Offer_1.pdf'))
      .toBe('https://teststore.blob.core.windows.net/pdf-archive/555_Offer_1.pdf');
  });
});
