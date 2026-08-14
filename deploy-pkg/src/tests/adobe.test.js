'use strict';
/** Unit tests: Adobe PDF Services + Sign clients. All axios calls mocked. */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const config = require('../lib/config');
const adobe = require('../lib/adobe');
const { RateLimiter } = require('../lib/util');

const IMS_TOKEN_RESPONSE = (expiresIn = 86400) => ({
  data: { access_token: 'test-pdf-token', expires_in: expiresIn },
});

function routePdfHappyPath(pdfBytes) {
  axios.post.mockImplementation(async (url) => {
    if (url.includes('/ims/token/v3')) return IMS_TOKEN_RESPONSE();
    if (url.includes('/operation/documentgeneration')) {
      return { data: {}, headers: { location: 'https://pdf.mock/job/1' } };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  axios.get.mockImplementation(async (url) => {
    if (url === 'https://pdf.mock/job/1') {
      return { data: { status: 'done', asset: { downloadUri: 'https://pdf.mock/dl/1', assetID: 'ASSET-9' } } };
    }
    if (url === 'https://pdf.mock/dl/1') return { data: pdfBytes };
    throw new Error(`unexpected GET ${url}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  config.reset();
  adobe._resetState();
});

describe('extractMergeFields', () => {
  test('valid data passes and returns field list', () => {
    const result = adobe.extractMergeFields(['firstName', 'lastName'], {
      firstName: 'Jane', lastName: 'Doe',
    });
    expect(result.fields).toEqual(['firstName', 'lastName']);
    expect(result.missing).toEqual([]);
  });

  test('missing required field throws with field names', () => {
    expect(() => adobe.extractMergeFields(
      { fields: [{ name: 'firstName' }, { name: 'salary', required: true }] },
      { firstName: 'Jane' }
    )).toThrow(/salary/);
  });

  test('optional fields may be absent', () => {
    const result = adobe.extractMergeFields(
      { fields: [{ name: 'firstName' }, { name: 'middleName', required: false }] },
      { firstName: 'Jane' }
    );
    expect(result.missing).toEqual([]);
  });
});

describe('createPDF', () => {
  test('happy path returns PDF buffer + pdfId', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7 test-doc');
    routePdfHappyPath(pdfBytes);

    const result = await adobe.createPDF('TPL-123', { firstName: 'Jane' });
    expect(result.pdfId).toBe('ASSET-9');
    expect(Buffer.compare(result.buffer, pdfBytes)).toBe(0);
  });

  test('missing merge field fails before any API call', async () => {
    await expect(
      adobe.createPDF('TPL-123', { firstName: 'Jane' }, ['firstName', 'lastName'])
    ).rejects.toThrow(/lastName/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('job failure status surfaces the Adobe error', async () => {
    axios.post.mockImplementation(async (url) => {
      if (url.includes('/ims/token/v3')) return IMS_TOKEN_RESPONSE();
      return { data: {}, headers: { location: 'https://pdf.mock/job/1' } };
    });
    axios.get.mockResolvedValue({ data: { status: 'failed', error: { code: 'BAD_TEMPLATE' } } });
    await expect(adobe.createPDF('TPL-BAD', { a: 1 })).rejects.toThrow(/BAD_TEMPLATE/);
  });

  test('timeout on submit retries 3x then fails (4 attempts total)', async () => {
    let submitAttempts = 0;
    axios.post.mockImplementation(async (url) => {
      if (url.includes('/ims/token/v3')) return IMS_TOKEN_RESPONSE();
      if (url.includes('/operation/documentgeneration')) {
        submitAttempts++;
        const err = new Error('timeout');
        err.code = 'ECONNABORTED';
        throw err;
      }
      throw new Error(`unexpected POST ${url}`);
    });
    await expect(adobe.createPDF('TPL-123', { a: 1 })).rejects.toThrow('timeout');
    expect(submitAttempts).toBe(4);
  });

  test('transient 429 is retried then succeeds', async () => {
    const pdfBytes = Buffer.from('%PDF ok');
    let submitAttempts = 0;
    axios.post.mockImplementation(async (url) => {
      if (url.includes('/ims/token/v3')) return IMS_TOKEN_RESPONSE();
      if (url.includes('/operation/documentgeneration')) {
        submitAttempts++;
        if (submitAttempts <= 2) {
          const err = new Error('rate limited');
          err.response = { status: 429 };
          throw err;
        }
        return { data: {}, headers: { location: 'https://pdf.mock/job/1' } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    axios.get.mockImplementation(async (url) => {
      if (url === 'https://pdf.mock/job/1') {
        return { data: { status: 'done', asset: { downloadUri: 'https://pdf.mock/dl/1', assetID: 'A1' } } };
      }
      return { data: pdfBytes };
    });
    const result = await adobe.createPDF('TPL-123', { a: 1 });
    expect(submitAttempts).toBe(3);
    expect(result.buffer.length).toBe(pdfBytes.length);
  });
});

describe('token management', () => {
  test('token is cached while far from expiry', async () => {
    axios.post.mockResolvedValue(IMS_TOKEN_RESPONSE(86400));
    const t1 = await adobe.getToken('pdf');
    const t2 = await adobe.getToken('pdf');
    expect(t1).toBe('test-pdf-token');
    expect(t2).toBe('test-pdf-token');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('token within 10-min expiry margin is refreshed', async () => {
    // expires_in 60s < 10-minute refresh margin -> every call refetches
    axios.post.mockResolvedValue(IMS_TOKEN_RESPONSE(60));
    await adobe.getToken('pdf');
    await adobe.getToken('pdf');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('sign token uses static integration key without network calls', async () => {
    const token = await adobe.getToken('sign');
    expect(token).toBe('test-integration-key');
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('createEnvelope', () => {
  test('creates agreement with serial signing order', async () => {
    let agreementBody = null;
    axios.post.mockImplementation(async (url, body) => {
      if (url.includes('/transientDocuments')) return { data: { transientDocumentId: 'TR-1' } };
      if (url.includes('/agreements')) {
        agreementBody = body;
        return { data: { id: 'AGR-42' } };
      }
      throw new Error(`unexpected POST ${url}`);
    });

    const result = await adobe.createEnvelope(Buffer.from('%PDF'), [
      { email: 'hr@medwatchers.com', name: 'HR' },
      { email: 'manager@medwatchers.com', name: 'Manager' },
      { email: 'employee@medwatchers.com', name: 'Employee' },
    ], { name: 'Offer Letter' });

    expect(result.agreementId).toBe('AGR-42');
    expect(result.signers).toHaveLength(3);
    expect(agreementBody.participantSetsInfo.map((p) => p.order)).toEqual([1, 2, 3]);
    expect(agreementBody.participantSetsInfo[0].memberInfos[0].email).toBe('hr@medwatchers.com');
    expect(agreementBody.state).toBe('IN_PROCESS');
    expect(agreementBody.fileInfos[0].transientDocumentId).toBe('TR-1');
  });

  test('rejects an empty signer list', async () => {
    await expect(adobe.createEnvelope(Buffer.from('%PDF'), [])).rejects.toThrow(/at least one signer/);
  });

  test('rejects signers without email', async () => {
    await expect(
      adobe.createEnvelope(Buffer.from('%PDF'), [{ name: 'No Email' }])
    ).rejects.toThrow(/email/);
  });
});

describe('getSignedPDF', () => {
  test('downloads signed bytes with retry on transient failure', async () => {
    const signed = Buffer.from('%PDF signed-content');
    let attempts = 0;
    axios.get.mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('flaky');
        err.response = { status: 503 };
        throw err;
      }
      return { data: signed };
    });
    const buffer = await adobe.getSignedPDF('AGR-42');
    expect(attempts).toBe(2);
    expect(Buffer.compare(buffer, signed)).toBe(0);
  });

  test('fails after exhausting 2 retries (3 attempts)', async () => {
    let attempts = 0;
    axios.get.mockImplementation(async () => {
      attempts++;
      const err = new Error('down');
      err.response = { status: 500 };
      throw err;
    });
    await expect(adobe.getSignedPDF('AGR-42')).rejects.toThrow('down');
    expect(attempts).toBe(3);
  });

  test('requires an agreementId', async () => {
    await expect(adobe.getSignedPDF()).rejects.toThrow(/agreementId/);
  });
});

describe('rate limiting', () => {
  test('rate limit hit queues the caller until the window frees up', async () => {
    const limiter = new RateLimiter(2, 200, 'test');
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.inFlight).toBe(2);
    await limiter.acquire(); // third must wait for the 200ms window
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });
});
