'use strict';
/** Unit tests: Graph mailer + team-editable email templates. Axios mocked. */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const config = require('../lib/config');
const mailer = require('../lib/mailer');
const monday = require('../lib/monday');

const GRAPH_ENV = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'MAIL_SENDER'];

function armGraphMail() {
  process.env.GRAPH_CLIENT_ID = 'app-123';
  process.env.GRAPH_CLIENT_SECRET = 'secret-456';
  process.env.MAIL_SENDER = 'onboarding@medwatchers.com';
  config.reset();
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of GRAPH_ENV) delete process.env[k];
  config.reset();
  mailer._resetTokenCache();
  monday._resetState();
});

afterAll(() => {
  for (const k of GRAPH_ENV) delete process.env[k];
  config.reset();
});

describe('renderTemplate', () => {
  test('fills placeholders from data', () => {
    expect(mailer.renderTemplate('Hi {{firstName}}, see {{formLink}}', { firstName: 'Rita', formLink: 'https://x' }))
      .toBe('Hi Rita, see https://x');
  });

  test('tolerates spaces inside the braces', () => {
    expect(mailer.renderTemplate('Hi {{ firstName }}', { firstName: 'Rita' })).toBe('Hi Rita');
  });

  test('leaves unknown or empty placeholders visible instead of blanking them', () => {
    expect(mailer.renderTemplate('Hi {{nope}} and {{empty}}', { empty: '' })).toBe('Hi {{nope}} and {{empty}}');
  });
});

describe('renderHtml branding', () => {
  test('wraps the text in the MedWatchers shell and linkifies URLs', () => {
    const html = mailer.renderHtml('Hi Rita,\nSign here: https://sign.example/x?y=1');
    expect(html).toContain('MedWatchers');
    expect(html).toContain('#0066ff'); // brand blue (medwatchers.com --primary500)
    expect(html).toContain('Medwatchers_Logo_Primary'); // site logo in header
    expect(html).toContain('<a href="https://sign.example/x?y=1"');
    expect(html).toContain('Hi Rita,<br>');
  });

  test('a standalone-URL line becomes a brand-colored button', () => {
    const html = mailer.wrapBrandedHtml({
      bodyText: 'Sign your packet:\n\nhttps://sign.example/agreement/abc\n\nThanks!',
      preheader: 'Welcome aboard',
    });
    expect(html).toContain('href="https://sign.example/agreement/abc"');
    expect(html).toContain(`bgcolor="${mailer.BRAND.primary}"`); // bulletproof button
    expect(html).toContain('Welcome aboard'); // preheader present
    expect(html).toContain('MedwatchersHR@medwatchers.com'); // footer contact
  });

  test('escapes HTML in the team-edited text (no injection into the shell)', () => {
    const html = mailer.renderHtml('<script>alert(1)</script> & "quotes"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; &quot;quotes&quot;');
  });
});

describe('sendMail', () => {
  test('is a safe no-op when Graph mail is not configured', async () => {
    expect(mailer.isConfigured()).toBe(false);
    const result = await mailer.sendMail({ to: 'a@b.com', subject: 's', body: 'b' });
    expect(result.sent).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects an invalid recipient without calling Graph', async () => {
    armGraphMail();
    const result = await mailer.sendMail({ to: 'not-an-email', subject: 's', body: 'b' });
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/invalid recipient/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('mints a token and sends as the configured mailbox', async () => {
    armGraphMail();
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'tok-1', expires_in: 3600 } })
      .mockResolvedValueOnce({ status: 202, data: {} });

    const result = await mailer.sendMail({ to: 'rita@gmail.com', subject: 'Welcome!', body: 'Hi Rita' });
    expect(result.sent).toBe(true);

    const [tokenUrl, tokenBody] = axios.post.mock.calls[0];
    expect(tokenUrl).toContain('login.microsoftonline.com');
    expect(tokenUrl).toContain('80edf08e-c174-4cee-901d-ad05e88456c1'); // MW tenant default
    expect(String(tokenBody)).toContain('client_credentials');

    const [sendUrl, sendPayload, sendCfg] = axios.post.mock.calls[1];
    expect(sendUrl).toBe('https://graph.microsoft.com/v1.0/users/onboarding%40medwatchers.com/sendMail');
    expect(sendPayload.message.subject).toBe('Welcome!');
    expect(sendPayload.message.body.contentType).toBe('HTML');
    expect(sendPayload.message.body.content).toContain('MedWatchers');
    expect(sendPayload.message.body.content).toContain('Hi Rita');
    expect(sendPayload.message.toRecipients[0].emailAddress.address).toBe('rita@gmail.com');
    expect(sendPayload.saveToSentItems).toBe(true);
    expect(sendCfg.headers.Authorization).toBe('Bearer tok-1');
  });

  test('reuses the cached token across sends', async () => {
    armGraphMail();
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'tok-1', expires_in: 3600 } })
      .mockResolvedValue({ status: 202, data: {} });

    await mailer.sendMail({ to: 'a@b.com', subject: '1', body: 'x' });
    await mailer.sendMail({ to: 'c@d.com', subject: '2', body: 'y' });

    const tokenCalls = axios.post.mock.calls.filter(([url]) => url.includes('login.microsoftonline.com'));
    expect(tokenCalls).toHaveLength(1);
  });
});

describe('getEmailTemplate', () => {
  const cols = () => config.load().monday.emailTemplates.columns;

  function templateBoardResponse(rows) {
    return {
      data: {
        data: {
          boards: [{
            items_page: {
              items: rows.map((r, i) => ({
                id: String(100 + i),
                column_values: [
                  { id: cols().key, text: r.key, value: null },
                  { id: cols().subject, text: r.subject, value: null },
                  { id: cols().body, text: r.body, value: null },
                  { id: cols().active, text: '', value: JSON.stringify({ checked: r.active ? 'true' : false }) },
                ],
              })),
            },
          }],
        },
      },
    };
  }

  test('returns the Active row matching the key', async () => {
    axios.post.mockResolvedValue(templateBoardResponse([
      { key: 'welcome', subject: 'Welcome {{firstName}}!', body: 'Hi {{firstName}}', active: true },
      { key: 'package', subject: 'Offer!', body: 'Body', active: true },
    ]));
    const tpl = await monday.getEmailTemplate('welcome');
    expect(tpl).toEqual({ subject: 'Welcome {{firstName}}!', body: 'Hi {{firstName}}' });
  });

  test('returns null when the row is unchecked (falls back to built-in wording)', async () => {
    axios.post.mockResolvedValue(templateBoardResponse([
      { key: 'welcome', subject: 'S', body: 'B', active: false },
    ]));
    expect(await monday.getEmailTemplate('welcome')).toBeNull();
  });

  test('returns null when no row matches the key', async () => {
    axios.post.mockResolvedValue(templateBoardResponse([
      { key: 'package', subject: 'S', body: 'B', active: true },
    ]));
    expect(await monday.getEmailTemplate('welcome')).toBeNull();
  });

  test('caches the template so repeat sends do not re-read the board', async () => {
    axios.post.mockResolvedValue(templateBoardResponse([
      { key: 'welcome', subject: 'S', body: 'B', active: true },
    ]));
    await monday.getEmailTemplate('welcome');
    await monday.getEmailTemplate('welcome');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
