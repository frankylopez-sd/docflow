'use strict';

/**
 * validateADP shared-secret gate (finding D48). The endpoint stays authLevel
 * anonymous, so an optional header secret (x-docflow-key vs DOCFLOW_VALIDATE_KEY)
 * is the real write guard: fail-open when unconfigured, 401 on mismatch when set.
 */

jest.mock('../lib/config', () => ({ load: jest.fn() }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), event: jest.fn(), metric: jest.fn(), flush: jest.fn(),
}));
jest.mock('../lib/monday', () => ({ updateItemStatus: jest.fn(), logAction: jest.fn(), _resetState: jest.fn() }));
jest.mock('../lib/priorityQueueService', () => ({ routeMessage: jest.fn() }));

const validateADP = require('../functions/validateADP/index.js');
const config = require('../lib/config');
const logger = require('../lib/logger');
const monday = require('../lib/monday');
const queue = require('../lib/priorityQueueService');

const ROUTED = { queueName: 'docflow-generate', priority: 'normal', binding: 'generateQueueNormal', message: '{"routed":true}' };

const VALID = {
  boardId: '18422046530', itemId: '12787139922',
  firstName: 'Jane', lastName: 'Pharmacist', workEmail: 'jane@medwatchers.com', badgeNumber: 'B1',
  adpJobTitle: 'Pharmacist', adpDepartment: 'Pharmacy', adpWorkLocation: 'Main', workerType: 'Full-Time',
  supervisor: 'John', reasonForHire: 'New Position', payType: 'Salary', payRate: 65000, payFrequency: 'Annual',
  companyCode: 'MW-UT', payClass: 'Professional', flsaStatus: 'Exempt', suiSdiTaxCode: 'CA-001',
  workersCompStatus: 'Subject', workersCompJobClass: 'Prof', workedInState: 'Utah', livedInState: 'Utah',
  timeZone: 'MST', benefitsEligibility: 'Eligible', benefitsEligibilityClass: 'Full-Time', onboardingExperience: 'Standard',
};

function ctx() { return { res: null, bindings: {} }; }

beforeEach(() => {
  jest.clearAllMocks();
  config.load.mockReturnValue({});
  monday.updateItemStatus.mockResolvedValue(true);
  monday.logAction.mockResolvedValue(true);
  queue.routeMessage.mockResolvedValue({ ...ROUTED });
  delete process.env.DOCFLOW_VALIDATE_KEY;
});

afterEach(() => { delete process.env.DOCFLOW_VALIDATE_KEY; });

describe('validateADP auth gate', () => {
  test('fails OPEN when DOCFLOW_VALIDATE_KEY is unset — request still processed, warning logged', async () => {
    const c = ctx();
    await validateADP(c, { body: { ...VALID } });
    expect(c.res.status).toBe(200);
    expect(c.res.body.validated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('validateADP-auth-disabled', expect.any(Object));
  });

  test('rejects with 401 when key is set and header is missing', async () => {
    process.env.DOCFLOW_VALIDATE_KEY = 'sekret';
    const c = ctx();
    await validateADP(c, { body: { ...VALID } });
    expect(c.res.status).toBe(401);
    expect(queue.routeMessage).not.toHaveBeenCalled();
    expect(monday.updateItemStatus).not.toHaveBeenCalled();
  });

  test('rejects with 401 when key is set and header mismatches', async () => {
    process.env.DOCFLOW_VALIDATE_KEY = 'sekret';
    const c = ctx();
    await validateADP(c, { body: { ...VALID }, headers: { 'x-docflow-key': 'wrong' } });
    expect(c.res.status).toBe(401);
    expect(queue.routeMessage).not.toHaveBeenCalled();
  });

  test('accepts when key is set and header matches', async () => {
    process.env.DOCFLOW_VALIDATE_KEY = 'sekret';
    const c = ctx();
    await validateADP(c, { body: { ...VALID }, headers: { 'x-docflow-key': 'sekret' } });
    expect(c.res.status).toBe(200);
    expect(c.res.body.validated).toBe(true);
    expect(queue.routeMessage).toHaveBeenCalled();
  });
});
