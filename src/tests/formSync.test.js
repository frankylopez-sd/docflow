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
    // 11 digits with a leading 1 -> country code stripped to a clean 10
    expect(written.phone_mm6cxwa3).toEqual({ phone: '5550102233', countryShortName: 'US' });
    expect(written.location_mm6cmyg6).toMatchObject({ address: expect.stringContaining('Salt Lake City') });
    expect(written.dropdown_mm669dw4).toEqual({ labels: ['UT'] });
    expect(written.dropdown_mm66x62b).toEqual({ labels: ['MST - Mountain Standard Time'] }); // prefix-mapped
    expect(written.date_mm6cspg8).toEqual({ date: '2026-09-15' });
    expect(written.text_mm6cv6se).toBe('John Doe');
    expect(written.phone_mm6ca1xn).toEqual({ phone: '5550109988', countryShortName: 'US' });

    // Visible trail posted on the hire, including candidate notes
    const hireUpdates = backend.updates.filter((u) => u.itemId === '555');
    expect(hireUpdates).toHaveLength(1);
    expect(hireUpdates[0].body).toContain('Welcome form received');
    expect(hireUpdates[0].body).toContain('Excited to start!');
    // Everything valid -> the quiet all-clear line, no warning section
    expect(hireUpdates[0].body).toContain('All answers checked out — every field passed validation.');
    expect(hireUpdates[0].body).not.toContain("I couldn't use");
    expect(ctx.res.body.rejected).toBe(0);
  });

  test('invalid mobile phone is skipped, reported, and HR is told to chase', async () => {
    const phoneCol = backend.rows[601].base.find((c) => c.id === 'phonelt6oz6df');
    phoneCol.text = '555-01'; // too few digits to dial
    const ctx = makeContext();
    await formSync(ctx, submissionEvent());
    expect(ctx.res.body.synced).toBe(true);
    expect(ctx.res.body.rejected).toBe(1);

    const written = backend.rows[555].written;
    expect(written.phone_mm6cxwa3).toBeUndefined(); // never write garbage
    expect(written.email_mm6cr1gj).toBeDefined(); // valid fields still sync

    const body = backend.updates.filter((u) => u.itemId === '555')[0].body;
    expect(body).toContain("⚠️ I couldn't use 1 of their answers:");
    expect(body).toContain('mobile phone');
    expect(body).toContain("isn't a 10-digit US phone number");
    expect(body).toContain('Over to you');
    expect(body).toContain('ask Jane Doe for the flagged answers');
    expect(body).not.toContain('All answers checked out');
  });

  test('implausible state is skipped and reported', async () => {
    const stateCol = backend.rows[601].base.find((c) => c.id === 'single_selectpxoczsh');
    stateCol.text = 'Narnia';
    const ctx = makeContext();
    await formSync(ctx, submissionEvent());
    expect(ctx.res.body.rejected).toBe(1);
    expect(backend.rows[555].written.dropdown_mm669dw4).toBeUndefined();
    const body = backend.updates.filter((u) => u.itemId === '555')[0].body;
    expect(body).toContain("\"Narnia\" isn't a US state or territory I recognize");
  });

  test('full state names pass validation too', async () => {
    const stateCol = backend.rows[601].base.find((c) => c.id === 'single_selectpxoczsh');
    stateCol.text = 'Puerto Rico';
    const ctx = makeContext();
    await formSync(ctx, submissionEvent());
    expect(ctx.res.body.rejected).toBe(0);
    expect(backend.rows[555].written.dropdown_mm669dw4).toEqual({ labels: ['Puerto Rico'] });
  });

  test('bad email and past start date are skipped and both reported', async () => {
    backend.rows[601].base.find((c) => c.id === 'emailep1d7e0n').text = 'not-an-email';
    backend.rows[601].base.find((c) => c.id === 'datefyy9ozp8').text = '2020-01-01';
    const ctx = makeContext();
    await formSync(ctx, submissionEvent());
    expect(ctx.res.body.rejected).toBe(2);
    const written = backend.rows[555].written;
    expect(written.email_mm6cr1gj).toBeUndefined();
    expect(written.date_mm6cspg8).toBeUndefined();
    const body = backend.updates.filter((u) => u.itemId === '555')[0].body;
    expect(body).toContain("⚠️ I couldn't use 2 of their answers:");
    expect(body).toContain("doesn't look like an email address");
    expect(body).toContain('start date');
  });

  test('emergency contact missing its phone is flagged incomplete', async () => {
    backend.rows[601].base.find((c) => c.id === 'phoner1drdnlo').text = '';
    const ctx = makeContext();
    await formSync(ctx, submissionEvent());
    const written = backend.rows[555].written;
    expect(written.text_mm6cv6se).toBe('John Doe'); // the name still syncs
    expect(written.phone_mm6ca1xn).toBeUndefined();
    const body = backend.updates.filter((u) => u.itemId === '555')[0].body;
    expect(body).toContain('incomplete emergency contact');
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
