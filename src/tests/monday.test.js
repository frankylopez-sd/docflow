'use strict';
/** Unit tests: Monday GraphQL client. All axios calls mocked. */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const config = require('../lib/config');
const monday = require('../lib/monday');

function gqlResponse(data) {
  return { data: { data } };
}

const SAMPLE_ITEM = {
  id: '555',
  name: 'Jane Doe',
  board: { id: '111' },
  column_values: [
    { id: 'email', text: 'jane@medwatchers.com', value: null, column: { title: 'Email' } },
    { id: 'date_start', text: '2026-08-15', value: null, column: { title: 'Start Date' } },
    { id: 'text_position', text: 'Pharmacy Tech', value: null, column: { title: 'Position' } },
    { id: 'status', text: 'Generated', value: '{"label":"Generated"}', column: { title: 'Status' } },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  config.reset();
  monday._resetState();
});

describe('readRow', () => {
  test('returns row data keyed by column id and title', async () => {
    axios.post.mockResolvedValue(gqlResponse({ items: [SAMPLE_ITEM] }));
    const row = await monday.readRow('111', '555');
    expect(row.itemId).toBe('555');
    expect(row.name).toBe('Jane Doe');
    expect(row.columns.email).toBe('jane@medwatchers.com');
    expect(row.byTitle['Start Date']).toBe('2026-08-15');
    expect(row.byTitle.Position).toBe('Pharmacy Tech');
  });

  test('throws when the item does not exist', async () => {
    axios.post.mockResolvedValue(gqlResponse({ items: [] }));
    await expect(monday.readRow('111', '999')).rejects.toThrow(/999 not found/);
  });

  test('sends the API token in the Authorization header', async () => {
    axios.post.mockResolvedValue(gqlResponse({ items: [SAMPLE_ITEM] }));
    await monday.readRow('111', '555');
    const [, , axiosConfig] = axios.post.mock.calls[0];
    expect(axiosConfig.headers.Authorization).toBe('test-monday-token');
  });
});

describe('readTemplates', () => {
  test('maps catalog rows and splits comma-separated fields/signers', async () => {
    axios.post.mockResolvedValue(gqlResponse({
      boards: [{
        items_page: {
          items: [{
            id: '901',
            name: 'Offer Letter',
            column_values: [
              { id: 'c1', text: 'TPL-123', value: null, column: { title: 'Adobe Template ID' } },
              { id: 'c2', text: 'firstName, lastName, email', value: null, column: { title: 'Data Fields' } },
              { id: 'c3', text: 'hr@medwatchers.com, {employee}', value: null, column: { title: 'Signers' } },
            ],
          }],
        },
      }],
    }));
    const templates = await monday.readTemplates('222');
    expect(templates).toHaveLength(1);
    expect(templates[0].templateName).toBe('Offer Letter');
    expect(templates[0].adobeTemplateId).toBe('TPL-123');
    expect(templates[0].dataFields).toEqual(['firstName', 'lastName', 'email']);
    expect(templates[0].signers).toEqual(['hr@medwatchers.com', '{employee}']);
  });

  test('throws when the catalog board is missing', async () => {
    axios.post.mockResolvedValue(gqlResponse({ boards: [] }));
    await expect(monday.readTemplates('222')).rejects.toThrow(/not found/);
  });
});

describe('updateStatus', () => {
  test('writes column values and verifies via read-back', async () => {
    let mutationVars = null;
    axios.post.mockImplementation(async (url, body) => {
      if (body.query.includes('change_multiple_column_values')) {
        mutationVars = body.variables;
        return gqlResponse({ change_multiple_column_values: { id: '555' } });
      }
      return gqlResponse({ items: [SAMPLE_ITEM] }); // verification read
    });

    const result = await monday.updateStatus('111', '555', {
      status: 'Generated',
      agreementId: 'AGR-42',
      pdfUrl: 'https://blob/pdf?sas',
    });

    expect(result.success).toBe(true);
    const written = JSON.parse(mutationVars.columnValues);
    expect(written.status).toEqual({ label: 'Generated' });
    expect(written.text_agreement).toBe('AGR-42');
    expect(written.link_pdf.url).toBe('https://blob/pdf?sas');
    expect(written.date_updated.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(axios.post).toHaveBeenCalledTimes(2); // mutation + verify read
  });

  test('skips read-back when verify is disabled', async () => {
    axios.post.mockResolvedValue(gqlResponse({ change_multiple_column_values: { id: '555' } }));
    await monday.updateStatus('111', '555', { status: 'Webhook Error' }, { verify: false });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('throws when the mutation returns no id', async () => {
    axios.post.mockResolvedValue(gqlResponse({ change_multiple_column_values: null }));
    await expect(
      monday.updateStatus('111', '555', { status: 'X' }, { verify: false })
    ).rejects.toThrow(/no id/);
  });
});

describe('createArchiveRow', () => {
  test('creates the archive item with composed name', async () => {
    let vars = null;
    axios.post.mockImplementation(async (url, body) => {
      vars = body.variables;
      return gqlResponse({ create_item: { id: '777' } });
    });
    const itemId = await monday.createArchiveRow('333', {
      employee: 'Jane Doe',
      docType: 'Offer Letter',
      signedDate: '2026-08-06T12:00:00Z',
      signers: [{ email: 'hr@medwatchers.com' }],
      pdfLink: 'https://blob/archive/555.pdf',
      agreementId: 'AGR-42',
    });
    expect(itemId).toBe('777');
    expect(vars.itemName).toBe('Jane Doe — Offer Letter');
    const cols = JSON.parse(vars.columnValues);
    expect(cols.text_agreement).toBe('AGR-42');
    expect(cols.link_signed.url).toBe('https://blob/archive/555.pdf');
  });

  test('throws when no archive board is configured', async () => {
    const saved = process.env.MONDAY_ARCHIVE_BOARD_ID;
    delete process.env.MONDAY_ARCHIVE_BOARD_ID;
    config.reset();
    try {
      await expect(monday.createArchiveRow(null, {})).rejects.toThrow(/no archive board/);
    } finally {
      process.env.MONDAY_ARCHIVE_BOARD_ID = saved;
      config.reset();
    }
  });
});

describe('rate limits and batching', () => {
  test('transient complexity errors are retried', async () => {
    let attempts = 0;
    axios.post.mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        return { data: { errors: [{ message: 'Complexity budget exhausted' }] } };
      }
      return gqlResponse({ items: [SAMPLE_ITEM] });
    });
    const row = await monday.readRow('111', '555');
    expect(attempts).toBe(2);
    expect(row.itemId).toBe('555');
  });

  test('non-transient GraphQL errors fail without retry', async () => {
    let attempts = 0;
    axios.post.mockImplementation(async () => {
      attempts++;
      return { data: { errors: [{ message: 'Column not found' }] } };
    });
    await expect(monday.readRow('111', '555')).rejects.toThrow(/Column not found/);
    expect(attempts).toBe(1);
  });

  test('readRows batches multiple items into one query', async () => {
    axios.post.mockResolvedValue(gqlResponse({
      items: [SAMPLE_ITEM, { ...SAMPLE_ITEM, id: '556', name: 'John Roe' }],
    }));
    const rows = await monday.readRows('111', ['555', '556']);
    expect(rows).toHaveLength(2);
    expect(axios.post).toHaveBeenCalledTimes(1); // batched, not per-item
    expect(rows[1].name).toBe('John Roe');
  });
});
