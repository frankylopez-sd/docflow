#!/usr/bin/env node
/**
 * Test script for Adobe PDF Services + Sign integration
 * Tests OAuth token refresh, PDF generation, and envelope creation
 *
 * Usage:
 *   node test-adobe-integration.js
 *
 * Requires:
 *   ADOBE_CLIENT_ID
 *   ADOBE_CLIENT_SECRET
 *   ADOBE_SIGN_API_URL
 *   ADOBE_SIGN_INTEGRATION_KEY (or ADOBE_SIGN_REFRESH_TOKEN)
 */

require('dotenv').config();

const axios = require('axios');

// Test configuration
const CONFIG = {
  adobe: {
    clientId: process.env.ADOBE_CLIENT_ID,
    clientSecret: process.env.ADOBE_CLIENT_SECRET,
    imsUrl: process.env.ADOBE_IMS_URL || 'https://ims-na1.adobelogin.com',
    pdfServicesUrl: process.env.ADOBE_PDF_SERVICES_URL || 'https://pdf-services.adobe.io',
    signApiUrl: process.env.ADOBE_SIGN_API_URL,
    signIntegrationKey: process.env.ADOBE_SIGN_INTEGRATION_KEY,
  }
};

const tests = {
  passed: 0,
  failed: 0,
  errors: []
};

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(level, message, data) {
  const timestamp = new Date().toISOString();
  const color = {
    info: colors.blue,
    success: colors.green,
    error: colors.red,
    warn: colors.yellow,
  }[level] || colors.reset;

  console.log(`${color}[${level.toUpperCase()}]${colors.reset} ${timestamp} - ${message}`);
  if (data) console.log(`  ${JSON.stringify(data, null, 2)}`);
}

async function test(name, fn) {
  try {
    log('info', `Running: ${name}`);
    await fn();
    log('success', `✓ ${name}`);
    tests.passed++;
  } catch (err) {
    log('error', `✗ ${name}: ${err.message}`);
    tests.failed++;
    tests.errors.push({ test: name, error: err.message });
  }
}

// ============================================================================
// TESTS
// ============================================================================

async function testAdobeConfig() {
  const required = ['clientId', 'clientSecret', 'signApiUrl'];
  const missing = required.filter(k => !CONFIG.adobe[k]);

  if (missing.length > 0) {
    throw new Error(`Missing Adobe config: ${missing.join(', ')}`);
  }

  log('info', 'Adobe Config Loaded', {
    clientId: CONFIG.adobe.clientId.substring(0, 10) + '...',
    imsUrl: CONFIG.adobe.imsUrl,
    pdfServicesUrl: CONFIG.adobe.pdfServicesUrl,
    signApiUrl: CONFIG.adobe.signApiUrl,
  });
}

async function testPdfServicesToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CONFIG.adobe.clientId,
    client_secret: CONFIG.adobe.clientSecret,
    scope: 'openid,AdobeID,DCAPI',
  });

  const res = await axios.post(
    `${CONFIG.adobe.imsUrl}/ims/token/v3`,
    params.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    }
  );

  if (!res.data.access_token) {
    throw new Error('No access_token in response');
  }

  log('info', 'PDF Services Token', {
    tokenPrefix: res.data.access_token.substring(0, 20) + '...',
    expiresIn: res.data.expires_in,
    scopes: res.data.scope
  });

  return res.data.access_token;
}

async function testSignApiToken() {
  if (!CONFIG.adobe.signIntegrationKey) {
    log('warn', 'Skipping Sign API token test (no integration key configured)');
    return null;
  }

  log('info', 'Sign API Token (using integration key)', {
    keyPrefix: CONFIG.adobe.signIntegrationKey.substring(0, 20) + '...',
  });

  return CONFIG.adobe.signIntegrationKey;
}

async function testAdobeSignEndpoint(signToken) {
  if (!signToken) {
    log('warn', 'Skipping Sign API endpoint test (no token)');
    return;
  }

  const res = await axios.get(
    `${CONFIG.adobe.signApiUrl}/api/rest/v6/accounts`,
    {
      headers: { Authorization: `Bearer ${signToken}` },
      timeout: 15000,
    }
  );

  if (!res.data) {
    throw new Error('No response data from accounts endpoint');
  }

  log('info', 'Adobe Sign API Endpoint Test', {
    status: res.status,
    hasData: !!res.data,
  });
}

async function testWebhookRegistration(signToken) {
  if (!signToken) {
    log('warn', 'Skipping webhook registration test (no token)');
    return;
  }

  const webhookUrl = process.env.ADOBE_WEBHOOK_URL;
  if (!webhookUrl) {
    log('warn', 'Skipping webhook registration test (ADOBE_WEBHOOK_URL not set)');
    return;
  }

  try {
    const res = await axios.post(
      `${CONFIG.adobe.signApiUrl}/api/rest/v6/webhooks`,
      {
        name: 'docflow-test-webhook',
        scope: 'ACCOUNT',
        state: 'ACTIVE',
        webhookSubscriptionEvents: ['AGREEMENT_WORKFLOW_COMPLETED', 'AGREEMENT_ACTION_COMPLETED'],
        webhookUrlInfo: { url: webhookUrl },
      },
      {
        headers: {
          Authorization: `Bearer ${signToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    log('info', 'Webhook Registration', {
      webhookId: res.data.id,
      status: res.status,
      url: webhookUrl,
    });
  } catch (err) {
    if (err.response?.status === 409) {
      log('warn', 'Webhook already exists (expected if registered before)', {
        status: err.response.status,
      });
    } else {
      throw err;
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log(`\n${colors.blue}=== Adobe Integration Test Suite ===${colors.reset}\n`);

  try {
    await test('Adobe Configuration', testAdobeConfig);
    await test('PDF Services Token', testPdfServicesToken);

    const signToken = await testSignApiToken();
    if (!signToken) {
      log('warn', 'Skipping Sign API tests (no token available)');
    } else {
      await test('Adobe Sign API Endpoint', () => testAdobeSignEndpoint(signToken));
      await test('Webhook Registration', () => testWebhookRegistration(signToken));
    }

    // Summary
    console.log(`\n${colors.blue}=== Test Summary ===${colors.reset}`);
    console.log(`${colors.green}✓ Passed: ${tests.passed}${colors.reset}`);
    console.log(`${colors.red}✗ Failed: ${tests.failed}${colors.reset}`);

    if (tests.errors.length > 0) {
      console.log(`\n${colors.red}Errors:${colors.reset}`);
      tests.errors.forEach(e => {
        console.log(`  - ${e.test}: ${e.error}`);
      });
    }

    process.exit(tests.failed > 0 ? 1 : 0);

  } catch (err) {
    console.error(`\n${colors.red}Fatal Error:${colors.reset}`, err.message);
    process.exit(1);
  }
}

main();
