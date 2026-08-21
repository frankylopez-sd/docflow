'use strict';
/**
 * One-front-door email tests: the candidate package carries the DIRECT Adobe
 * signing link (sent automatically when Graph mail is armed, draft comment
 * otherwise), and completion sends the congrats email with the signed PDF
 * attached. Fully offline via fakeEnv.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());
jest.mock('@azure/identity', () => ({ DefaultAzureCredential: class DefaultAzureCredential {} }));

const axios = require('axios');
const storageMock = require('@azure/storage-blob');
const { SIGNED_BYTES, makeBackend, installRoutes } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const adobe = require('../lib/adobe');
const monday = require('../lib/monday');
const blob = require('../lib/blob');
const mailer = require('../lib/mailer');

const sendForSign = require('../functions/sendForSign');
const archiveToBlob = require('../functions/archiveToBlob');

const GRAPH_ENV = ['GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'MAIL_SENDER'];
const ESIGN_URL = 'https://secure.na2.adobesign.com/public/apiesign?aid=AGR-42';

function armGraphMail() {
  process.env.GRAPH_CLIENT_ID = 'app-123';
  process.env.GRAPH_CLIENT_SECRET = 'secret-456';
  process.env.MAIL_SENDER = 'onboarding@medwatchers.com';
  config.reset();
}

function makeContext() {
  return { bindings: {}, bindingData: {}, res: null };
}

function signQueueItem() {
  return {
    boardId: '111',
    itemId: '555',
    pdfUrl: 'https://fake.blob.core.windows.net/pdf-temp/offer-555.pdf',
    firstName: 'Jane',
    lastName: 'Doe',
    workEmail: 'jane@medwatchers.com',
  };
}

function graphSendCalls() {
  return axios.post.mock.calls.filter(([url]) => String(url).includes('/sendMail'));
}

let backend;

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of GRAPH_ENV) delete process.env[k];
  storageMock.__reset();
  config.reset();
  adobe._resetState();
  monday._resetState();
  blob._resetState();
  mailer._resetTokenCache();
  backend = makeBackend();
  installRoutes(axios, backend);
});

afterAll(() => {
  for (const k of GRAPH_ENV) delete process.env[k];
  config.reset();
});

describe('candidate package — two gates: prep drafts, send delivers', () => {
  test('GATE 1 (prep): posts the real email as a draft and sends NOTHING, even armed', async () => {
    armGraphMail(); // armed on purpose: prep must still not send
    await sendForSign(makeContext(), signQueueItem());

    const pkg = backend.updates.find((u) => u.body.includes('THE EXACT EMAIL'));
    expect(pkg).toBeDefined();
    expect(pkg.body).toContain('Nothing has been sent yet');
    expect(pkg.body).toContain(ESIGN_URL);
    expect(pkg.body).toContain('Fill out your info form');
    expect(graphSendCalls()).toHaveLength(0);
  });

  test('GATE 2 (send): armed, emails the candidate with the signing link inside', async () => {
    armGraphMail();
    await sendForSign(makeContext(), signQueueItem()); // gate 1 builds the packet
    await sendForSign(makeContext(), { ...signQueueItem(), mode: 'send' });

    const sends = graphSendCalls();
    expect(sends).toHaveLength(1);
    const [, payload] = sends[0];
    expect(payload.message.toRecipients[0].emailAddress.address).toBe('jane@medwatchers.com');
    expect(payload.message.body.content).toContain(ESIGN_URL);

    const pkg = backend.updates.find((u) => u.body.includes('Sent!'));
    expect(pkg.body).toContain('went to jane@medwatchers.com');
  });

  test('GATE 2 with no signing URL from Adobe: still sends, with fallback wording', async () => {
    armGraphMail();
    installRoutes(axios, backend, { noSigningUrl: true });
    await sendForSign(makeContext(), signQueueItem());
    await sendForSign(makeContext(), { ...signQueueItem(), mode: 'send' });

    const sends = graphSendCalls();
    expect(sends).toHaveLength(1);
    const [, payload] = sends[0];
    expect(payload.message.body.content).toContain('signing link pending');
    expect(payload.message.body.content).not.toContain('{{signLink}}');
  });
});

describe('completion — congrats email with the signed copy attached', () => {
  test('armed: sends the congrats email with the signed PDF as an attachment', async () => {
    armGraphMail();
    await archiveToBlob(makeContext(), {
      agreementId: 'AGR-42', boardId: '111', itemId: '555', firstName: 'Jane', lastName: 'Doe',
    });

    const sends = graphSendCalls();
    expect(sends).toHaveLength(1);
    const [, payload] = sends[0];
    expect(payload.message.toRecipients[0].emailAddress.address).toBe('jane@medwatchers.com');
    expect(payload.message.attachments).toHaveLength(1);
    expect(payload.message.attachments[0].name).toMatch(/^MedWatchers-signed-offer-.*\.pdf$/);
    expect(payload.message.attachments[0].contentBytes).toBe(SIGNED_BYTES.toString('base64'));

    const receipt = backend.updates.find((u) => u.body.includes('Confirmation sent'));
    expect(receipt).toBeDefined();
  });

  test('unarmed: archive completes with no congrats email attempt', async () => {
    await archiveToBlob(makeContext(), {
      agreementId: 'AGR-42', boardId: '111', itemId: '555', firstName: 'Jane', lastName: 'Doe',
    });
    expect(graphSendCalls()).toHaveLength(0);
    const done = backend.updates.find((u) => u.body.includes('Signed and filed'));
    expect(done).toBeDefined();
  });
});
