'use strict';
/**
 * formSync tests: welcome-form submission -> Onboarding hire record sync.
 * Fully offline against the fake Monday backend.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const { makeBackend, installRoutes, makeMondayJwt } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const monday = require('../lib/monday');
const formSync = require('../functions/formSync');

let backend;

function makeContext() {
  return { bindings: {}, bindingData: {}, res: null };
}

function submissionEvent(pulseId = 601, boardId = '18427180595') {
  return {
    headers: { authorization: makeMondayJwt('test-signing-secret') },
    body: { event: { type: 'create_pulse', pulseId, boardId } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  storageMock.__reset();
  config.reset();
  monday._resetState();
  backend = makeBackend();
  installRoutes(axios, backend);
});

describe('formSync', () => {
  test('echoes the Monday challenge handshake', async () => {
    const ctx = makeContext();
    await formSync(ctx, { headers: {}, body: { challenge: 'xyz' } });
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.challenge).toBe('xyz');
  });

  test('syncs a submission onto the matching hire record', async () => {
    const ctx = makeContext();
    await formSync(ctx, submissionEvent());
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.synced).toBe(true);
    expect(ctx.res.body.hireId).toBe('555');

    const written = backend.rows[555].written;
    expect(written.text_mm6570q4).toBe('Janie'); // preferred first name
    expect(written.email_mm6cr1gj).toEqual({ email: 'jane.personal@gmail.com', text: 'jane.personal@gmail.com' });
    expect(written.phone_mm6cxwa3).toEqual({ phone: '15550102233', countryShortName: 'US' });
    expect(written.location_mm6cmyg6).toMatchObject({ address: expect.stringContaining('Salt Lake City') });
    expect(written.dropdown_mm669dw4).toEqual({ labels: ['UT'] });
    expect(written.dropdown_mm66x62b).toEqual({ labels: ['MST - Mountain Standard Time'] }); // prefix-mapped
    expect(written.date_mm6cspg8).toEqual({ date: '2026-09-15' });
    expect(written.text_mm6cv6se).toBe('John Doe');
    expect(written.phone_mm6ca1xn).toEqual({ phone: '15550109988', countryShortName: 'US' });

    // Visible trail posted on the hire, including candidate notes
    const hireUpdates = backend.updates.filter((u) => u.itemId === '555');
    expect(hireUpdates).toHaveLength(1);
    expect(hireUpdates[0].body).toContain('Welcome form received');
    expect(hireUpdates[0].body).toContain('Excited to start!');
  });

  test('flags a submission with no matching hire instead of guessing', async () => {
    backend.rows[601].name = 'Totally Unknown Person';
    const ctx = makeContext();
    await formSync(ctx, submissionEvent());
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.synced).toBe(false);
    expect(ctx.res.body.reason).toBe('no matching hire');

    // Warning update lands on the FORM item, nothing written to the hire
    const formUpdates = backend.updates.filter((u) => u.itemId === '601');
    expect(formUpdates).toHaveLength(1);
    expect(formUpdates[0].body).toContain('no matching hire');
    expect(backend.rows[555].written.email_mm6cr1gj).toBeUndefined();
  });

  test('ignores non-creation events with 200', async () => {
    const ctx = makeContext();
    const req = submissionEvent();
    req.body.event.type = 'update_column_value';
    await formSync(ctx, req);
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.ignored).toBe(true);
  });

  test('rejects unsigned requests with 401', async () => {
    const ctx = makeContext();
    await formSync(ctx, { headers: {}, body: { event: { type: 'create_pulse', pulseId: 601, boardId: '18427180595' } } });
    expect(ctx.res.status).toBe(401);
  });

  test('ignores creation events from any other board', async () => {
    const ctx = makeContext();
    await formSync(ctx, submissionEvent(555, '111')); // Onboarding board, not the form board
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.ignored).toBe(true);
  });

  test('replayed submission is deduped, no second update posted', async () => {
    await formSync(makeContext(), submissionEvent());
    const ctx = makeContext();
    await formSync(ctx, submissionEvent()); // same submission redelivered
    expect(ctx.res.body).toMatchObject({ synced: true, deduped: true });
    expect(backend.updates.filter((u) => u.itemId === '555')).toHaveLength(1);
  });
});
