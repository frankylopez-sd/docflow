'use strict';
/**
 * reconcileIntake tests: the 10-minute self-healing sweep that imports hired
 * ATS candidates whose webhook never arrived (mid-deploy bounce). Fully
 * offline against the fake Monday backend (ATS candidate row 701).
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const { makeBackend, installRoutes } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const monday = require('../lib/monday');
const reconcileIntake = require('../functions/reconcileIntake');

const RPH_BOARD = '18404160361';

let backend;

beforeEach(() => {
  jest.clearAllMocks();
  storageMock.__reset();
  config.reset();
  monday._resetState();
  backend = makeBackend();
  installRoutes(axios, backend);
  // The sweep finds hired candidates via items_page_by_column_values, which
  // the fake backend matches against WRITTEN column values — mirror row 701's
  // base "Hired (Closed)" status into written so the scan sees it.
  const ats = config.load().monday.atsIntake;
  backend.rows[701].written[ats.statusColumn] = ats.hiredLabel;
});

describe('reconcileIntake', () => {
  test('happy path: missed hire is caught up — imported, linked, and honestly narrated', async () => {
    const cfg = config.load();
    const boardCfg = cfg.monday.atsIntake.boards[RPH_BOARD];

    const summary = await reconcileIntake.reconcileHiredCandidates();
    expect(summary.caughtUp).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.capped).toBe(false);

    // The Onboarding item was created and linked exactly like the webhook path
    expect(backend.archiveItems).toHaveLength(1);
    const created = backend.archiveItems[0];
    expect(created.name).toBe('Rita Pharmacist');
    expect(created.columns[boardCfg.relationColumn]).toEqual({ item_ids: [701] });
    expect(created.columns[cfg.monday.columns.jobTitle]).toEqual({ labels: [boardCfg.jobTitle] });

    // The import comment carries the dedupe needle AND the honest catch-up line
    const onboardingUpdates = backend.updates.filter((u) => u.itemId === created.id);
    expect(onboardingUpdates).toHaveLength(1);
    expect(onboardingUpdates[0].body).toContain(`Imported from ${boardCfg.name}`);
    expect(onboardingUpdates[0].body).toContain('I caught it on my sweep. Nothing lost.');

    // ATS-side audit comment posts too
    const atsUpdates = backend.updates.filter((u) => u.itemId === '701');
    expect(atsUpdates).toHaveLength(1);
    expect(atsUpdates[0].body).toContain('Onboarding started for Rita Pharmacist');
  });

  test('already-linked hire is skipped — nothing created, nothing posted', async () => {
    const boardCfg = config.load().monday.atsIntake.boards[RPH_BOARD];
    backend.rows[555].name = 'Rita Pharmacist';
    backend.rows[555].written[boardCfg.relationColumn] = { linkedPulseIds: [{ linkedPulseId: 701 }] };

    const summary = await reconcileIntake.reconcileHiredCandidates();
    expect(summary.caughtUp).toBe(0);
    expect(summary.alreadyLinked).toBe(1);
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });

  test('one bad item never throws the run — it is logged and counted as failed', async () => {
    // Make the candidate read blow up: remove the row after the scan finds it.
    const readRowSpy = jest.spyOn(monday, 'readRow').mockRejectedValue(new Error('boom'));
    const summary = await reconcileIntake.reconcileHiredCandidates();
    readRowSpy.mockRestore();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.caughtUp).toBe(0);
    expect(backend.archiveItems).toHaveLength(0);
  });

  test('stale hires are history, not missed webhooks — nothing imported', async () => {
    // Row last touched 3 days ago: outside the 2h window (the 2026-08-21
    // incident guard — the first sweep imported 9 pre-DocFlow candidates).
    backend.rows[701].updated_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const summary = await reconcileIntake.reconcileHiredCandidates();
    expect(summary.caughtUp).toBe(0);
    expect(summary.stale).toBe(1);
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });

  test('archived ATS rows are skipped — never re-imported (finding A65)', async () => {
    backend.rows[701].state = 'archived';
    const summary = await reconcileIntake.reconcileHiredCandidates();
    expect(summary.archived).toBe(1);
    expect(summary.caughtUp).toBe(0);
    expect(backend.archiveItems).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });

  test('timer entry point runs the sweep without throwing', async () => {
    await expect(reconcileIntake({ bindings: {} }, { isPastDue: false })).resolves.toBeUndefined();
    expect(backend.archiveItems).toHaveLength(1);
  });
});
