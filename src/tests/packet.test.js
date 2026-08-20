'use strict';
/**
 * Signing-packet tests: catalog rows typed "Packet Document" + Active ride in
 * the same Adobe agreement behind the custom offer letter — one signing
 * session, one combined signed PDF. Fully offline via fakeEnv.
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

const sendForSign = require('../functions/sendForSign');

const CONSENT_BYTES = Buffer.from('%PDF-1.7 background-consent');
const POLICIES_BYTES = Buffer.from('%PDF-1.7 policies-procedures');

let backend;

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

function packetRow(id, name, { active, order, hasFile = true }) {
  const tf = config.load().monday.templateFiles;
  return {
    id,
    name,
    column_values: [
      { id: tf.typeColumn, text: 'Packet Document', value: null },
      { id: tf.activeColumn, text: active ? 'v' : '', value: JSON.stringify({ checked: active ? 'true' : false }) },
      { id: tf.orderColumn, text: String(order), value: JSON.stringify(String(order)) },
    ],
    assets: hasFile
      ? [{ id: `asset-${id}`, public_url: `https://files.monday.com/${id}.pdf`, created_at: '2026-08-19T00:00:00Z' }]
      : [],
  };
}

/** Route the packet-files catalog query; delegate everything else. */
function installPacketCatalog(rows) {
  const tf = config.load().monday.templateFiles;
  const orig = backend.handle;
  backend.handle = (body) => {
    if (body.query.includes(tf.typeColumn)) {
      return { data: { data: { boards: [{ items_page: { items: rows } }] } } };
    }
    return orig(body);
  };
  const prevGet = axios.get.getMockImplementation();
  axios.get.mockImplementation(async (url, cfg) => {
    if (String(url).includes('files.monday.com/p-consent')) return { data: CONSENT_BYTES };
    if (String(url).includes('files.monday.com/p-policies')) return { data: POLICIES_BYTES };
    return prevGet(url, cfg);
  });
}

function agreementCalls() {
  return axios.post.mock.calls.filter(([url]) =>
    String(url).includes('/api/rest/v6/agreements') && !String(url).includes('/webhooks'));
}

function transientCalls() {
  return axios.post.mock.calls.filter(([url]) => String(url).includes('/transientDocuments'));
}

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

describe('signing packet', () => {
  test('active packet documents ride in the same agreement, in order, behind the offer', async () => {
    installPacketCatalog([
      // deliberately out of order + one inactive + one with no file yet
      packetRow('p-policies', 'Policies & Procedures — drop the PDF in Template File, check Active to include', { active: true, order: 2 }),
      packetRow('p-consent', 'Background Check Consent — drop the PDF in Template File, check Active to include', { active: true, order: 1 }),
      packetRow('p-inactive', 'Old Handbook — retired', { active: false, order: 3 }),
      packetRow('p-nofile', 'Empty Row', { active: true, order: 4, hasFile: false }),
    ]);

    await sendForSign(makeContext(), signQueueItem());

    // offer + consent + policies = 3 uploads, 3 fileInfos
    expect(transientCalls()).toHaveLength(3);
    const [, agreementBody] = agreementCalls()[0];
    expect(agreementBody.fileInfos).toHaveLength(3);
    expect(agreementBody.name).toBe('Hire Packet - Jane Doe');

    const outComment = backend.updates.find((u) => u.body.includes('Packet built'));
    expect(outComment.body).toContain('nothing has been sent yet');
    expect(outComment.body).toContain('1. Offer Letter (custom for Jane)');
    expect(outComment.body).toContain('2. Background Check Consent');
    expect(outComment.body).toContain('3. Policies & Procedures');
  });

  test('empty catalog keeps the plain single-document offer send', async () => {
    await sendForSign(makeContext(), signQueueItem());

    expect(transientCalls()).toHaveLength(1);
    const [, agreementBody] = agreementCalls()[0];
    expect(agreementBody.fileInfos).toHaveLength(1);
    expect(agreementBody.name).toBe('Offer Letter - Jane Doe');

    const outComment = backend.updates.find((u) => u.body.includes('Packet built'));
    expect(outComment.body).toContain('nothing has been sent yet');
    expect(outComment.body).not.toContain('In the packet');
  });
});
