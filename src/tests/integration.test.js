'use strict';
/**
 * Integration test: full offline simulation of the pipeline
 *   Monday checkbox -> generatePDF -> offer "③ 👤 Review" (HR review gate)
 *   -> HR approval webhook (offer "④ ✅ Approve") -> sendForSign
 *   -> adobeWebhook -> archive
 * Status/offer label vocabulary comes from config
 * (config.load().monday.statusLabels / offerLabels) — never hardcode labels.
 * All external APIs (Monday GraphQL, Adobe IMS/PDF/Sign, Azure Blob) mocked.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const {
  PDF_BYTES, SIGNED_BYTES, makeBackend, installRoutes, makeMondayJwt, checkboxEvent, offerStatusEvent,
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

function makeContext() {
  return { bindings: {}, bindingData: {}, res: null };
}

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

  test('offer-status changes other than the approval label are ignored', async () => {
    // Our own lifecycle writes (Generating/Review/Signing) re-trigger
    // the webhook — none of them may queue signing.
    const { offerLabels } = config.load().monday;
    for (const label of [offerLabels.generating, offerLabels.ready, offerLabels.sent]) {
      const result = await mondayWebhook.handleWebhook(
        offerStatusEvent(makeMondayJwt('test-signing-secret'), label)
      );
      expect(result.status).toBe(200);
      expect(result.queueMessage).toBeNull();
      expect(result.signMessage).toBeUndefined();
    }
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

describe('happy path: Monday -> PDF -> HR approval -> Sign -> Archive', () => {
  test('complete flow ends with the Done status, archived PDF and signed link', async () => {
    const cfg = config.load();
    const offerCol = cfg.monday.columns.offerStatus;
    const { statusLabels, offerLabels } = cfg.monday;

    // 1. checkbox checked -> generate queue message
    const hook = await mondayWebhook.handleWebhook(checkboxEvent(makeMondayJwt('test-signing-secret')));
    expect(hook.status).toBe(200);
    expect(hook.queueMessage).toMatchObject({ boardId: '111', itemId: '555' });

    // 2. generate PDF (hydrates hire data from the Monday row) -> temp blob,
    //    status moves to docsInProgress, offer lifecycle ends at the ready
    //    (HR review) label. HR review gate: NOTHING is enqueued for
    //    signing here.
    const genCtx = makeContext();
    await generatePDF.processGenerate(genCtx, hook.queueMessage);
    expect(backend.rows[555].written.status).toEqual({ label: statusLabels.docsInProgress });
    expect(backend.rows[555].written[offerCol]).toEqual({ label: offerLabels.ready });
    expect(genCtx.bindings.signQueue).toBeUndefined();
    expect(genCtx.res.status).toBe(200);
    expect(genCtx.res.body.status).toMatch(/awaiting HR review/i);
    const pdfLink = backend.rows[555].written.link_pdf;
    expect(pdfLink.url).toContain('teststore.blob.core.windows.net/pdf-temp/');
    const tempKeys = [...storageMock.__store.keys()].filter((k) => k.includes('|pdf-temp|'));
    expect(tempKeys).toHaveLength(1);

    // 3. HR approves: offer-status column flips to the approved label ->
    //    webhook routes to the sign queue with a {boardId, itemId} message
    //    (Monday stays the database of record).
    const approveCtx = makeContext();
    await mondayWebhook(approveCtx, offerStatusEvent(makeMondayJwt('test-signing-secret'), offerLabels.approved, offerCol));
    expect(approveCtx.res.status).toBe(200);
    expect(approveCtx.res.body).toMatchObject({ queued: true, itemId: '555', route: 'sign' });
    expect(approveCtx.bindings.generateQueue).toBeUndefined(); // approval never re-generates
    const signMsg = JSON.parse(approveCtx.bindings.signQueue);
    expect(signMsg).toMatchObject({ boardId: '111', itemId: '555' });
    expect(new Date(signMsg.approvedAt).getTime()).not.toBeNaN();

    // 4. send for signature: hydrates the PDF link + hire fields from Monday,
    //    creates the agreement, status + offer lifecycle -> the signing labels
    const signCtx = makeContext();
    await sendForSign(signCtx, signMsg);
    expect(signCtx.res.body.agreementId).toBe('AGR-42');
    expect(signCtx.res.body.signers).toBe(3); // HR -> Manager -> Employee, serial
    expect(backend.rows[555].written.status).toEqual({ label: statusLabels.outForSignature });
    expect(backend.serialize(backend.rows[555].written.text_agreement)).toBe('AGR-42');
    expect(backend.rows[555].written[offerCol]).toEqual({ label: offerLabels.sent });

    // 5. Adobe completion webhook -> archive queue message
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

    // 6. archive (resolves the Monday item from the agreementId) -> permanent
    //    blob, signed link, status Done
    const archCtx = makeContext();
    await archiveToBlob.processArchive(archCtx, adobeResult.queueMessage);
    const archived = archCtx.res.body;
    expect(archived.itemId).toBe('555');
    expect(archived.archiveUrl).toContain('teststore.blob.core.windows.net/pdf-archive/');

    const archiveKey = [...storageMock.__store.keys()].find((k) => k.includes('|pdf-archive|'));
    expect(archiveKey).toBeDefined();
    expect(Buffer.compare(storageMock.__store.get(archiveKey).data, SIGNED_BYTES)).toBe(0);

    expect(backend.rows[555].written.status).toEqual({ label: statusLabels.complete });
    expect(backend.rows[555].written[offerCol]).toEqual({ label: offerLabels.signed });
    expect(backend.rows[555].written.link_signed).toMatchObject({ url: archived.archiveUrl });
  });
});

describe('failure recovery', () => {
  test('PDF generation failure marks the row PDF Failed, then recovery succeeds', async () => {
    const { statusLabels, offerLabels } = config.load().monday;
    installRoutes(axios, backend, { pdfGenFails: true });
    const msg = { boardId: '111', itemId: '555' };
    await expect(generatePDF.processGenerate(makeContext(), msg)).rejects.toThrow(/unavailable/);
    expect(backend.rows[555].written.status).toEqual({ label: statusLabels.pdfFailed });
    expect(backend.rows[555].written[config.load().monday.columns.offerStatus]).toEqual({ label: offerLabels.failed });

    // Adobe comes back -> the queue redelivery succeeds and parks at the HR gate
    installRoutes(axios, backend);
    const retryCtx = makeContext();
    await generatePDF.processGenerate(retryCtx, msg);
    expect(backend.rows[555].written.status).toEqual({ label: statusLabels.docsInProgress });
    expect(backend.rows[555].written[config.load().monday.columns.offerStatus]).toEqual({ label: offerLabels.ready });
    expect(backend.rows[555].written.link_pdf.url).toContain('pdf-temp');
    expect(retryCtx.bindings.signQueue).toBeUndefined(); // signing waits for HR approval
  });

  test('Sign failure marks the row Sign Failed, then recovery succeeds', async () => {
    const { statusLabels, offerLabels } = config.load().monday;
    // Generate the offer, then HR approves -> sign message ({boardId, itemId})
    await generatePDF.processGenerate(makeContext(), { boardId: '111', itemId: '555' });
    const approval = await mondayWebhook.handleWebhook(
      offerStatusEvent(makeMondayJwt('test-signing-secret'), offerLabels.approved, config.load().monday.columns.offerStatus)
    );
    expect(approval.status).toBe(200);
    const signMsg = approval.signMessage;
    expect(signMsg).toMatchObject({ boardId: '111', itemId: '555' });

    installRoutes(axios, backend, { signFails: true });
    await expect(sendForSign(makeContext(), signMsg)).rejects.toThrow(/unavailable/);
    expect(backend.rows[555].written.status).toEqual({ label: statusLabels.signFailed });
    expect(backend.rows[555].written[config.load().monday.columns.offerStatus]).toEqual({ label: offerLabels.failed });

    installRoutes(axios, backend);
    const retryCtx = makeContext();
    await sendForSign(retryCtx, signMsg);
    expect(retryCtx.res.body.agreementId).toBe('AGR-42');
    expect(backend.rows[555].written.status).toEqual({ label: statusLabels.outForSignature });
    expect(backend.rows[555].written[config.load().monday.columns.offerStatus]).toEqual({ label: offerLabels.sent });
  });

  test('archive failure for unknown agreement throws and archives nothing', async () => {
    await expect(
      archiveToBlob.processArchive({ agreementId: 'AGR-UNKNOWN' })
    ).rejects.toThrow(/No Monday item found/);
    const archiveKeys = [...storageMock.__store.keys()].filter((k) => k.includes('|pdf-archive|'));
    expect(archiveKeys).toHaveLength(0);
    expect(backend.rows[555].written.status).toBeUndefined();
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
