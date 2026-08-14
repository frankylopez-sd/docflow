'use strict';
/** health: GET /api/health -> 200. Used by deploy verification + uptime checks. */

const config = require('../../lib/config');

module.exports = async function (context) {
  let configOk = true;
  try {
    config.load();
  } catch (_) {
    configOk = false; // still 200 — the app is up; config state is reported
  }
  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      status: 'ok',
      configLoaded: configOk,
      environment: process.env.ENVIRONMENT || 'unknown',
      timestamp: new Date().toISOString(),
    },
  };
};
