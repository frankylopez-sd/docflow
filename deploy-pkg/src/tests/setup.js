'use strict';
// Jest global setup: offline test env. No real endpoints, tokens or accounts.

process.env.ENVIRONMENT = 'test';
process.env.DOCFLOW_LOG_SILENT = 'true';
process.env.DOCFLOW_RETRY_BASE_MS = '1';
process.env.DOCFLOW_ADOBE_POLL_MS = '1';

process.env.ADOBE_CLIENT_ID = 'test-client-id';
process.env.ADOBE_CLIENT_SECRET = 'test-client-secret';
process.env.ADOBE_SIGN_API_URL = 'https://api.test.adobesign.com';
process.env.ADOBE_SIGN_INTEGRATION_KEY = 'test-integration-key';
process.env.ADOBE_WEBHOOK_URL = 'https://docflow.test/api/adobeWebhook';

process.env.MONDAY_API_TOKEN = 'test-monday-token';
process.env.MONDAY_API_URL = 'https://api.monday.com/v2';
process.env.MONDAY_ONBOARDING_BOARD_ID = '111';
process.env.MONDAY_TEMPLATE_CATALOG_ID = '222';
process.env.MONDAY_ARCHIVE_BOARD_ID = '333';
process.env.MONDAY_SIGNING_SECRET = 'test-signing-secret';

process.env.STORAGE_ACCOUNT_NAME = 'teststore';
process.env.STORAGE_ACCOUNT_KEY = 'dGVzdC1hY2NvdW50LWtleQ==';
delete process.env.STORAGE_ACCOUNT_NAME_SECONDARY;
delete process.env.STORAGE_ACCOUNT_KEY_SECONDARY;
delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
