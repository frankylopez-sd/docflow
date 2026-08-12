'use strict';
/**
 * Integration test: full offline simulation of the pipeline
 *   Monday checkbox -> generatePDF -> sendForSign -> adobeWebhook -> archive
 * All external APIs (Monday GraphQL, Adobe IMS/PDF/Sign, Azure Blob) mocked.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const {
  PDF_BYTES, SIGNED_BYTES, makeBackend, installRoutes, makeMondayJwt, checkboxEvent,
} = require('./helpers/fakeEnv');

const config = require('../lib/config');
const adobe = require('../lib/adobe');
const monday = require('../lib/monday');
const blob = require('../lib/blob');

const mondayWebhook = require('../functions/mondayWebhook');
const generatePDF = require('../functions/generatePDF');
const sendForSign = require('../functions/sendForSign');
const adobeWebhook = require('../functions/adobeWebhook');
const archiveToBlob = require('../functions/archiveToBlob');
const cleanup = require('../functions/cleanup');

let backend;

beforeEach(() => {
  jest.clearAllMocks();
  storageMock.__reset();
  config.reset();
  adobe._resetState();
  monday._resetState();
  blob._resetState();
  backend = makeBackend();
  installRoutes(axios, backend);
});

describe('webhook entry points', () => {
  test('Monday challenge handshake echoes the challenge', async () => {
    const result = await mondayWebhook.handleWebhook({ headers: {}, body: { challenge: 'abc123' } });
    expect(result.status).toBe(200);
    expect(result.body.challenge).toBe('abc123');
    expect(result.queueMessage).toBeNull();
  });

  test('bad Monday signature is rejected with 401', async () => {
    const req = checkboxEvent('Bearer not.a.validjwt');
    const result = await mondayWebhook.handleWebhook(req);
    expect(result.status).toBe(401);
    expect(result.queueMessage).toBeNull();
  });

  test('unchecked checkbox is ignored', async () => {
    const req = checkboxEvent(makeMondayJwt('test-signing-secret'));
    req.body.event.value = { checked: false };
    const result = await mondayWebhook.handleWebhook(req);
    expect(result.status).toBe(200);
    expect(result.queueMessage).toBeNull();
  });

  test('Adobe webhook rejects unknown client id', async () => {
    const result = await adobeWebhook.handleAdobeWebhook({
      method: 'POST',
      headers: { 'x-adobesign-clientid': 'evil-client' },
      body: { event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'AGR-42' } },
    });
    expect(result.status).toBe(401);
  });

  test('Adobe webhook verification ping echoes the client id', async () => {
    const result = await adobeWebhook.handleAdobeWebhook({
      method: 'GET',
      headers: { 'x-adobesign-clientid': 'test-client-id' },
      body: {},
    });
    expect(result.status).toBe(200);
    expect(result.headers['X-AdobeSign-ClientId']).toBe('test-client-id');
    expect(result.body.xAdobeSignClientId).toBe('test-client-id');
  });
});

describe('happy path: Monday -> PDF -> Sign -> Archive', () => {
  test('complete flow ends with Completed status, archived PDF and archive row', async () => {
    // 1. checkbox checked -> queue message
    const hook = await mondayWebhook.handleWebhook(checkboxEvent(makeMondayJwt('test-signing-secret')));
    expect(hook.status).toBe(200);
    expect(hook.queueMessage).toMatchObject({ boardId: '111', itemId: '555' });

    // 2. generate PDF -> temp blob + status Generated
    const signMsg = await generatePDF.processGenerate(hook.queueMessage);
    expect(backend.rows[555].written.status).toEqual({ label: 'Generated' });
    expect(signMsg.pdfUrl).toContain('teststore.blob.core.windows.net/pdf-temp/');
    expect(signMsg.signers).toEqual(['hr@medwatchers.com', '{employee}']);
    const tempKeys = [...storageMock.__store.keys()].filter((k) => k.includes('|pdf-temp|'));
    expect(tempKeys).toHaveLength(1);

    // 3. send for signature -> agreement + status Sent for Sign
    const sent = await sendForSign.processSend(signMsg);
    expect(sent.agreementId).toBe('AGR-42');
    expect(backend.rows[555].written.status).toEqual({ label: 'Sent for Sign' });
    expect(backend.serialize(backend.rows[555].written.text_agreement)).toBe('AGR-42');

    // 4. Adobe completion webhook -> archive queue message
    const adobeResult = await adobeWebhook.handleAdobeWebhook({
      method: 'POST',
      headers: { 'x-adobesign-clientid': 'test-client-id' },
      body: {
        event: 'AGREEMENT_WORKFLOW_COMPLETED',
        agreement: {
          id: 'AGR-42',
          status: 'SIGNED',
          participantSetsInfo: [
            { order: 1, status: 'COMPLETED', memberInfos: [{ email: 'hr@medwatchers.com' }] },
            { order: 2, status: 'COMPLETED', memberInfos: [{ email: 'jane@medwatchers.com' }] },
          ],
        },
      },
    });
    expect(adobeResult.status).toBe(200);
    expect(adobeResult.queueMessage.agreementId).toBe('AGR-42');
    expect(adobeResult.queueMessage.signers).toHaveLength(2);

    // 5. archive -> permanent blob, Completed status, archive board row
    const archived = await archiveToBlob.processArchive(adobeResult.queueMessage);
    expect(archived.itemId).toBe('555');
    expect(archived.url).toContain('teststore.blob.core.windows.net/pdf-archive/555_');

    const archiveKey = [...storageMock.__store.keys()].find((k) => k.includes('|pdf-archive|'));
    expect(archiveKey).toBeDefined();
    expect(Buffer.compare(storageMock.__store.get(archiveKey).data, SIGNED_BYTES)).toBe(0);

    expect(backend.rows[555].written.status).toEqual({ label: 'Completed' });
    expect(backend.rows[555].written.link_signed.url).toBe(archived.url);
    expect(backend.archiveItems).toHaveLength(1);
    expect(backend.archiveItems[0].name).toContain('Jane Doe');
    expect(archived.archiveItemId).toBe(backend.archiveItems[0].id);
  });
});

describe('failure recovery', () => {
  test('PDF generation failure marks the row PDF Gen Failed, then recovery succeeds', async () => {
    installRoutes(axios, backend, { pdfGenFails: true });
    const msg = { boardId: '111', itemId: '555' };
    await expect(generatePDF.processGenerate(msg)).rejects.toThrow(/unavailable/);
    expect(backend.rows[555].written.status).toEqual({ label: 'PDF Gen Failed' });

    // Adobe comes back -> the queue redelivery succeeds
    installRoutes(axios, backend);
    const next = await generatePDF.processGenerate(msg);
    expect(backend.rows[555].written.status).toEqual({ label: 'Generated' });
    expect(next.pdfUrl).toContain('pdf-temp');
  });

  test('Sign failure marks the row Sign Failed, then recovery succeeds', async () => {
    const signMsg = await generatePDF.processGenerate({ boardId: '111', itemId: '555' });

    installRoutes(axios, backend, { signFails: true });
    await expect(sendForSign.processSend(signMsg)).rejects.toThrow(/unavailable/);
    expect(backend.rows[555].written.status).toEqual({ label: 'Sign Failed' });

    installRoutes(axios, backend);
    const sent = await sendForSign.processSend(signMsg);
    expect(sent.agreementId).toBe('AGR-42');
    expect(backend.rows[555].written.status).toEqual({ label: 'Sent for Sign' });
  });

  test('archive failure for unknown agreement throws and leaves no archive row', async () => {
    await expect(
      archiveToBlob.processArchive({ agreementId: 'AGR-UNKNOWN' })
    ).rejects.toThrow(/No Monday item found/);
    expect(backend.archiveItems).toHaveLength(0);
  });
});

describe('cleanup timer', () => {
  test('deletes only temp files older than the threshold', async () => {
    await blob.uploadPDF('pdf-temp', 'ancient.pdf', Buffer.from('%PDF old'));
    await blob.uploadPDF('pdf-temp', 'recent.pdf', Buffer.from('%PDF new'));
    storageMock.__setLastModified('teststore', 'pdf-temp', 'ancient.pdf',
      new Date(Date.now() - 10 * 24 * 3600 * 1000));

    const result = await cleanup.runCleanup();
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
    expect(storageMock.__store.has('teststore|pdf-temp|ancient.pdf')).toBe(false);
    expect(storageMock.__store.has('teststore|pdf-temp|recent.pdf')).toBe(true);
  });
});
