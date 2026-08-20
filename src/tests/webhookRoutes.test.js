'use strict';
/**
 * mondayWebhook routing tests: welcome blast on item creation, denial
 * documentation, and strict rejection of unrecognized events.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const { makeBackend, installRoutes, makeMondayJwt } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const monday = require('../lib/monday');
const mondayWebhook = require('../functions/mondayWebhook');

let backend;

function makeContext() {
  return { bindings: {}, bindingData: {}, res: null };
}

function eventReq(event) {
  return { headers: { authorization: makeMondayJwt('test-signing-secret') }, body: { event } };
}

beforeEach(() => {
  jest.clearAllMocks();
  storageMock.__reset();
  config.reset();
  monday._resetState();
  backend = makeBackend();
  installRoutes(axios, backend);
});

describe('mondayWebhook routing', () => {
  test('item creation posts the queued-welcome note (two-email flow), queues nothing', async () => {
    const ctx = makeContext();
    await mondayWebhook(ctx, eventReq({ type: 'create_pulse', boardId: '111', pulseId: 555, pulseName: 'Jane Doe' }));
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.welcomed).toBe(true);
    expect(ctx.bindings.generateQueue).toBeUndefined();
    expect(ctx.bindings.signQueue).toBeUndefined();

    const updates = backend.updates.filter((u) => u.itemId === '555');
    expect(updates).toHaveLength(1);
    expect(updates[0].body).toContain('is on the board');
    expect(updates[0].body).toContain('Jane Doe');

    // The welcome route now also moves the onboarding status to step ②.
    expect(backend.rows[555].written.status).toEqual({ label: config.load().monday.statusLabels.awaitingInfo });
  });

  test('auto-generate: hire-field edit with all required fields queues a build', async () => {
    const ctx = makeContext();
    const res = await mondayWebhook.handleWebhook(eventReq({
      type: 'update_column_value', boardId: '111', pulseId: 555,
      columnId: 'numeric_mm65mx3m', value: { value: '68000' },
    }));
    expect(res.status).toBe(200);
    expect(res.body.auto).toBe(true);
    expect(res.queueMessage).toMatchObject({ boardId: '111', itemId: '555', eventType: 'auto-field-complete' });
    const updates = backend.updates.filter((u) => u.itemId === '555');
    expect(updates[updates.length - 1].body).toMatch(/Building the offer letter|Rebuilding the letter/);
  });

  test('auto-generate: field edit while out for signature narrates and queues nothing', async () => {
    const cfg = config.load();
    backend.rows[555].written.status = { label: cfg.monday.statusLabels.outForSignature };
    const res = await mondayWebhook.handleWebhook(eventReq({
      type: 'update_column_value', boardId: '111', pulseId: 555,
      columnId: 'numeric_mm65mx3m', value: { value: '68000' },
    }));
    expect(res.queueMessage).toBeNull();
    const updates = backend.updates.filter((u) => u.itemId === '555');
    expect(updates[updates.length - 1].body).toContain('out for signature');
  });

  test('auto-generate: non-hire column edits stay ignored', async () => {
    const res = await mondayWebhook.handleWebhook(eventReq({
      type: 'update_column_value', boardId: '111', pulseId: 555,
      columnId: 'text_template', value: { value: 'x' },
    }));
    expect(res.body.ignored).toBe(true);
    expect(res.queueMessage).toBeNull();
  });

  test('offer status "Denied" is documented and queues nothing', async () => {
    const cfg = config.load();
    const ctx = makeContext();
    await mondayWebhook(ctx, eventReq({
      type: 'update_column_value',
      boardId: '111',
      pulseId: 555,
      columnId: cfg.monday.columns.offerStatus,
      value: { label: { text: cfg.monday.offerLabels.denied } },
    }));
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.documented).toBe(true);
    expect(ctx.bindings.signQueue).toBeUndefined();
    const updates = backend.updates.filter((u) => u.itemId === '555');
    expect(updates).toHaveLength(1);
    expect(updates[0].body).toContain('Denied');
  });

  test('unrecognized event types are acknowledged but never queue work', async () => {
    const ctx = makeContext();
    await mondayWebhook(ctx, eventReq({ type: 'some_future_event', boardId: '111', pulseId: 555 }));
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.ignored).toBe(true);
    expect(ctx.bindings.generateQueue).toBeUndefined();
    expect(ctx.bindings.signQueue).toBeUndefined();
  });
});
