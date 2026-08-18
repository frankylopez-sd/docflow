'use strict';
/**
 * Function entrypoint + ops-surface tests: Azure Function wrappers (context
 * bindings, HTTP responses), signPoller fallback, logger, and the remaining
 * adobe/blob auth paths. Fully offline.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());
jest.mock('@azure/identity', () => ({ DefaultAzureCredential: class DefaultAzureCredential {} }));

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const {
  SIGNED_BYTES, makeBackend, installRoutes, makeMondayJwt, checkboxEvent,
} = require('./helpers/fakeEnv');

const config = require('../lib/config');
const logger = require('../lib/logger');
const adobe = require('../lib/adobe');
const monday = require('../lib/monday');
const blob = require('../lib/blob');

const mondayWebhook = require('../functions/mondayWebhook');
const generatePDF = require('../functions/generatePDF');
const sendForSign = require('../functions/sendForSign');
const adobeWebhook = require('../functions/adobeWebhook');
const downloadSigned = require('../functions/downloadSigned');
const archiveToBlob = require('../functions/archiveToBlob');
const updateMonday = require('../functions/updateMonday');
const signPoller = require('../functions/signPoller');
const cleanup = require('../functions/cleanup');
const health = require('../functions/health');

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

describe('Azure Function entrypoints', () => {
  test('health returns 200 with ok status', async () => {
    const ctx = makeContext();
    await health(ctx);
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.status).toBe('ok');
    expect(new Date(ctx.res.body.timestamp).getTime()).not.toBeNaN();
  });

  test('mondayWebhook entry enqueues to docflow-generate and returns 200', async () => {
    const ctx = makeContext();
    await mondayWebhook(ctx, checkboxEvent(makeMondayJwt('test-signing-secret')));
    expect(ctx.res.status).toBe(200);
    const queued = JSON.parse(ctx.bindings.generateQueue);
    expect(queued).toMatchObject({ boardId: '111', itemId: '555' });
  });

  test('mondayWebhook entry survives a malformed request with 500', async () => {
    const ctx = makeContext();
    await mondayWebhook(ctx, null);
    expect(ctx.res.status).toBe(500);
  });

  test('generatePDF entry hydrates hire data from Monday and enqueues signing', async () => {
    const ctx = makeContext();
    // Webhook-shaped queue message: only {boardId, itemId} — the rest is
    // hydrated from the Monday row (Monday is the database of record).
    await generatePDF(ctx, { boardId: '111', itemId: '555' });
    const next = ctx.bindings.signQueue;
    expect(next.pdfUrl).toContain('pdf-temp');
    expect(next).toMatchObject({
      boardId: '111',
      itemId: '555',
      firstName: 'Jane',
      lastName: 'Doe',
      workEmail: 'jane@medwatchers.com',
    });
    expect(backend.rows[555].written.status).toEqual({ label: 'Documentation Generating' });
  });

  test('sendForSign entry processes the sign queue message', async () => {
    const genCtx = makeContext();
    await generatePDF.processGenerate(genCtx, { boardId: '111', itemId: '555' });
    const ctx = makeContext();
    await sendForSign(ctx, genCtx.bindings.signQueue);
    expect(backend.rows[555].written.status).toEqual({ label: 'Sent for Signature' });
    expect(backend.serialize(backend.rows[555].written.text_agreement)).toBe('AGR-42');
  });

  test('adobeWebhook entry enqueues archive work and echoes client id', async () => {
    const ctx = makeContext();
    await adobeWebhook(ctx, {
      method: 'POST',
      headers: { 'x-adobesign-clientid': 'test-client-id' },
      body: { event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'AGR-42', status: 'SIGNED' } },
    });
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.headers['X-AdobeSign-ClientId']).toBe('test-client-id');
    expect(JSON.parse(ctx.bindings.archiveQueue).agreementId).toBe('AGR-42');
  });

  test('adobeWebhook entry survives a malformed request with 500', async () => {
    const ctx = makeContext();
    await adobeWebhook(ctx, null);
    expect(ctx.res.status).toBe(500);
  });

  test('archiveToBlob entry archives from an agreement-only queue message', async () => {
    const genCtx = makeContext();
    await generatePDF.processGenerate(genCtx, { boardId: '111', itemId: '555' });
    await sendForSign(makeContext(), genCtx.bindings.signQueue);
    const ctx = makeContext();
    // Adobe webhook messages carry only the agreementId — archiveToBlob must
    // resolve the Monday item itself.
    await archiveToBlob(ctx, { agreementId: 'AGR-42' });
    expect(backend.rows[555].written.status).toEqual({ label: 'Onboarding Complete' });
    expect(backend.rows[555].written.link_signed).toMatchObject({
      url: expect.stringContaining('pdf-archive'),
    });
    const archiveKey = [...storageMock.__store.keys()].find((k) => k.includes('|pdf-archive|'));
    expect(archiveKey).toBeDefined();
  });

  test('cleanup entry runs with a past-due timer', async () => {
    const ctx = makeContext();
    await cleanup(ctx, { isPastDue: true });
    // no temp files -> nothing deleted, no errors thrown
  });
});

describe('ops endpoints', () => {
  test('downloadSigned HTTP returns the signed PDF bytes', async () => {
    const ctx = makeContext();
    ctx.bindingData.agreementId = 'AGR-42';
    await downloadSigned(ctx, { query: {} });
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.headers['Content-Type']).toBe('application/pdf');
    expect(Buffer.compare(ctx.res.body, SIGNED_BYTES)).toBe(0);
  });

  test('downloadSigned HTTP returns 502 without an agreementId', async () => {
    const ctx = makeContext();
    await downloadSigned(ctx, { query: {} });
    expect(ctx.res.status).toBe(502);
  });

  test('updateMonday HTTP validates input (400)', async () => {
    const ctx = makeContext();
    await updateMonday(ctx, { body: { boardId: '111' } });
    expect(ctx.res.status).toBe(400);
  });

  test('updateMonday HTTP writes a status (200)', async () => {
    const ctx = makeContext();
    await updateMonday(ctx, { body: { boardId: '111', itemId: '555', values: { status: 'Completed' } } });
    expect(ctx.res.status).toBe(200);
    expect(backend.rows[555].written.status).toEqual({ label: 'Completed' });
  });

  test('updateMonday HTTP surfaces write failures (502)', async () => {
    const ctx = makeContext();
    await updateMonday(ctx, { body: { boardId: '111', itemId: '999', values: { status: 'X' } } });
    expect(ctx.res.status).toBe(502);
  });
});

describe('signPoller fallback', () => {
  beforeEach(() => {
    backend.rows[555].written.status = { label: 'Sent for Sign' };
    backend.rows[555].written.text_agreement = 'AGR-42';
  });

  test('finds pending items and reports completed agreements', async () => {
    const completed = await signPoller.pollPendingAgreements();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ agreementId: 'AGR-42', itemId: '555', source: 'signPoller' });
    expect(completed[0].signers).toHaveLength(2);
  });

  test('agreements still out for signature are not enqueued', async () => {
    installRoutes(axios, backend, { agreementStatus: 'OUT_FOR_SIGNATURE' });
    const completed = await signPoller.pollPendingAgreements();
    expect(completed).toHaveLength(0);
  });

  test('timer entry pushes completed agreements onto the archive queue', async () => {
    const ctx = makeContext();
    await signPoller(ctx, { isPastDue: false });
    expect(Array.isArray(ctx.bindings.archiveQueue)).toBe(true);
    expect(JSON.parse(ctx.bindings.archiveQueue[0]).agreementId).toBe('AGR-42');
  });
});

describe('mondayWebhook signature edge cases', () => {
  const { validateSignature, WebhookError, ErrorTypes } = require('../lib/webhookErrors');

  test('accepts anything when no signing secret is configured', () => {
    expect(validateSignature('whatever', null).valid).toBe(true);
  });

  test('rejects a missing Authorization header with a 401 WebhookError', () => {
    let err;
    try { validateSignature(null, 'secret'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WebhookError);
    expect(err.type).toBe(ErrorTypes.SIGNATURE_MISSING);
    expect(err.getResponse().status).toBe(401);
  });

  test('rejects an expired token with a 401 WebhookError', () => {
    const b64url = (s) => Buffer.from(s).toString('base64url');
    const crypto = require('crypto');
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 }));
    const sig = crypto.createHmac('sha256', 'test-signing-secret').update(`${header}.${payload}`).digest('base64url');
    let err;
    try { validateSignature(`${header}.${payload}.${sig}`, 'test-signing-secret'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WebhookError);
    expect(err.type).toBe(ErrorTypes.TOKEN_EXPIRED);
    expect(err.getResponse().status).toBe(401);
  });

  test('ignores events without an item id', async () => {
    const result = await mondayWebhook.handleWebhook({
      headers: { authorization: makeMondayJwt('test-signing-secret') },
      body: { event: { type: 'update_column_value' } },
    });
    expect(result.status).toBe(200);
    expect(result.queueMessage).toBeNull();
  });
});

describe('adobe: webhook registration, status, sign OAuth', () => {
  test('ensureWebhook registers and returns the webhook id', async () => {
    await expect(adobe.ensureWebhook()).resolves.toBe('WH-1');
  });

  test('ensureWebhook swallows duplicate (409) registrations', async () => {
    installRoutes(axios, backend, { webhookConflict: true });
    await expect(adobe.ensureWebhook()).resolves.toBeNull();
  });

  test('ensureWebhook requires a configured URL', async () => {
    const saved = process.env.ADOBE_WEBHOOK_URL;
    delete process.env.ADOBE_WEBHOOK_URL;
    config.reset();
    try {
      await expect(adobe.ensureWebhook()).rejects.toThrow(/no webhook URL/);
    } finally {
      process.env.ADOBE_WEBHOOK_URL = saved;
      config.reset();
    }
  });

  test('getAgreementStatus maps signer progress', async () => {
    const status = await adobe.getAgreementStatus('AGR-42');
    expect(status.status).toBe('SIGNED');
    expect(status.signers).toEqual([
      { order: 1, status: 'COMPLETED', emails: ['hr@medwatchers.com'] },
      { order: 2, status: 'COMPLETED', emails: ['jane@medwatchers.com'] },
    ]);
  });

  test('sign token falls back to the OAuth refresh flow', async () => {
    const savedKey = process.env.ADOBE_SIGN_INTEGRATION_KEY;
    delete process.env.ADOBE_SIGN_INTEGRATION_KEY;
    process.env.ADOBE_SIGN_REFRESH_TOKEN = 'refresh-token-1';
    config.reset();
    adobe._resetState();
    try {
      await expect(adobe.getToken('sign')).resolves.toBe('sign-refreshed-token');
    } finally {
      process.env.ADOBE_SIGN_INTEGRATION_KEY = savedKey;
      delete process.env.ADOBE_SIGN_REFRESH_TOKEN;
      config.reset();
      adobe._resetState();
    }
  });

  test('sign token errors clearly when no auth is configured', async () => {
    const savedKey = process.env.ADOBE_SIGN_INTEGRATION_KEY;
    delete process.env.ADOBE_SIGN_INTEGRATION_KEY;
    config.reset();
    adobe._resetState();
    try {
      await expect(adobe.getToken('sign')).rejects.toThrow(/auth not configured/);
    } finally {
      process.env.ADOBE_SIGN_INTEGRATION_KEY = savedKey;
      config.reset();
      adobe._resetState();
    }
  });
});

describe('generatePDF merge-data contract', () => {
  // Template resolution moved into adobe.generateOfferLetter (env template id);
  // data mapping is now the mergeData construction in processGenerate, guarded
  // by adobe.extractMergeFields against the template schema.

  const FULL_HIRE_MSG = {
    boardId: '111',
    itemId: '555',
    firstName: 'Jane',
    lastName: 'Doe',
    workEmail: 'jane@medwatchers.com',
    adpJobTitle: 'Pharmacy Tech',
    adpDepartment: 'Pharmacy',
    supervisor: 'Mayra R',
    payRate: 65000,
    payFrequency: 'Annual',
    startDate: '2026-09-01',
  };

  test('extractMergeFields throws for missing required merge fields', () => {
    const schema = ['firstName', 'lastName', 'jobTitle', 'department'];
    let err;
    try { adobe.extractMergeFields(schema, { firstName: 'Jane', department: 'Pharmacy' }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Merge data missing required fields/);
    expect(err.code).toBe('MISSING_MERGE_FIELDS');
    expect(err.missing).toEqual(['lastName', 'jobTitle']);
  });

  test('extractMergeFields passes with complete data', () => {
    const schema = ['firstName', 'lastName'];
    expect(adobe.extractMergeFields(schema, { firstName: 'Jane', lastName: 'Doe' }))
      .toEqual({ fields: ['firstName', 'lastName'], missing: [] });
  });

  test('processGenerate maps queue hire fields onto the Adobe merge data', async () => {
    const spy = jest.spyOn(adobe, 'generateOfferLetter').mockResolvedValue(Buffer.from('%PDF spy'));
    try {
      await generatePDF.processGenerate(makeContext(), { ...FULL_HIRE_MSG });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        firstName: 'Jane',
        lastName: 'Doe',
        jobTitle: 'Pharmacy Tech',        // adpJobTitle
        department: 'Pharmacy',           // adpDepartment
        email: 'jane@medwatchers.com',    // workEmail
        supervisor: 'Mayra R',
        compensation: 65000,              // payRate
        frequency: 'Annual',              // payFrequency
        startDate: '2026-09-01',
      }));
    } finally {
      spy.mockRestore();
    }
  });

  test('processGenerate defaults startDate to today when absent', async () => {
    const spy = jest.spyOn(adobe, 'generateOfferLetter').mockResolvedValue(Buffer.from('%PDF spy'));
    try {
      const msg = { ...FULL_HIRE_MSG };
      delete msg.startDate;
      await generatePDF.processGenerate(makeContext(), msg);
      const mergeData = spy.mock.calls[0][0];
      expect(mergeData.startDate).toBe(new Date().toISOString().split('T')[0]);
      expect(mergeData.generatedDate).toBe(new Date().toISOString().split('T')[0]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('blob managed-identity path', () => {
  test('uploads and mints a user-delegation SAS without an account key', async () => {
    const savedKey = process.env.STORAGE_ACCOUNT_KEY;
    delete process.env.STORAGE_ACCOUNT_KEY;
    config.reset();
    blob._resetState();
    try {
      const data = Buffer.from('%PDF mi-path');
      const result = await blob.uploadPDF('pdf-temp', 'mi.pdf', data);
      expect(result.sasUrl).toContain('se=');
      expect(Buffer.compare(storageMock.__store.get('teststore|pdf-temp|mi.pdf').data, data)).toBe(0);
    } finally {
      process.env.STORAGE_ACCOUNT_KEY = savedKey;
      config.reset();
      blob._resetState();
    }
  });
});

describe('logger', () => {
  let stdoutSpy;
  let stderrSpy;

  beforeEach(() => {
    process.env.DOCFLOW_LOG_SILENT = 'false';
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env.DOCFLOW_LOG_SILENT = 'true';
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('info/warn/event/metric emit structured JSON to stdout', () => {
    logger.info('hello', { a: 1 });
    logger.warn('careful');
    logger.event('thing-happened', { id: 'x' });
    logger.metric('latency', 42);
    expect(stdoutSpy).toHaveBeenCalledTimes(4);
    const first = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(first.level).toBe('info');
    expect(first.message).toBe('hello');
    expect(first.props.a).toBe(1);
  });

  test('error goes to stderr with stack and http status', () => {
    const err = new Error('boom');
    err.response = { status: 503 };
    logger.error('it-broke', err, { itemId: '555' });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(stderrSpy.mock.calls[0][0]);
    expect(line.level).toBe('error');
    expect(line.props.error).toBe('boom');
    expect(line.props.httpStatus).toBe(503);
    expect(line.props.itemId).toBe('555');
  });

  test('flush is a safe no-op without App Insights', () => {
    expect(() => logger.flush()).not.toThrow();
  });
});

describe('config', () => {
  test('throws listing every missing required setting', () => {
    const saved = { ...process.env };
    delete process.env.MONDAY_API_TOKEN;
    delete process.env.ADOBE_CLIENT_ID;
    config.reset();
    try {
      expect(() => config.load()).toThrow(/ADOBE_CLIENT_ID.*MONDAY_API_TOKEN|MONDAY_API_TOKEN.*ADOBE_CLIENT_ID/);
    } finally {
      process.env.MONDAY_API_TOKEN = saved.MONDAY_API_TOKEN;
      process.env.ADOBE_CLIENT_ID = saved.ADOBE_CLIENT_ID;
      config.reset();
    }
  });

  test('decodes the base64 ADOBE_JWT_FILE when provided', () => {
    process.env.ADOBE_JWT_FILE = Buffer.from('{"jwt":"payload"}').toString('base64');
    config.reset();
    try {
      expect(config.load().adobe.jwt).toBe('{"jwt":"payload"}');
    } finally {
      delete process.env.ADOBE_JWT_FILE;
      config.reset();
    }
  });
});
