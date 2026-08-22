'use strict';
/**
 * generatePDF guards: pay-rate sanity (finding A7) and the claimOnce dedupe
 * lock (finding A2). Fully offline against the fake Monday/Adobe backend.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());
jest.mock('@azure/identity', () => ({ DefaultAzureCredential: class DefaultAzureCredential {} }));

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const { makeBackend, installRoutes } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const adobe = require('../lib/adobe');
const monday = require('../lib/monday');
const blob = require('../lib/blob');
const generatePDF = require('../functions/generatePDF');

let backend;
function makeContext() { return { bindings: {}, bindingData: {}, res: null }; }

const FULL_HIRE_MSG = {
  boardId: '111', itemId: '555',
  firstName: 'Jane', lastName: 'Doe', workEmail: 'jane@medwatchers.com',
  adpJobTitle: 'Pharmacist', adpDepartment: 'Pharmacy', supervisor: 'Mayra R',
  payRate: 65000, payFrequency: 'Annual', startDate: '2026-09-01',
};

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

describe('validatePayRate (pure)', () => {
  const v = generatePDF.validatePayRate;

  test('valid hourly rate passes', () => {
    expect(v({ payRate: '45', payFrequency: 'Hourly', adpJobTitle: 'Pharmacist' }).ok).toBe(true);
  });

  test('valid annual salary passes (band does not apply to salaried pay)', () => {
    expect(v({ payRate: 65000, payFrequency: 'Annual', adpJobTitle: 'Pharmacist' }).ok).toBe(true);
  });

  test('$9/hr for a Pharmacist is blocked (below RPH floor)', () => {
    const r = v({ payRate: '9', payFrequency: 'Hourly', adpJobTitle: 'Pharmacist' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/at least \$30\/hr/);
  });

  test('non-numeric ("TBD") is blocked', () => {
    expect(v({ payRate: 'TBD', payFrequency: 'Hourly', adpJobTitle: 'Clerk' }).ok).toBe(false);
  });

  test('negative rate is blocked', () => {
    expect(v({ payRate: '-5', payFrequency: 'Hourly' }).ok).toBe(false);
  });

  test('high outlier above the ceiling is blocked', () => {
    const r = v({ payRate: '500', payFrequency: 'Hourly', adpJobTitle: 'Clerk' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ceiling/);
  });
});

describe('generatePDF pay-rate gate', () => {
  test('a $9/hr Pharmacist never reaches Adobe — letter is not built', async () => {
    const spy = jest.spyOn(adobe, 'generateOfferLetter');
    const ctx = makeContext();
    await generatePDF.processGenerate(ctx, {
      ...FULL_HIRE_MSG, payRate: '9', payFrequency: 'Hourly',
    });
    expect(ctx.res.body).toMatchObject({ generated: false, payRateInvalid: true });
    expect(spy).not.toHaveBeenCalled();
    const bodies = backend.updates.filter((u) => u.itemId === '555').map((u) => u.body).join('\n');
    expect(bodies).toContain('That pay rate looks off');
    spy.mockRestore();
  });
});

describe('generatePDF claimOnce dedupe (finding A2)', () => {
  test('a run that loses the lock does not build a second letter', async () => {
    const claimSpy = jest.spyOn(blob, 'claimOnce').mockResolvedValue(false);
    const adobeSpy = jest.spyOn(adobe, 'generateOfferLetter');
    const ctx = makeContext();
    await generatePDF.processGenerate(ctx, { ...FULL_HIRE_MSG });
    expect(claimSpy).toHaveBeenCalledWith('pdf-locks', 'generate-555.lock');
    expect(adobeSpy).not.toHaveBeenCalled();
    expect(ctx.res.body.generated).toBe(false);
    claimSpy.mockRestore();
    adobeSpy.mockRestore();
  });
});
