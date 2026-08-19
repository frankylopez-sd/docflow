'use strict';
/**
 * Central config/secrets loader.
 * Local: reads .env via dotenv. Azure: App Settings (secrets arrive through
 * Key Vault references resolved by the platform, so code only reads env).
 */

let _cache = null;

const REQUIRED = [
  'ADOBE_CLIENT_ID',
  'ADOBE_CLIENT_SECRET',
  'ADOBE_SIGN_API_URL',
  'MONDAY_API_TOKEN',
  'MONDAY_ONBOARDING_BOARD_ID',
  'MONDAY_TEMPLATE_CATALOG_ID',
  'STORAGE_ACCOUNT_NAME',
];

function _int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function load(options = {}) {
  const { force = false, strict = true } = options;
  if (_cache && !force) return _cache;

  // dotenv is a no-op when no .env file exists (Azure).
  try { require('dotenv').config(); } catch (_) { /* optional in prod */ }

  const env = process.env;

  const missing = REQUIRED.filter((k) => !env[k] || String(env[k]).trim() === '');
  if (strict && missing.length > 0) {
    throw new Error(`Config validation failed. Missing required settings: ${missing.join(', ')}`);
  }

  const cfg = {
    environment: env.ENVIRONMENT || 'local',

    adobe: {
      clientId: env.ADOBE_CLIENT_ID,
      clientSecret: env.ADOBE_CLIENT_SECRET,
      // base64-encoded JWT credentials file (legacy auth path), decoded here
      jwt: env.ADOBE_JWT_FILE
        ? Buffer.from(env.ADOBE_JWT_FILE, 'base64').toString('utf8')
        : null,
      imsUrl: env.ADOBE_IMS_URL || 'https://ims-na1.adobelogin.com',
      pdfServicesUrl: env.ADOBE_PDF_SERVICES_URL || 'https://pdf-services.adobe.io',
      signApiUrl: env.ADOBE_SIGN_API_URL,
      signIntegrationKey: env.ADOBE_SIGN_INTEGRATION_KEY || null,
      signRefreshToken: env.ADOBE_SIGN_REFRESH_TOKEN || null,
      webhookUrl: env.ADOBE_WEBHOOK_URL || null,
      rateLimitPerMin: _int(env.DOCFLOW_ADOBE_RATE_LIMIT_PER_MIN, 500),
    },

    monday: {
      token: env.MONDAY_API_TOKEN,
      apiUrl: env.MONDAY_API_URL || 'https://api.monday.com/v2',
      onboardingBoardId: env.MONDAY_ONBOARDING_BOARD_ID,
      templateCatalogId: env.MONDAY_TEMPLATE_CATALOG_ID,
      archiveBoardId: env.MONDAY_ARCHIVE_BOARD_ID || null,
      signingSecret: env.MONDAY_SIGNING_SECRET || null,
      rateLimitPerSec: _int(env.DOCFLOW_MONDAY_RATE_LIMIT_PER_SEC, 10),
      columns: {
        status: env.MONDAY_COL_STATUS || 'status',
        agreementId: env.MONDAY_COL_AGREEMENT_ID || 'text_agreement',
        pdfUrl: env.MONDAY_COL_PDF_URL || 'link_pdf',
        signedPdfUrl: env.MONDAY_COL_SIGNED_PDF_URL || 'link_signed',
        signerDetails: env.MONDAY_COL_SIGNER_DETAILS || 'long_text_signers',
        timestamp: env.MONDAY_COL_TIMESTAMP || 'date_updated',
        email: env.MONDAY_COL_EMAIL || 'email',
        startDate: env.MONDAY_COL_START_DATE || 'date_start',
        position: env.MONDAY_COL_POSITION || 'text_position',
        manager: env.MONDAY_COL_MANAGER || 'text_manager',
        template: env.MONDAY_COL_TEMPLATE || 'text_template',
        trigger: env.MONDAY_COL_TRIGGER || 'checkbox',
        // Hire-record fields on the Onboarding board (defaults = live board 18422046530)
        firstName: env.MONDAY_COL_FIRST_NAME || 'text_mm6570q4',
        lastName: env.MONDAY_COL_LAST_NAME || 'text_mm65jrfy',
        workEmail: env.MONDAY_COL_WORK_EMAIL || 'text_mm65hxkh',
        jobTitle: env.MONDAY_COL_JOB_TITLE || 'dropdown_mm65th43',
        department: env.MONDAY_COL_DEPARTMENT || 'dropdown_mm658qx8',
        supervisorName: env.MONDAY_COL_SUPERVISOR_NAME || 'dropdown_mm65wk46',
        payRate: env.MONDAY_COL_PAY_RATE || 'numeric_mm65mx3m',
        payFrequency: env.MONDAY_COL_PAY_FREQUENCY || 'dropdown_mm658n1t',
        payClass: env.MONDAY_COL_PAY_CLASS || 'dropdown_mm65aswt',
        flsaStatus: env.MONDAY_COL_FLSA_STATUS || 'dropdown_mm6576ra',
        workerType: env.MONDAY_COL_WORKER_TYPE || 'dropdown_mm65jpby',
        // Offer lifecycle column (HR review gate) and its label vocabulary
        offerStatus: env.MONDAY_COL_OFFER_STATUS || 'color_mm63ewwy',
      },
      offerLabels: {
        generating: env.MONDAY_OFFER_LABEL_GENERATING || 'Offer Generating',
        ready: env.MONDAY_OFFER_LABEL_READY || 'Offer Ready',
        approved: env.MONDAY_OFFER_LABEL_APPROVED || 'Packaged Approved',
        sent: env.MONDAY_OFFER_LABEL_SENT || 'Offer Sent',
      },
      // Downstream kickoff: Background Checks board (created when onboarding completes)
      backgroundCheck: {
        boardId: env.MONDAY_BG_CHECK_BOARD_ID || '18422046606',
        groupId: env.MONDAY_BG_CHECK_GROUP_ID || 'topics',
        columns: {
          candidate: env.MONDAY_BG_COL_CANDIDATE || 'text_mm58pfqv',
          status: env.MONDAY_BG_COL_STATUS || 'color_mm58kpeb',
          priority: env.MONDAY_BG_COL_PRIORITY || 'color_mm58mdte',
          checkType: env.MONDAY_BG_COL_CHECK_TYPE || 'dropdown_mm58eqat',
        },
        // Relation column ON THE ONBOARDING BOARD linking hire -> background check
        hireRelationColumn: env.MONDAY_COL_BG_RELATION || 'board_relation_mm5btrgq',
      },
    },

    storage: {
      accountName: env.STORAGE_ACCOUNT_NAME,
      accountKey: env.STORAGE_ACCOUNT_KEY || null,
      secondaryAccountName: env.STORAGE_ACCOUNT_NAME_SECONDARY || null,
      secondaryAccountKey: env.STORAGE_ACCOUNT_KEY_SECONDARY || null,
      tempContainer: env.BLOB_TEMP_CONTAINER || 'pdf-temp',
      archiveContainer: env.BLOB_ARCHIVE_CONTAINER || 'pdf-archive',
    },

    sharepoint: {
      siteUrl: env.SHAREPOINT_SITE_URL || null,
      siteId: env.SHAREPOINT_SITE_ID || null,
      driveId: env.SHAREPOINT_DRIVE_ID || null,
      tenantId: env.SHAREPOINT_TENANT_ID || null,
      clientId: env.SHAREPOINT_CLIENT_ID || null,
      clientSecret: env.SHAREPOINT_CLIENT_SECRET || null,
      enabled: env.SHAREPOINT_ENABLED === 'true' || env.SHAREPOINT_ENABLED === '1',
    },

    retryBaseMs: _int(env.DOCFLOW_RETRY_BASE_MS, 500),
    tempMaxAgeHours: _int(env.DOCFLOW_TEMP_MAX_AGE_HOURS, 168),
    webhookRateLimitThreshold: _int(env.DOCFLOW_QUEUE_RATE_LIMIT_THRESHOLD, 1000),
  };

  _cache = cfg;
  return cfg;
}

/** Test/hot-reload helper: drop the cached config so env changes are re-read. */
function reset() {
  _cache = null;
}

module.exports = { load, reset, REQUIRED };
