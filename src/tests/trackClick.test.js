'use strict';
/**
 * trackClick redirect tests: signed links 302 to allowlisted destinations
 * and post ONE card comment per (item, kind); bad signatures and
 * non-allowlisted hosts get 403 with no redirect; a Monday outage never
 * blocks the candidate. Fully offline via fakeEnv.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const { makeBackend, installRoutes } = require('./helpers/fakeEnv');

const config = require('../lib/config');
const monday = require('../lib/monday');
const { trackedLink, trackSignature } = require('../lib/util');

const trackClick = require('../functions/trackClick');

const SIGN_URL = 'https://secure.na2.adobesign.com/public/apiesign?aid=AGR-42';
const FORM_URL = 'https://forms.monday.com/forms/f4b5d1499c2dc94ed022a220a133fd51?name=Jane%20Doe';

function makeContext() {
  return { bindings: {}, bindingData: {}, res: null };
}

/** Build a req from a full tracked link produced by util.trackedLink. */
function reqFor(url) {
  const parsed = new URL(url);
  return { query: Object.fromEntries(parsed.searchParams.entries()) };
}

function clickComments(backend, needle) {
  return backend.updates.filter((u) => u.body.includes(needle));
}

let backend;

beforeEach(() => {
  jest.clearAllMocks();
  config.reset();
  monday._resetState();
  backend = makeBackend();
  installRoutes(axios, backend);
});

describe('trackClick — signed redirect + first-click card comment', () => {
  test('valid sig, allowlisted host: 302 to the target and one comment; second click adds none', async () => {
    const link = trackedLink('555', 'sign', SIGN_URL);
    expect(link).toContain('/api/trackClick?');

    const ctx1 = makeContext();
    await trackClick(ctx1, reqFor(link));
    expect(ctx1.res.status).toBe(302);
    expect(ctx1.res.headers.Location).toBe(SIGN_URL);
    expect(clickComments(backend, 'clicked the signing link')).toHaveLength(1);
    expect(clickComments(backend, 'clicked the signing link')[0].body).toContain('◆ DocFlow · 8 of 10');

    const ctx2 = makeContext();
    await trackClick(ctx2, reqFor(link));
    expect(ctx2.res.status).toBe(302);
    expect(ctx2.res.headers.Location).toBe(SIGN_URL);
    expect(clickComments(backend, 'clicked the signing link')).toHaveLength(1); // deduped
  });

  test('form kind: 302 + its own comment, independent of the sign click', async () => {
    await trackClick(makeContext(), reqFor(trackedLink('555', 'sign', SIGN_URL)));
    const ctx = makeContext();
    await trackClick(ctx, reqFor(trackedLink('555', 'form', FORM_URL)));
    expect(ctx.res.status).toBe(302);
    expect(ctx.res.headers.Location).toBe(FORM_URL);
    expect(clickComments(backend, 'clicked the info form link')).toHaveLength(1);
  });

  test('bad signature: 403, no redirect, no comment', async () => {
    const req = reqFor(trackedLink('555', 'sign', SIGN_URL));
    req.query.s = 'deadbeef'.repeat(8); // wrong sig, right length shape
    const ctx = makeContext();
    await trackClick(ctx, req);
    expect(ctx.res.status).toBe(403);
    expect(ctx.res.headers).toBeUndefined();
    expect(backend.updates).toHaveLength(0);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('valid sig but non-allowlisted host: 403 (no open redirect)', async () => {
    const evil = 'https://evil.example.net/phish';
    const u = Buffer.from(evil, 'utf8').toString('base64url');
    const s = trackSignature(config.load().tracking.secret, '555', 'sign', u);
    const ctx = makeContext();
    await trackClick(ctx, { query: { i: '555', k: 'sign', u, s } });
    expect(ctx.res.status).toBe(403);
    expect(backend.updates).toHaveLength(0);
  });

  test('http (not https) target: 403 even on an allowlisted host', async () => {
    const insecure = 'http://www.medwatchers.com/welcome';
    const u = Buffer.from(insecure, 'utf8').toString('base64url');
    const s = trackSignature(config.load().tracking.secret, '555', 'sign', u);
    const ctx = makeContext();
    await trackClick(ctx, { query: { i: '555', k: 'sign', u, s } });
    expect(ctx.res.status).toBe(403);
  });

  test('missing params: 403', async () => {
    const ctx = makeContext();
    await trackClick(ctx, { query: { i: '555', k: 'sign' } });
    expect(ctx.res.status).toBe(403);
  });

  test('Monday down: comment attempt fails, candidate still gets the 302', async () => {
    axios.post.mockImplementation(async (url) => {
      if (String(url).includes('api.monday.com')) throw new Error('monday is down');
      throw new Error(`unexpected POST ${url}`);
    });
    const ctx = makeContext();
    await trackClick(ctx, reqFor(trackedLink('555', 'sign', SIGN_URL)));
    expect(ctx.res.status).toBe(302);
    expect(ctx.res.headers.Location).toBe(SIGN_URL);
  });
});
