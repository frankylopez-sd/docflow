'use strict';
/**
 * atsSync tests: ATS candidate flips to "Hired (Closed)" -> an Onboarding item
 * is created (or an exact-name existing hire is linked) with the ATS row wired
 * through the board-relation column, plus audit updates on BOTH items.
 * Fully offline against the fake Monday backend (ATS candidate row 701).
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const { makeBackend, installRoutes, makeMondayJwt } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const monday = require('../lib/monday');
const atsSync = require('../functions/atsSync');

const RPH_BOARD = '18404160361';
const CLERK_BOARD = '18395962118';

let backend;

function makeContext() {
  return { bindings: {}, bindingData: {}, res: null };
}

/** Signed ATS status-change event (defaults: hired label on the RPH board). */
function hiredEvent(overrides = {}) {
  const ats = config.load().monday.atsIntake;
  const {
    pulseId = 701,
    boardId = RPH_BOARD,
    columnId = ats.statusColumn,
    label = ats.hiredLabel,
    type = 'update_column_value',
  } = overrides;
  return {
    headers: { authorization: makeMondayJwt('test-signing-secret') },
    body: {
      event: { type, boardId, pulseId, columnId, value: { label: { text: label } } },
    },
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

describe('atsSync', () => {
  test('echoes the Monday challenge handshake', async () => {
    const ctx = makeContext();
    await atsSync(ctx, { headers: {}, body: { challenge: 'ats-xyz' } });
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.challenge).toBe('ats-xyz');
  });

  test('rejects unsigned requests with 401', async () => {
    const ctx = makeContext();
    const req = hiredEvent();
    req.headers = {};
    await atsSync(ctx, req);
    expect(ctx.res.status).toBe(401);
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });

  test('ignores status changes to any non-hired label with 200', async () => {
    const ctx = makeContext();
    await atsSync(ctx, hiredEvent({ label: 'Interviewing' }));
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.ignored).toBe(true);
    expect(ctx.res.body.reason).toContain('status is not');
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });

  test('ignores hired events from unknown boards with 200', async () => {
    const ctx = makeContext();
    await atsSync(ctx, hiredEvent({ boardId: '99999' }));
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.ignored).toBe(true);
    expect(ctx.res.body.reason).toBe('not an ATS status event');
    expect(backend.archiveItems).toHaveLength(0);
  });

  test('ignores non-status events (wrong type / wrong column) with 200', async () => {
    const wrongType = makeContext();
    await atsSync(wrongType, hiredEvent({ type: 'create_pulse' }));
    expect(wrongType.res.status).toBe(200);
    expect(wrongType.res.body.ignored).toBe(true);

    const wrongColumn = makeContext();
    await atsSync(wrongColumn, hiredEvent({ columnId: 'color_other' }));
    expect(wrongColumn.res.status).toBe(200);
    expect(wrongColumn.res.body.ignored).toBe(true);
    expect(backend.archiveItems).toHaveLength(0);
  });

  test('hired candidate with no existing hire -> creates + links a new Onboarding item', async () => {
    const cfg = config.load();
    const boardCfg = cfg.monday.atsIntake.boards[RPH_BOARD];
    const ctx = makeContext();
    await atsSync(ctx, hiredEvent());
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body).toMatchObject({ imported: true, candidateName: 'Rita Pharmacist', source: boardCfg.name });
    expect(ctx.res.body.deduped).toBeUndefined();

    // create_item ran with the ATS relation + role preset labels
    expect(backend.archiveItems).toHaveLength(1);
    const created = backend.archiveItems[0];
    expect(created.name).toBe('Rita Pharmacist');
    expect(created.id).toBe(ctx.res.body.onboardingItemId);
    expect(created.columns[boardCfg.relationColumn]).toEqual({ item_ids: [701] });
    expect(created.columns[cfg.monday.columns.jobTitle]).toEqual({ labels: [boardCfg.jobTitle] });
    expect(created.columns[cfg.monday.columns.payClass]).toEqual({ labels: [boardCfg.payClass] });

    // Audit updates posted on BOTH sides
    const onboardingUpdates = backend.updates.filter((u) => u.itemId === created.id);
    expect(onboardingUpdates).toHaveLength(1);
    expect(onboardingUpdates[0].body).toContain(`Imported from ${boardCfg.name}`);
    expect(onboardingUpdates[0].body).toContain(cfg.monday.atsIntake.hiredLabel);
    const atsUpdates = backend.updates.filter((u) => u.itemId === '701');
    expect(atsUpdates).toHaveLength(1);
    expect(atsUpdates[0].body).toContain('Onboarding started for Rita Pharmacist');
  });

  test('Clerk-ATS board presets the Clerk role on the created hire', async () => {
    const cfg = config.load();
    const boardCfg = cfg.monday.atsIntake.boards[CLERK_BOARD];
    const ctx = makeContext();
    await atsSync(ctx, hiredEvent({ boardId: CLERK_BOARD }));
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body).toMatchObject({ imported: true, source: boardCfg.name });
    expect(backend.archiveItems).toHaveLength(1);
    const created = backend.archiveItems[0];
    expect(created.columns[boardCfg.relationColumn]).toEqual({ item_ids: [701] });
    expect(created.columns[cfg.monday.columns.jobTitle]).toEqual({ labels: [boardCfg.jobTitle] });
    expect(created.columns[cfg.monday.columns.payClass]).toEqual({ labels: [boardCfg.payClass] });
  });

  test('exact-name existing hire is linked instead of duplicated', async () => {
    const cfg = config.load();
    const boardCfg = cfg.monday.atsIntake.boards[RPH_BOARD];
    backend.rows[555].name = 'Rita Pharmacist'; // hire already exists on the Onboarding board

    const ctx = makeContext();
    await atsSync(ctx, hiredEvent());
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body).toMatchObject({ imported: true, onboardingItemId: '555' });
    expect(ctx.res.body.deduped).toBeUndefined();

    // No duplicate item created; the relation + role labels landed on 555
    expect(backend.archiveItems).toHaveLength(0);
    const written = backend.rows[555].written;
    expect(written[boardCfg.relationColumn]).toEqual({ item_ids: [701] });
    expect(written[cfg.monday.columns.jobTitle]).toEqual({ labels: [boardCfg.jobTitle] });
    expect(written[cfg.monday.columns.payClass]).toEqual({ labels: [boardCfg.payClass] });

    // Audit updates still posted on BOTH items
    expect(backend.updates.filter((u) => u.itemId === '555')).toHaveLength(1);
    expect(backend.updates.filter((u) => u.itemId === '701')).toHaveLength(1);
  });

  test('namesake with a DIFFERENT email gets its own card, not the other person\'s', async () => {
    const cfg = config.load();
    // An existing hire shares the name but belongs to someone else entirely.
    backend.rows[555].name = 'Rita Pharmacist';
    backend.rows[555].written[cfg.monday.formSync.targetColumns.personalEmail] = {
      email: 'a.different.rita@gmail.com', text: 'a.different.rita@gmail.com',
    };
    // The ATS candidate's own email (column id 'email' on the live ATS boards)
    backend.rows[701].written.email = { email: 'rita.pharmacist@gmail.com', text: 'rita.pharmacist@gmail.com' };

    const ctx = makeContext();
    await atsSync(ctx, hiredEvent()); // ATS Rita's email is rita.pharmacist@gmail.com

    // A NEW card was created — the other Rita's record was left alone.
    expect(ctx.res.body.onboardingItemId).not.toBe('555');
    expect(backend.rows[555].written[cfg.monday.columns.jobTitle]).toBeUndefined();
    // And the new card carries a loud warning about the name collision.
    const warned = backend.updates.find((u) => u.body.includes('also named'));
    expect(warned).toBeDefined();
    expect(warned.body).toContain('Personal Email');
  });

  test('replayed hired event is deduped via the relation column (linkedPulseIds)', async () => {
    const boardCfg = config.load().monday.atsIntake.boards[RPH_BOARD];
    backend.rows[555].name = 'Rita Pharmacist';
    backend.rows[555].written[boardCfg.relationColumn] = { linkedPulseIds: [{ linkedPulseId: 701 }] };

    const ctx = makeContext();
    await atsSync(ctx, hiredEvent());
    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body).toMatchObject({ imported: true, deduped: true, onboardingItemId: '555' });
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates).toHaveLength(0); // no second audit trail
  });

  test('dedupe also recognizes the item_ids relation value shape', async () => {
    const boardCfg = config.load().monday.atsIntake.boards[RPH_BOARD];
    backend.rows[555].name = 'Rita Pharmacist';
    backend.rows[555].written[boardCfg.relationColumn] = { item_ids: [701] };

    const ctx = makeContext();
    await atsSync(ctx, hiredEvent());
    expect(ctx.res.body).toMatchObject({ imported: true, deduped: true, onboardingItemId: '555' });
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });

  test('full replay: create once, second delivery dedupes against the created item', async () => {
    backend.rows[555].name = 'Rita Pharmacist'; // link-existing path writes the relation
    await atsSync(makeContext(), hiredEvent());
    const ctx = makeContext();
    await atsSync(ctx, hiredEvent()); // same webhook redelivered
    expect(ctx.res.body).toMatchObject({ imported: true, deduped: true, onboardingItemId: '555' });
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates.filter((u) => u.itemId === '555')).toHaveLength(1); // still just one
  });

  test('survives a malformed request with 500', async () => {
    const ctx = makeContext();
    await atsSync(ctx, null);
    expect(ctx.res.status).toBe(500);
    expect(ctx.res.body.error).toBe('ATS sync failed');
  });
});
