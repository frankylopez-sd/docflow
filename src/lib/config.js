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
      // Adobe Sign OAuth app (distinct from the PDF Services project creds)
      signClientId: env.ADOBE_SIGN_CLIENT_ID || null,
      signClientSecret: env.ADOBE_SIGN_CLIENT_SECRET || null,
      webhookUrl: env.ADOBE_WEBHOOK_URL || null,
      // Default true: DocFlow owns all candidate email; Adobe sends nothing.
      suppressAdobeEmails: env.ADOBE_SUPPRESS_EMAILS !== 'false',
      // 'candidate' = only the new hire signs (Adobe emails them directly);
      // 'serial3' = HR -> Manager -> Employee chain
      signMode: env.ADOBE_SIGN_MODE || 'candidate',
      rateLimitPerMin: _int(env.DOCFLOW_ADOBE_RATE_LIMIT_PER_MIN, 500),
    },

    // Microsoft Graph mail (auto-send as a MedWatchers mailbox). Optional:
    // until clientId + clientSecret + sender exist in app settings, the
    // system posts ready-to-send draft comments instead (pre-email behavior).
    graphMail: {
      tenantId: env.GRAPH_TENANT_ID || '80edf08e-c174-4cee-901d-ad05e88456c1',
      clientId: env.GRAPH_CLIENT_ID || null,
      clientSecret: env.GRAPH_CLIENT_SECRET || null,
      sender: env.MAIL_SENDER || null,
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
        sharePointLink: env.MONDAY_COL_SHAREPOINT_LINK || null,
        // File columns: the real PDFs live on the card and preview inline —
        // no expiring links, no auth. Null until the columns exist.
        offerFile: env.MONDAY_COL_OFFER_FILE || null,
        signedFile: env.MONDAY_COL_SIGNED_FILE || null,
        agreementLink: env.MONDAY_COL_AGREEMENT_LINK || null,
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
        supervisorName: env.MONDAY_COL_SUPERVISOR_NAME || 'text_mm6ch89a',
        payRate: env.MONDAY_COL_PAY_RATE || 'numeric_mm65mx3m',
        payFrequency: env.MONDAY_COL_PAY_FREQUENCY || 'dropdown_mm658n1t',
        payClass: env.MONDAY_COL_PAY_CLASS || 'dropdown_mm65aswt',
        flsaStatus: env.MONDAY_COL_FLSA_STATUS || 'dropdown_mm6576ra',
        workerType: env.MONDAY_COL_WORKER_TYPE || 'dropdown_mm65jpby',
        // Offer expiration date (RPH letter); empty -> fallback wording
        offerExpires: env.MONDAY_COL_OFFER_EXPIRES || 'date_mm6f6rma',
        // Offer lifecycle column (HR review gate) and its label vocabulary
        offerStatus: env.MONDAY_COL_OFFER_STATUS || 'color_mm63ewwy',
      },
      // Offer Letter Status vocabulary (ordered ①→⑥; one-word verbs:
      // imperative = a person acts, -ing = automation in progress)
      offerLabels: {
        notStarted: env.MONDAY_OFFER_LABEL_NOT_STARTED || '① Idle',
        generating: env.MONDAY_OFFER_LABEL_GENERATING || '② ⚙️ Writing Letter',
        ready: env.MONDAY_OFFER_LABEL_READY || '③ 👤 Review',
        // TWO human gates (④ approved, ⑦ sendPackage) with the machine's own
        // work visible in between, so the board is never a black box.
        approved: env.MONDAY_OFFER_LABEL_APPROVED || '④ ✅ Package Approved',
        creatingPackage: env.MONDAY_OFFER_LABEL_CREATING || '⑤ ⚙️ Preparing Signature',
        readyToSend: env.MONDAY_OFFER_LABEL_READY_TO_SEND || '⑥ 👀 Ready to Send',
        sendPackage: env.MONDAY_OFFER_LABEL_SEND_PACKAGE || '⑦ 📤 Send Package',
        sendingEmail: env.MONDAY_OFFER_LABEL_SENDING || '⑧ ⚙️ Sending Email',
        sent: env.MONDAY_OFFER_LABEL_SENT || '⑨ ⚙️ Signing',
        signed: env.MONDAY_OFFER_LABEL_SIGNED || '⑩ 🎉 Signed',
        moreInfo: env.MONDAY_OFFER_LABEL_MORE_INFO || '✋ Revise',
        denied: env.MONDAY_OFFER_LABEL_DENIED || '🛑 Denied',
        failed: env.MONDAY_OFFER_LABEL_FAILED || '❌ Failed',
      },
      // Onboarding Status vocabulary (macro journey ①→⑦, one-word verbs)
      statusLabels: {
        welcome: env.MONDAY_STATUS_WELCOME || '① 👤 Send',
        awaitingInfo: env.MONDAY_STATUS_AWAITING_INFO || '② ⏳ Waiting',
        fieldsNeeded: env.MONDAY_STATUS_FIELDS_NEEDED || '③ 👤 Fill',
        docsInProgress: env.MONDAY_STATUS_DOCS || '④ ⚙️ Generating',
        outForSignature: env.MONDAY_STATUS_SIGNING || '⑤ ✉️ Sent',
        awaitingReview: env.MONDAY_STATUS_AWAITING_REVIEW || '④ 👤 Review',
        archiving: env.MONDAY_STATUS_ARCHIVING || '⑥ ⚙️ Archiving',
        // Post-signing tracking: each candidate action closes its own gate.
        signedFormPending: env.MONDAY_STATUS_SIGNED_FORM_PENDING || '⑥ ✍️ Form Pending',
        waitingBackground: env.MONDAY_STATUS_WAITING_BG || '⑦ 🎉 Waiting for Background',
        complete: env.MONDAY_STATUS_COMPLETE || '⑦ 🎉 Done',
        missingFields: env.MONDAY_STATUS_MISSING || 'Missing Required Fields',
        createNewHire: env.MONDAY_STATUS_CREATE_NEW_HIRE || 'Create New Hire',
        pdfFailed: env.MONDAY_STATUS_PDF_FAILED || '❌ PDF Failed',
        signFailed: env.MONDAY_STATUS_SIGN_FAILED || '❌ Sign Failed',
        archiveFailed: env.MONDAY_STATUS_ARCHIVE_FAILED || '❌ Archive Failed',
      },
      // Ordered journeys (drive the status-narrator comments).
      // Derived below from the label objects so env overrides can never
      // desync the narration from the real labels.
      statusOrder: null,
      offerOrder: null,
      // ATS intake: candidates flip to the hired status on an ATS board →
      // an Onboarding item is created and linked (mirror columns populate).
      atsIntake: {
        statusColumn: env.MONDAY_ATS_STATUS_COLUMN || 'color_mkzr88cj',
        hiredLabel: env.MONDAY_ATS_HIRED_LABEL || 'Hired (Closed)',
        boards: {
          [env.MONDAY_RPH_ATS_BOARD_ID || '18404160361']: {
            name: 'RPH-ATS',
            relationColumn: 'board_relation_mm586wsc',
            jobTitle: 'Pharmacist',
            payClass: 'RPH',
            // ATS column -> value copied onto the hire at intake
            copy: { email: 'email', phone: 'phone_mm4bf3mk', startDate: 'date_mm2m5jcj' },
          },
          [env.MONDAY_CLERK_ATS_BOARD_ID || '18395962118']: {
            name: 'Clerk-ATS',
            relationColumn: 'board_relation_mm586pas',
            jobTitle: 'Pharmacy Associate',
            payClass: 'Clerk',
            copy: { email: 'email', phone: 'text_mkzz809m', startDate: 'date_mkzrc12e' },
          },
        },
      },
      // Welcome-form sync: candidate info form board -> Onboarding hire record
      // Team-editable templates: the Template Catalog board is the source of
      // truth — the latest file on a row wins; blob storage is the fallback.
      templateFiles: {
        keyColumn: env.MONDAY_TPL_KEY_COLUMN || 'text_mm64n4ts',
        fileColumn: env.MONDAY_TPL_FILE_COLUMN || 'file_mm6csbxn',
        // Signing-packet rows on the same catalog: Template Type = this label
        // + Active checked -> the file is bundled into every hire's Adobe
        // agreement, in Packet Order, right behind the custom offer letter.
        typeColumn: env.MONDAY_TPL_TYPE_COLUMN || 'dropdown_mm64hytj',
        activeColumn: env.MONDAY_TPL_ACTIVE_COLUMN || 'boolean_mm641dwh',
        orderColumn: env.MONDAY_TPL_ORDER_COLUMN || 'numeric_mm6c7xmw',
        packetTypeLabel: env.MONDAY_TPL_PACKET_LABEL || 'Packet Document',
      },
      // Team-editable EMAIL wording (Email Templates board 18427287360):
      // Subject/Body per key — HR edits the text in Monday, the next send
      // uses it. Missing/unchecked rows fall back to built-in wording.
      emailTemplates: {
        boardId: env.MONDAY_EMAIL_TEMPLATES_BOARD_ID || '18427287360',
        columns: {
          key: 'text_mm6cc45p',
          subject: 'text_mm6cna',
          body: 'long_text_mm6ca0v6',
          active: 'boolean_mm6cgb98',
        },
      },
      // The living process guide (linked from column headers and key updates)
      playbookUrl: env.MONDAY_PLAYBOOK_URL || 'https://medwatchers.monday.com/docs/18427186375',
      formSync: {
        boardId: env.MONDAY_FORM_BOARD_ID || '18427180595',
        formUrl: env.MONDAY_FORM_URL || 'https://forms.monday.com/forms/f4b5d1499c2dc94ed022a220a133fd51',
        // form board column ids (question ids)
        formColumns: {
          preferredFirst: 'short_textwyh1tbpw',
          personalEmail: 'emailep1d7e0n',
          mobilePhone: 'phonelt6oz6df',
          homeAddress: 'location1ikc72st',
          livedInState: 'single_selectpxoczsh',
          timeZone: 'single_select8fc0rj6',
          startDate: 'datefyy9ozp8',
          emergencyName: 'short_textzhda3tz6',
          emergencyPhone: 'phoner1drdnlo',
          notes: 'long_textcup9a6kj',
        },
        // Onboarding board target column ids
        targetColumns: {
          preferredFirst: env.MONDAY_COL_FIRST_NAME || 'text_mm6570q4',
          personalEmail: env.MONDAY_COL_PERSONAL_EMAIL || 'email_mm6cr1gj',
          mobilePhone: env.MONDAY_COL_MOBILE_PHONE || 'phone_mm6cxwa3',
          homeAddress: env.MONDAY_COL_HOME_ADDRESS || 'location_mm6cmyg6',
          livedInState: env.MONDAY_COL_LIVED_IN_STATE || 'dropdown_mm669dw4',
          timeZone: env.MONDAY_COL_TIME_ZONE || 'dropdown_mm66x62b',
          startDate: env.MONDAY_COL_EARLIEST_START || 'date_mm6cspg8',
          emergencyName: env.MONDAY_COL_EMERGENCY_NAME || 'text_mm6cv6se',
          emergencyPhone: env.MONDAY_COL_EMERGENCY_PHONE || 'phone_mm6ca1xn',
        },
      },
      // ADP handoff: the required hire fields and their live board columns.
      // Used to report readiness before the external team creates the ADP user.
      adpFieldColumns: {
        firstName: 'text_mm6570q4',
        lastName: 'text_mm65jrfy',
        workEmail: 'text_mm65hxkh',
        badgeNumber: 'text_mm65ktsr',
        adpJobTitle: 'dropdown_mm65th43',
        adpDepartment: 'dropdown_mm658qx8',
        adpWorkLocation: 'dropdown_mm65fa2g',
        workerType: 'dropdown_mm65jpby',
        supervisor: 'text_mm6ch89a',
        reasonForHire: 'dropdown_mm66d04',
        payType: 'dropdown_mm65v43b',
        payRate: 'numeric_mm65mx3m',
        payFrequency: 'dropdown_mm658n1t',
        companyCode: 'dropdown_mm6566ff',
        payClass: 'dropdown_mm65aswt',
        flsaStatus: 'dropdown_mm6576ra',
        suiSdiTaxCode: 'dropdown_mm651ram',
        workersCompStatus: 'dropdown_mm65r639',
        workersCompJobClass: 'dropdown_mm65e9dz',
        workedInState: 'dropdown_mm66y9tg',
        livedInState: 'dropdown_mm669dw4',
        timeZone: 'dropdown_mm66x62b',
        benefitsEligibility: 'color_mm651h50',
        benefitsEligibilityClass: 'dropdown_mm66xmr6',
        onboardingExperience: 'dropdown_mm66tnrh',
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

    // Candidate link-click tracking: emailed links route through the signed
    // /api/trackClick redirect so the card shows the first click per link.
    tracking: {
      secret: env.DOCFLOW_TRACK_SECRET || env.MONDAY_SIGNING_SECRET || null,
      baseUrl: env.DOCFLOW_PUBLIC_BASE_URL || 'https://doc-automation-func.azurewebsites.net',
    },

    retryBaseMs: _int(env.DOCFLOW_RETRY_BASE_MS, 500),
    tempMaxAgeHours: _int(env.DOCFLOW_TEMP_MAX_AGE_HOURS, 168),
    webhookRateLimitThreshold: _int(env.DOCFLOW_QUEUE_RATE_LIMIT_THRESHOLD, 1000),
  };

  // Journeys derive from the label objects — env overrides stay in sync
  const sl = cfg.monday.statusLabels;
  cfg.monday.statusOrder = [
    sl.welcome, sl.awaitingInfo, sl.fieldsNeeded, sl.docsInProgress,
    sl.awaitingReview, sl.outForSignature, sl.archiving,
    sl.signedFormPending, sl.waitingBackground, sl.complete,
  ];
  const ol = cfg.monday.offerLabels;
  cfg.monday.offerOrder = [
    ol.notStarted, ol.generating, ol.ready, ol.approved, ol.creatingPackage,
    ol.readyToSend, ol.sendPackage, ol.sendingEmail, ol.sent, ol.signed,
  ];

  _cache = cfg;
  return cfg;
}

/** Test/hot-reload helper: drop the cached config so env changes are re-read. */
function reset() {
  _cache = null;
}

module.exports = { load, reset, REQUIRED };
