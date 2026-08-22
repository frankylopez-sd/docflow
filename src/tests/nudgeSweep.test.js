'use strict';
/**
 * nudgeSweep tests: the hourly reminder engine. Fully offline against the
 * fake Monday backend (hire row 555 on board 111). Update timestamps are
 * seeded through a monday.listUpdates spy that ALSO sees comments the sweep
 * posts into the backend — so dedupe-on-second-run is exercised for real.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const { makeBackend, installRoutes } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const monday = require('../lib/monday');
const adobe = require('../lib/adobe');
const mailer = require('../lib/mailer');
const nudgeSweep = require('../functions/nudgeSweep');
const { NEEDLES } = nudgeSweep;

const BOARD = '111';
const HOUR = 60 * 60 * 1000;
const now = () => Date.now();

let backend;
let seededUpdates; // itemId -> [{text, createdAt}]
let putCalls;

function item(overrides = {}) {
  return {
    id: '555',
    name: 'Jane Doe',
    updatedAt: now() - 1 * HOUR,
    status: '',
    offerStatus: '',
    ...overrides,
  };
}

function sendMailCalls() {
  return axios.post.mock.calls.filter(([url]) => String(url).includes('/sendMail'));
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  storageMock.__reset();

  process.env.GRAPH_CLIENT_ID = 'test-graph-client';
  process.env.GRAPH_CLIENT_SECRET = 'test-graph-secret';
  process.env.MAIL_SENDER = 'MedwatchersHR@medwatchers.com';
  delete process.env.DOCFLOW_NUDGE_MAX_EMAILS;

  config.reset();
  monday._resetState();
  adobe._resetState();
  mailer._resetTokenCache();

  backend = makeBackend();
  installRoutes(axios, backend);

  // Adobe cancel goes over PUT — accept the state mutation, keep the rest strict.
  putCalls = [];
  axios.put.mockImplementation(async (url, body) => {
    if (String(url).includes('/state')) {
      putCalls.push({ url, body });
      return { status: 200, data: {} };
    }
    if (String(url).includes('pdf.mock/upload')) return { status: 200, data: {} };
    throw new Error(`unexpected PUT ${url}`);
  });

  // Seedable update thread with timestamps; sweep-posted comments show up too.
  seededUpdates = {};
  jest.spyOn(monday, 'listUpdates').mockImplementation(async (itemId) => [
    ...(seededUpdates[String(itemId)] || []),
    ...backend.updates
      .filter((u) => u.itemId === String(itemId))
      .map((u) => ({ text: u.body, createdAt: now() })),
  ]);
});

afterAll(() => {
  delete process.env.GRAPH_CLIENT_ID;
  delete process.env.GRAPH_CLIENT_SECRET;
  delete process.env.MAIL_SENDER;
  delete process.env.DOCFLOW_NUDGE_MAX_EMAILS;
  config.reset();
});

describe('nudgeSweep — candidate nudges', () => {
  test('GHOST: >48h unsigned, never clicked → one branded email + needle comment; second run dedupes', async () => {
    const sl = config.load().monday.statusLabels;
    seededUpdates['555'] = [{ text: 'The email you previewed at step 6 went out verbatim.', createdAt: now() - 60 * HOUR }];

    const summary = await nudgeSweep.runNudgeSweep({ items: [item({ status: sl.outForSignature })] });
    expect(summary.nudged).toBe(1);
    expect(summary.emails).toBe(1);

    // Email went to the PERSONAL address is preferred — row 555 has only work email
    const mails = sendMailCalls();
    expect(mails).toHaveLength(1);
    expect(mails[0][1].message.toRecipients[0].emailAddress.address).toBe('jane@medwatchers.com');
    expect(mails[0][1].message.subject).toContain('waiting');

    // Comment carries the verbatim needle
    expect(backend.updates).toHaveLength(1);
    expect(backend.updates[0].body).toContain(NEEDLES.signReminder);

    // Second run: the needle is now on the thread → nothing new fires
    const again = await nudgeSweep.runNudgeSweep({ items: [item({ status: sl.outForSignature })] });
    expect(again.nudged).toBe(0);
    expect(sendMailCalls()).toHaveLength(1);
    expect(backend.updates).toHaveLength(1);
  });

  test('GHOST prefers the personal email when the card has one', async () => {
    const cfg = config.load();
    backend.rows[555].written[cfg.monday.formSync.targetColumns.personalEmail] =
      { email: 'jane.personal@gmail.com', text: 'jane.personal@gmail.com' };
    seededUpdates['555'] = [{ text: 'went out', createdAt: now() - 60 * HOUR }];

    await nudgeSweep.runNudgeSweep({ items: [item({ status: cfg.monday.statusLabels.outForSignature })] });
    expect(sendMailCalls()[0][1].message.toRecipients[0].emailAddress.address).toBe('jane.personal@gmail.com');
  });

  test('CLICKED-NOT-SIGNED: clicked >24h ago, unsigned → the alternate "almost there" copy, not the ghost copy', async () => {
    const sl = config.load().monday.statusLabels;
    seededUpdates['555'] = [
      { text: 'went out', createdAt: now() - 30 * HOUR },
      { text: 'The candidate clicked the signing link from the welcome email', createdAt: now() - 28 * HOUR },
    ];

    const summary = await nudgeSweep.runNudgeSweep({ items: [item({ status: sl.outForSignature })] });
    expect(summary.emails).toBe(1);
    const mails = sendMailCalls();
    expect(mails[0][1].message.subject).toContain('almost there');
    expect(backend.updates[0].body).toContain(NEEDLES.almostThere);
    expect(backend.updates[0].body).not.toContain(NEEDLES.signReminder);
  });

  test('GHOST ESCALATION: >96h, no click → HR comment only, no more candidate email', async () => {
    const sl = config.load().monday.statusLabels;
    seededUpdates['555'] = [
      { text: 'went out', createdAt: now() - 100 * HOUR },
      { text: `(${NEEDLES.signReminder})`, createdAt: now() - 50 * HOUR },
    ];

    const summary = await nudgeSweep.runNudgeSweep({ items: [item({ status: sl.outForSignature })] });
    expect(summary.nudged).toBe(1);
    expect(sendMailCalls()).toHaveLength(0);
    expect(backend.updates).toHaveLength(1);
    expect(backend.updates[0].body).toContain(NEEDLES.hrEscalation);
  });

  test('FORM GHOST: ⑥ Form Pending >72h → form-only reminder carrying a tracked form link', async () => {
    const sl = config.load().monday.statusLabels;
    const summary = await nudgeSweep.runNudgeSweep({
      items: [item({ status: sl.signedFormPending, updatedAt: now() - 80 * HOUR })],
    });
    expect(summary.emails).toBe(1);
    const mail = sendMailCalls()[0][1];
    expect(mail.message.subject).toContain('form');
    // Tracking secret is configured in tests → the form link routes via trackClick
    expect(mail.message.body.content).toContain('/api/trackClick');
    expect(backend.updates[0].body).toContain(NEEDLES.formReminder);
  });

  test('candidate email budget: exhausted budget blocks the email AND the comment', async () => {
    process.env.DOCFLOW_NUDGE_MAX_EMAILS = '0';
    const sl = config.load().monday.statusLabels;
    seededUpdates['555'] = [{ text: 'went out', createdAt: now() - 60 * HOUR }];

    const summary = await nudgeSweep.runNudgeSweep({ items: [item({ status: sl.outForSignature })] });
    expect(summary.emailBudgetBlocked).toBe(1);
    expect(summary.emails).toBe(0);
    expect(sendMailCalls()).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });
});

describe('nudgeSweep — rails', () => {
  test('OPT-OUT: checked box blocks every nudge for the card', async () => {
    const cfg = config.load();
    backend.rows[555].written[cfg.monday.columns.noReminders] = { checked: true };
    seededUpdates['555'] = [{ text: 'went out', createdAt: now() - 60 * HOUR }];

    const summary = await nudgeSweep.runNudgeSweep({
      items: [item({ status: cfg.monday.statusLabels.outForSignature })],
    });
    expect(summary.skippedOptOut).toBe(1);
    expect(summary.nudged).toBe(0);
    expect(sendMailCalls()).toHaveLength(0);
    expect(backend.updates).toHaveLength(0);
  });

  test('cap: at most 20 actions per run, remainder counted but untouched', async () => {
    const sl = config.load().monday.statusLabels;
    const items = [];
    for (let i = 0; i < 25; i++) {
      const id = String(2000 + i);
      backend.rows[id] = { ...backend.rows[555], id, written: {} };
      items.push(item({ id, updatedAt: now() - 7 * 24 * HOUR, status: sl.awaitingReview }));
    }
    const summary = await nudgeSweep.runNudgeSweep({ items });
    expect(summary.capped).toBe(true);
    expect(summary.actions).toBe(20);
    expect(backend.updates).toHaveLength(20);
    expect(summary.scanned).toBe(25);
  });

  test('one bad row never poisons the sweep', async () => {
    const sl = config.load().monday.statusLabels;
    jest.spyOn(monday, 'readRow').mockRejectedValue(new Error('boom'));
    const summary = await nudgeSweep.runNudgeSweep({
      items: [item({ status: sl.awaitingReview, updatedAt: now() - 7 * 24 * HOUR })],
    });
    expect(summary.failed).toBe(1);
    expect(backend.updates).toHaveLength(0);
  });
});

describe('nudgeSweep — HR-facing nudges', () => {
  test('HR STALL: ④ Review >2 business days → comment quoting the exact approve label, no email', async () => {
    const cfg = config.load();
    const summary = await nudgeSweep.runNudgeSweep({
      items: [item({ status: cfg.monday.statusLabels.awaitingReview, updatedAt: now() - 7 * 24 * HOUR })],
    });
    expect(summary.nudged).toBe(1);
    expect(sendMailCalls()).toHaveLength(0);
    expect(backend.updates).toHaveLength(1);
    expect(backend.updates[0].body).toContain(NEEDLES.reviewStall);
    expect(backend.updates[0].body).toContain(cfg.monday.offerLabels.approved);
  });

  test('READY-NOT-SENT: ⑥ Ready to Send >24h → comment quoting the send label', async () => {
    const cfg = config.load();
    seededUpdates['555'] = [{ text: 'I built the packet. Signing order: Francisco Lopez.', createdAt: now() - 30 * HOUR }];
    const summary = await nudgeSweep.runNudgeSweep({
      items: [item({ offerStatus: cfg.monday.offerLabels.readyToSend })],
    });
    expect(summary.nudged).toBe(1);
    expect(backend.updates[0].body).toContain(NEEDLES.readyNotSent);
    expect(backend.updates[0].body).toContain(cfg.monday.offerLabels.sendPackage);
  });

  test('FIELDS IDLE: ② Waiting >72h with empty required fields → "X fields still empty" comment', async () => {
    const cfg = config.load();
    const summary = await nudgeSweep.runNudgeSweep({
      items: [item({ status: cfg.monday.statusLabels.awaitingInfo, updatedAt: now() - 80 * HOUR })],
    });
    expect(summary.nudged).toBe(1);
    expect(backend.updates[0].body).toContain(NEEDLES.fieldsIdle);
    expect(backend.updates[0].body).toMatch(/\d+ fields are still empty/);
  });
});

describe('nudgeSweep — lapse', () => {
  test('LAPSE: expired offer still ⑤ Sent → narration + Adobe cancel, status untouched, fires once', async () => {
    const cfg = config.load();
    backend.rows[555].written[cfg.monday.columns.offerExpires] = '2020-01-01';
    backend.rows[555].written[cfg.monday.columns.agreementId] = 'AGR-42';
    seededUpdates['555'] = [{ text: 'went out', createdAt: now() - 200 * HOUR }];

    const stalled = item({ status: cfg.monday.statusLabels.outForSignature });
    const summary = await nudgeSweep.runNudgeSweep({ items: [stalled] });
    expect(summary.lapsed).toBe(1);

    // Adobe agreement cancelled via PUT /agreements/{id}/state
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].url).toContain('/agreements/AGR-42/state');
    expect(putCalls[0].body.state).toBe('CANCELLED');

    // Narrated, needle kept, no candidate email, no status/label write
    expect(sendMailCalls()).toHaveLength(0);
    expect(backend.updates).toHaveLength(1);
    expect(backend.updates[0].body).toContain(NEEDLES.lapsed);
    expect(backend.updates[0].body).toContain('lapsed');
    expect(backend.rows[555].written[cfg.monday.columns.status]).toBeUndefined();
    expect(backend.rows[555].written[cfg.monday.columns.offerStatus]).toBeUndefined();

    // Second run: already narrated → fully quiet (no ghost email either)
    const again = await nudgeSweep.runNudgeSweep({ items: [stalled] });
    expect(again.lapsed).toBe(0);
    expect(again.nudged).toBe(0);
    expect(backend.updates).toHaveLength(1);
  });

  test('LAPSE narration still posts when the card is opted out of reminders', async () => {
    const cfg = config.load();
    backend.rows[555].written[cfg.monday.columns.noReminders] = { checked: true };
    backend.rows[555].written[cfg.monday.columns.offerExpires] = '2020-01-01';

    const summary = await nudgeSweep.runNudgeSweep({
      items: [item({ status: cfg.monday.statusLabels.outForSignature })],
    });
    expect(summary.lapsed).toBe(1);
    expect(backend.updates).toHaveLength(1);
    expect(backend.updates[0].body).toContain(NEEDLES.lapsed);
  });
});

describe('nudgeSweep — plumbing', () => {
  test('businessDaysBetween skips weekends', () => {
    const { businessDaysBetween } = nudgeSweep;
    // Mon 2026-08-17 00:00 → Mon 2026-08-24 00:00 = 5 business days
    const mon = new Date(2026, 7, 17).getTime();
    const nextMon = new Date(2026, 7, 24).getTime();
    expect(businessDaysBetween(mon, nextMon)).toBe(5);
    expect(businessDaysBetween(mon, mon)).toBe(0);
    // Fri → Mon spans only the weekend + Monday
    const fri = new Date(2026, 7, 21).getTime();
    expect(businessDaysBetween(fri, nextMon)).toBe(1);
  });

  test('timer entry point runs the sweep without throwing', async () => {
    await expect(nudgeSweep({ bindings: {} }, { isPastDue: false })).resolves.toBeUndefined();
  });
});
