'use strict';

/**
 * COMPREHENSIVE VALIDATION TEST: All 25 ADP Field Rules
 *
 * Verifies that validateADP properly validates each of the 25 required ADP fields:
 * 1-4: Personal (firstName, lastName, workEmail, badgeNumber)
 * 5-10: Employment (adpJobTitle, adpDepartment, adpWorkLocation, workerType, supervisor, reasonForHire)
 * 11-15: Payroll (payType, payRate, payFrequency, companyCode, payClass)
 * 16-17: Tax (flsaStatus, suiSdiTaxCode)
 * 18-25: Time & Attendance (workersCompStatus, workersCompJobClass, workedInState, livedInState,
 *        timeZone, benefitsEligibility, benefitsEligibilityClass, onboardingExperience)
 */

jest.mock('../lib/config', () => ({
  load: jest.fn()
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  event: jest.fn(),
  metric: jest.fn(),
  flush: jest.fn()
}));

jest.mock('../lib/monday', () => ({
  updateItemStatus: jest.fn(),
  queueMessage: jest.fn(),
  _resetState: jest.fn()
}));

const validateADP = require('../functions/validateADP/index.js');
const config = require('../lib/config');
const logger = require('../lib/logger');
const monday = require('../lib/monday');

const VALID_TEST_DATA = {
  boardId: '18422046530',
  itemId: '12787139922',
  firstName: 'Jane',
  lastName: 'Pharmacist',
  workEmail: 'jane@medwatchers.com',
  badgeNumber: 'BADGE-001',
  adpJobTitle: 'Pharmacist',
  adpDepartment: 'Pharmacy',
  adpWorkLocation: 'Main Office',
  workerType: 'Full-Time',
  supervisor: 'John Smith',
  reasonForHire: 'New Position',
  payType: 'Salary',
  payRate: 65000,
  payFrequency: 'Annual',
  companyCode: 'MW-UT',
  payClass: 'Professional',
  flsaStatus: 'Exempt',
  suiSdiTaxCode: 'CA-001',
  workersCompStatus: 'Subject to PBP',
  workersCompJobClass: 'Professional Services',
  workedInState: 'Utah',
  livedInState: 'Utah',
  timeZone: 'MST',
  benefitsEligibility: 'Eligible',
  benefitsEligibilityClass: 'Full-Time',
  onboardingExperience: 'Standard'
};

const FIELD_CONFIGS = [
  // PERSONAL (4 fields)
  { name: 'firstName', category: 'Personal', description: 'First name' },
  { name: 'lastName', category: 'Personal', description: 'Last name' },
  { name: 'workEmail', category: 'Personal', description: 'Work email address' },
  { name: 'badgeNumber', category: 'Personal', description: 'Badge ID number' },

  // EMPLOYMENT (6 fields)
  { name: 'adpJobTitle', category: 'Employment', description: 'ADP job title' },
  { name: 'adpDepartment', category: 'Employment', description: 'ADP department' },
  { name: 'adpWorkLocation', category: 'Employment', description: 'ADP work location' },
  { name: 'workerType', category: 'Employment', description: 'Worker type (FT/PT/Contract)' },
  { name: 'supervisor', category: 'Employment', description: 'Supervisor name/ID' },
  { name: 'reasonForHire', category: 'Employment', description: 'Reason for hire' },

  // PAYROLL (5 fields)
  { name: 'payType', category: 'Payroll', description: 'Pay type (Salary/Hourly)' },
  { name: 'payRate', category: 'Payroll', description: 'Pay rate (numeric)' },
  { name: 'payFrequency', category: 'Payroll', description: 'Pay frequency' },
  { name: 'companyCode', category: 'Payroll', description: 'Company code' },
  { name: 'payClass', category: 'Payroll', description: 'Pay class' },

  // TAX (2 fields)
  { name: 'flsaStatus', category: 'Tax', description: 'FLSA status' },
  { name: 'suiSdiTaxCode', category: 'Tax', description: 'SUI/SDI tax code' },

  // TIME & ATTENDANCE (8 fields)
  { name: 'workersCompStatus', category: 'Time & Attendance', description: 'Workers comp status' },
  { name: 'workersCompJobClass', category: 'Time & Attendance', description: 'Workers comp job class' },
  { name: 'workedInState', category: 'Time & Attendance', description: 'State where employee works' },
  { name: 'livedInState', category: 'Time & Attendance', description: 'State where employee lives' },
  { name: 'timeZone', category: 'Time & Attendance', description: 'Time zone' },
  { name: 'benefitsEligibility', category: 'Time & Attendance', description: 'Benefits eligibility status' },
  { name: 'benefitsEligibilityClass', category: 'Time & Attendance', description: 'Benefits eligibility class' },
  { name: 'onboardingExperience', category: 'Time & Attendance', description: 'Onboarding experience type' }
];

function makeContext() {
  return { res: null, req: {} };
}

describe('validateADP: Field Count Verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.load.mockReturnValue({});
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    monday.updateItemStatus.mockClear();
    monday.queueMessage.mockClear();
    monday.updateItemStatus.mockResolvedValue(true);
    monday.queueMessage.mockResolvedValue(true);
  });

  test('VALIDATES all 25 required fields are counted correctly', () => {
    expect(FIELD_CONFIGS).toHaveLength(25);
  });

  test('VALIDATES field category distribution', () => {
    const categories = {};
    FIELD_CONFIGS.forEach(field => {
      categories[field.category] = (categories[field.category] || 0) + 1;
    });

    expect(categories['Personal']).toBe(4);
    expect(categories['Employment']).toBe(6);
    expect(categories['Payroll']).toBe(5);
    expect(categories['Tax']).toBe(2);
    expect(categories['Time & Attendance']).toBe(8);
  });
});

describe('validateADP: Individual Field Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.load.mockReturnValue({});
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    monday.updateItemStatus.mockClear();
    monday.queueMessage.mockClear();
    monday.updateItemStatus.mockResolvedValue(true);
    monday.queueMessage.mockResolvedValue(true);
  });

  // Test each field individually
  FIELD_CONFIGS.forEach(field => {
    describe(`${field.category} - ${field.name}`, () => {
      test(`PASSES when ${field.name} is provided (${field.description})`, async () => {
        const testData = { ...VALID_TEST_DATA };
        const ctx = makeContext();

        await validateADP(ctx, { body: testData });

        expect(ctx.res.status).toBe(200);
        expect(ctx.res.body.validated).toBe(true);
        expect(ctx.res.body.status).toBe('Create New Hire');
        expect(monday.queueMessage).toHaveBeenCalled();
      });

      test(`FAILS when ${field.name} is missing`, async () => {
        const testData = { ...VALID_TEST_DATA };
        delete testData[field.name];
        const ctx = makeContext();

        await validateADP(ctx, { body: testData });

        expect(ctx.res.status).toBe(200);
        expect(ctx.res.body.validated).toBe(false);
        expect(ctx.res.body.status).toBe('Missing Required Fields');
        expect(ctx.res.body.missingFields).toContain(field.name);
        expect(monday.queueMessage).not.toHaveBeenCalled();
      });

      test(`FAILS when ${field.name} is empty string`, async () => {
        const testData = { ...VALID_TEST_DATA };
        testData[field.name] = '';
        const ctx = makeContext();

        await validateADP(ctx, { body: testData });

        expect(ctx.res.status).toBe(200);
        expect(ctx.res.body.validated).toBe(false);
        expect(ctx.res.body.status).toBe('Missing Required Fields');
        expect(ctx.res.body.missingFields).toContain(field.name);
      });

      test(`FAILS when ${field.name} is whitespace only`, async () => {
        const testData = { ...VALID_TEST_DATA };
        testData[field.name] = '   ';
        const ctx = makeContext();

        await validateADP(ctx, { body: testData });

        expect(ctx.res.status).toBe(200);
        expect(ctx.res.body.validated).toBe(false);
        expect(ctx.res.body.status).toBe('Missing Required Fields');
        expect(ctx.res.body.missingFields).toContain(field.name);
      });

      test(`FAILS when ${field.name} is null`, async () => {
        const testData = { ...VALID_TEST_DATA };
        testData[field.name] = null;
        const ctx = makeContext();

        await validateADP(ctx, { body: testData });

        expect(ctx.res.status).toBe(200);
        expect(ctx.res.body.validated).toBe(false);
        expect(ctx.res.body.status).toBe('Missing Required Fields');
        expect(ctx.res.body.missingFields).toContain(field.name);
      });

      test(`FAILS when ${field.name} is undefined`, async () => {
        const testData = { ...VALID_TEST_DATA };
        testData[field.name] = undefined;
        const ctx = makeContext();

        await validateADP(ctx, { body: testData });

        expect(ctx.res.status).toBe(200);
        expect(ctx.res.body.validated).toBe(false);
        expect(ctx.res.body.status).toBe('Missing Required Fields');
        expect(ctx.res.body.missingFields).toContain(field.name);
      });
    });
  });
});

describe('validateADP: Multi-Field Failures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.load.mockReturnValue({});
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    monday.updateItemStatus.mockClear();
    monday.queueMessage.mockClear();
    monday.updateItemStatus.mockResolvedValue(true);
    monday.queueMessage.mockResolvedValue(true);
  });

  test('FAILS when multiple fields are missing', async () => {
    const testData = { ...VALID_TEST_DATA };
    delete testData.firstName;
    delete testData.workEmail;
    delete testData.payRate;
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.validated).toBe(false);
    expect(ctx.res.body.missingFields).toEqual(
      expect.arrayContaining(['firstName', 'workEmail', 'payRate'])
    );
    expect(ctx.res.body.missingFields.length).toBe(3);
  });

  test('PASSES when all 25 fields are present', async () => {
    const testData = { ...VALID_TEST_DATA };
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.validated).toBe(true);
    expect(ctx.res.body.missingFields).toBeUndefined();
    expect(monday.queueMessage).toHaveBeenCalled();
  });

  test('FAILS when all 25 fields are missing', async () => {
    const testData = { boardId: '111', itemId: '555' };
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.validated).toBe(false);
    expect(ctx.res.body.missingFields.length).toBe(25);
  });
});

describe('validateADP: Monday Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.load.mockReturnValue({});
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    monday.updateItemStatus.mockClear();
    monday.queueMessage.mockClear();
    monday.updateItemStatus.mockResolvedValue(true);
    monday.queueMessage.mockResolvedValue(true);
  });

  test('UPDATES Monday status to "Create New Hire" when valid', async () => {
    const testData = { ...VALID_TEST_DATA };
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(monday.updateItemStatus).toHaveBeenCalledWith(
      testData.boardId,
      testData.itemId,
      'Create New Hire'
    );
  });

  test('UPDATES Monday status to "Missing Required Fields" when invalid', async () => {
    const testData = { ...VALID_TEST_DATA };
    delete testData.firstName;
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(monday.updateItemStatus).toHaveBeenCalledWith(
      testData.boardId,
      testData.itemId,
      'Missing Required Fields'
    );
  });

  test('QUEUES PDF generation only when validation passes', async () => {
    const validData = { ...VALID_TEST_DATA };
    const ctx1 = makeContext();
    await validateADP(ctx1, { body: validData });
    expect(monday.queueMessage).toHaveBeenCalled();

    jest.clearAllMocks();
    monday.updateItemStatus.mockResolvedValue(true);
    monday.queueMessage.mockResolvedValue(true);

    const invalidData = { ...VALID_TEST_DATA };
    delete invalidData.lastName;
    const ctx2 = makeContext();
    await validateADP(ctx2, { body: invalidData });
    expect(monday.queueMessage).not.toHaveBeenCalled();
  });

  test('HANDLES Monday update failure gracefully', async () => {
    const testData = { ...VALID_TEST_DATA };
    monday.updateItemStatus.mockRejectedValue(new Error('Monday API down'));
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(ctx.res.status).toBe(200);
    expect(ctx.res.body.validated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'validateADP-monday-update-failed',
      expect.objectContaining({
        error: 'Monday API down',
        itemId: testData.itemId
      })
    );
  });
});

describe('validateADP: Error Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.load.mockReturnValue({});
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    monday.updateItemStatus.mockClear();
    monday.queueMessage.mockClear();
    monday.updateItemStatus.mockResolvedValue(true);
    monday.queueMessage.mockResolvedValue(true);
  });

  test('RETURNS 400 when boardId is missing', async () => {
    const testData = { ...VALID_TEST_DATA };
    delete testData.boardId;
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(ctx.res.status).toBe(400);
    expect(ctx.res.body.error).toContain('boardId');
  });

  test('RETURNS 400 when itemId is missing', async () => {
    const testData = { ...VALID_TEST_DATA };
    delete testData.itemId;
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(ctx.res.status).toBe(400);
    expect(ctx.res.body.error).toContain('itemId');
  });

  test('RETURNS 503 when queueMessage fails', async () => {
    const testData = { ...VALID_TEST_DATA };
    monday.queueMessage.mockRejectedValue(new Error('Queue unavailable'));
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(ctx.res.status).toBe(503);
    expect(ctx.res.body.error).toContain('queue');
  });

  test('THROWS on config.load error (error not caught at module init)', async () => {
    const testData = { ...VALID_TEST_DATA };
    config.load.mockImplementation(() => {
      throw new Error('Config broken');
    });

    // Note: config.load() is called before try-catch, so errors propagate
    await expect(validateADP(makeContext(), { body: testData })).rejects.toThrow('Config broken');
  });
});

describe('validateADP: Logging Verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.load.mockReturnValue({});
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    monday.updateItemStatus.mockClear();
    monday.queueMessage.mockClear();
    monday.updateItemStatus.mockResolvedValue(true);
    monday.queueMessage.mockResolvedValue(true);
  });

  test('LOGS validation check with field counts', async () => {
    const testData = { ...VALID_TEST_DATA };
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(logger.info).toHaveBeenCalledWith(
      'validateADP-check',
      expect.objectContaining({
        itemId: testData.itemId,
        totalFields: 25,
        missingFields: [],
        isValid: true
      })
    );
  });

  test('LOGS missing fields in validation result', async () => {
    const testData = { ...VALID_TEST_DATA };
    delete testData.firstName;
    delete testData.workEmail;
    const ctx = makeContext();

    await validateADP(ctx, { body: testData });

    expect(logger.info).toHaveBeenCalledWith(
      'validateADP-check',
      expect.objectContaining({
        missingFields: expect.arrayContaining(['firstName', 'workEmail']),
        isValid: false
      })
    );
  });
});
