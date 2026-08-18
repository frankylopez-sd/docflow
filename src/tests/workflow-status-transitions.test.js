'use strict';
/**
 * Workflow Status Transitions Test
 * Verifies that ALL status transitions in the document automation workflow
 * are logged to the event sourcing system for audit compliance.
 *
 * Expected workflow states:
 * 1. Created (hire submitted via Monday webhook)
 * 2. Documentation Generating (PDF generation in progress)
 * 3. Sent for Signature (PDF sent to signers via Adobe)
 * 4. Signed (all signers completed)
 * 5. Archived / Onboarding Complete (final state)
 *
 * Error states that should be logged:
 * - PDF Gen Failed
 * - Sign Failed
 * - Archive Error
 * - Webhook Error
 */

// Mock dependencies — including Azure Storage: without this, eventSourcing
// constructs a real BlobServiceClient and hangs retrying network uploads.
jest.mock('../lib/config');
jest.mock('../lib/logger');
jest.mock('@azure/storage-blob', () => require('./helpers/mockStorage').create());
jest.mock('@azure/identity', () => ({ DefaultAzureCredential: class DefaultAzureCredential {} }));

const eventSourcing = require('../lib/eventSourcing');
const { AuditLogger, AUDIT_EVENT_TYPES } = require('../lib/auditLogger');
const config = require('../lib/config');
const storageMock = require('@azure/storage-blob');

describe('Workflow Status Transitions Logging', () => {
  let auditLogger;
  const testJobId = 'job-workflow-test-' + Date.now();

  beforeEach(() => {
    jest.clearAllMocks();
    storageMock.__reset();
    eventSourcing._reset();
    auditLogger = new AuditLogger({ retentionDays: 365, namespace: 'docflow' });

    config.load.mockReturnValue({
      environment: 'test',
      storage: {
        accountName: 'teststorage',
        accountKey: 'dGVzdGtleQ==',
        secondaryAccountName: null,
        secondaryAccountKey: null,
      },
      adobe: { clientId: 'test-adobe-client' },
      monday: { token: 'test-monday-token' },
    });
  });

  describe('Status Transition Events', () => {
    it('should log HIRE_CREATED event when workflow begins', async () => {
      const hireData = {
        mondayItemId: 'item-123',
        firstName: 'John',
        lastName: 'Doe',
        workEmail: 'john.doe@example.com',
        adpJobTitle: 'Software Engineer',
        adpDepartment: 'Engineering',
      };

      await auditLogger.logHireCreated(testJobId, hireData, {
        userId: 'user-hr-01',
        source: 'monday-webhook',
      });

      const history = await eventSourcing.getHistory(testJobId);
      expect(history.events.length).toBeGreaterThan(0);

      const hireCreatedEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.HIRE_CREATED
      );
      expect(hireCreatedEvent).toBeDefined();
      expect(hireCreatedEvent.data.firstName).toBe('John');
      expect(hireCreatedEvent.data.mondayItemId).toBe('item-123');
    });

    it('should log PDF_GENERATION_COMPLETED when PDF is generated', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-123',
        firstName: 'Jane',
        lastName: 'Smith',
        workEmail: 'jane.smith@example.com',
        adpJobTitle: 'Manager',
        adpDepartment: 'Sales',
      });

      const pdfData = {
        pdfUrl: 'https://storage.blob.core.windows.net/pdf-temp/offer-123.pdf',
        fileSizeBytes: 245000,
        fileName: 'offer-123.pdf',
        pdfContent: Buffer.from('fake pdf'),
        duration: 2500,
      };

      await auditLogger.logPDFGeneration(testJobId, pdfData, {
        userId: 'system',
        source: 'pdf-generator',
      });

      const history = await eventSourcing.getHistory(testJobId);
      const pdfEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.PDF_GENERATION_COMPLETED
      );
      expect(pdfEvent).toBeDefined();
      expect(pdfEvent.data.fileSizeBytes).toBe(245000);
      expect(pdfEvent.data.pdfUrl).toContain('pdf-temp');
    });

    it('should log SIGNATURE_REQUESTED when PDF is sent for signing', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-123',
        firstName: 'Bob',
        lastName: 'Johnson',
        workEmail: 'bob.johnson@example.com',
        adpJobTitle: 'Analyst',
        adpDepartment: 'Analytics',
      });

      const signatureData = {
        adobeAgreementId: 'AGR-2026-08-14-001',
        signers: [
          { email: 'hr@medwatchers.com', name: 'HR Rep', order: 0 },
          { email: 'manager@medwatchers.com', name: 'Manager', order: 1 },
          { email: 'bob.johnson@example.com', name: 'Bob Johnson', order: 2 },
        ],
      };

      await auditLogger.logSignatureRequested(testJobId, signatureData, {
        userId: 'system',
        source: 'adobe-sign',
      });

      const history = await eventSourcing.getHistory(testJobId);
      const sigReqEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.SIGNATURE_REQUESTED
      );
      expect(sigReqEvent).toBeDefined();
      expect(sigReqEvent.data.signerCount).toBe(3);
      expect(sigReqEvent.data.adobeAgreementId).toBe('AGR-2026-08-14-001');
    });

    it('should log SIGNATURE_RECEIVED for each signer', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-123',
        firstName: 'Alice',
        lastName: 'Wilson',
        workEmail: 'alice.wilson@example.com',
        adpJobTitle: 'Designer',
        adpDepartment: 'Design',
      });

      // Log 3 signers completing
      const signers = [
        { email: 'hr@medwatchers.com', name: 'HR Rep' },
        { email: 'manager@medwatchers.com', name: 'Manager' },
        { email: 'alice.wilson@example.com', name: 'Alice Wilson' },
      ];

      for (let i = 0; i < signers.length; i++) {
        await auditLogger.logSignatureReceived(
          testJobId,
          {
            adobeAgreementId: 'AGR-2026-08-14-001',
            signerEmail: signers[i].email,
            signerName: signers[i].name,
            signedAt: new Date().toISOString(),
            signatureOrder: i,
          },
          { userId: 'system', source: 'adobe-webhook' }
        );
      }

      const history = await eventSourcing.getHistory(testJobId);
      const sigReceivedEvents = history.events.filter(
        e => e.eventType === AUDIT_EVENT_TYPES.SIGNATURE_RECEIVED
      );
      expect(sigReceivedEvents.length).toBe(3);
      expect(sigReceivedEvents[0].data.signerEmail).toBe('hr@medwatchers.com');
      expect(sigReceivedEvents[2].data.signerEmail).toBe('alice.wilson@example.com');
    });

    it('should log DOCUMENT_ARCHIVED when signed PDF is archived', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-123',
        firstName: 'Charlie',
        lastName: 'Brown',
        workEmail: 'charlie.brown@example.com',
        adpJobTitle: 'Coordinator',
        adpDepartment: 'HR',
      });

      const archiveData = {
        archiveLocation: 'blob://pdf-archive/signed-offer-charlie-brown-item-123-1692374400000.pdf',
        fileName: 'signed-offer-charlie-brown-item-123-1692374400000.pdf',
        fileSizeBytes: 248500,
        dataResidency: 'us-east-1',
        encryptionAlgorithm: 'AES-256',
        archiveHash: 'sha256-abc123def456',
      };

      await auditLogger.logDocumentArchived(testJobId, archiveData, {
        userId: 'system',
        source: 'archive-service',
      });

      const history = await eventSourcing.getHistory(testJobId);
      const archiveEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.DOCUMENT_ARCHIVED
      );
      expect(archiveEvent).toBeDefined();
      expect(archiveEvent.data.archiveLocation).toContain('pdf-archive');
      expect(archiveEvent.data.dataResidency).toBe('us-east-1');
    });

    it('should log DOCUMENT_STORED_SHAREPOINT for final archive copy', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-123',
        firstName: 'Diana',
        lastName: 'Princess',
        workEmail: 'diana@example.com',
        adpJobTitle: 'Manager',
        adpDepartment: 'Executive',
      });

      const sharePointData = {
        sharePointUrl: 'https://medwatchers.sharepoint.com/sites/HR/Documents/offer-diana-item-123.pdf',
        siteId: 'site-hr-001',
        libraryId: 'lib-documents-001',
        itemId: 'sp-item-456',
        fileName: 'offer-diana-item-123.pdf',
      };

      await auditLogger.logDocumentStoredSharePoint(testJobId, sharePointData, {
        userId: 'system',
        source: 'sharepoint-service',
      });

      const history = await eventSourcing.getHistory(testJobId);
      const spEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.DOCUMENT_STORED_SHAREPOINT
      );
      expect(spEvent).toBeDefined();
      expect(spEvent.data.sharePointUrl).toContain('sharepoint.com');
    });
  });

  describe('Error State Transitions', () => {
    it('should log PDF_GENERATION_FAILED when PDF generation fails', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-456',
        firstName: 'Eve',
        lastName: 'Error',
        workEmail: 'eve@example.com',
        adpJobTitle: 'Tech',
        adpDepartment: 'IT',
      });

      const error = new Error('Adobe API timeout after 30 seconds');
      error.code = 'ADOBE_TIMEOUT';
      error.retryable = true;

      await auditLogger.logPDFGenerationFailed(testJobId, error, {
        userId: 'system',
        source: 'pdf-generator',
      });

      const history = await eventSourcing.getHistory(testJobId);
      const failEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.PDF_GENERATION_FAILED
      );
      expect(failEvent).toBeDefined();
      expect(failEvent.data.errorCode).toBe('ADOBE_TIMEOUT');
      expect(failEvent.data.retryable).toBe(true);
    });

    it('should log SIGNATURE_FAILED when signing fails', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-789',
        firstName: 'Frank',
        lastName: 'Failure',
        workEmail: 'frank@example.com',
        adpJobTitle: 'Support',
        adpDepartment: 'Customer Support',
      });

      const error = new Error('Signer rejected the document');
      error.code = 'SIGNATURE_REJECTED';

      await auditLogger.logSignatureFailed(testJobId, error, 'manager@medwatchers.com', {
        userId: 'system',
        source: 'adobe-sign',
      });

      const history = await eventSourcing.getHistory(testJobId);
      const sigFailEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.SIGNATURE_FAILED
      );
      expect(sigFailEvent).toBeDefined();
      expect(sigFailEvent.data.signerEmail).toBe('manager@medwatchers.com');
      expect(sigFailEvent.data.errorMessage).toContain('rejected');
    });

    it('should log SYSTEM_ERROR for unexpected failures', async () => {
      await auditLogger.logHireCreated(testJobId, {
        mondayItemId: 'item-999',
        firstName: 'George',
        lastName: 'Glitch',
        workEmail: 'george@example.com',
        adpJobTitle: 'QA',
        adpDepartment: 'Quality Assurance',
      });

      const error = new Error('Connection pool exhausted');
      error.code = 'ECONNPOOL';

      await auditLogger.logSystemError(testJobId, error, {
        userId: 'system',
        component: 'monday-api-client',
      });

      const history = await eventSourcing.getHistory(testJobId);
      const sysErrorEvent = history.events.find(
        e => e.eventType === AUDIT_EVENT_TYPES.SYSTEM_ERROR
      );
      expect(sysErrorEvent).toBeDefined();
      expect(sysErrorEvent.data.systemComponent).toBe('monday-api-client');
    });
  });

  describe('Full Workflow Transition Sequence', () => {
    it('should log all transitions in a complete successful workflow', async () => {
      const jobId = 'job-complete-flow-' + Date.now();
      const hireData = {
        mondayItemId: 'item-complete-001',
        firstName: 'Hannah',
        lastName: 'Happy',
        workEmail: 'hannah@example.com',
        adpJobTitle: 'Engineer',
        adpDepartment: 'Engineering',
      };

      // Step 1: Hire created
      await auditLogger.logHireCreated(jobId, hireData);

      // Step 2: PDF generated
      await auditLogger.logPDFGeneration(jobId, {
        pdfUrl: 'https://example.com/offer.pdf',
        fileSizeBytes: 250000,
        fileName: 'offer.pdf',
        duration: 2000,
      });

      // Step 3: Signature requested
      await auditLogger.logSignatureRequested(jobId, {
        adobeAgreementId: 'AGR-complete-001',
        signers: [
          { email: 'hr@medwatchers.com', name: 'HR', order: 0 },
          { email: 'mgr@medwatchers.com', name: 'Manager', order: 1 },
          { email: 'hannah@example.com', name: 'Hannah', order: 2 },
        ],
      });

      // Step 4: Signatures received
      for (let i = 0; i < 3; i++) {
        await auditLogger.logSignatureReceived(jobId, {
          adobeAgreementId: 'AGR-complete-001',
          signerEmail: ['hr@medwatchers.com', 'mgr@medwatchers.com', 'hannah@example.com'][i],
          signerName: ['HR', 'Manager', 'Hannah'][i],
          signatureOrder: i,
          signedAt: new Date().toISOString(),
        });
      }

      // Step 5: Document archived
      await auditLogger.logDocumentArchived(jobId, {
        archiveLocation: 'blob://archive/signed-hannah.pdf',
        fileName: 'signed-hannah.pdf',
        fileSizeBytes: 250000,
        dataResidency: 'us-east-1',
      });

      // Step 6: Document stored in SharePoint
      await auditLogger.logDocumentStoredSharePoint(jobId, {
        sharePointUrl: 'https://medwatchers.sharepoint.com/hannah.pdf',
        siteId: 'site-001',
        libraryId: 'lib-001',
        itemId: 'item-sp-001',
        fileName: 'hannah.pdf',
      });

      // Verify all events are logged
      const history = await eventSourcing.getHistory(jobId, { skip: 0, limit: 100 });
      expect(history.events.length).toBe(8); // 1 + 1 + 1 + 3 + 1 + 1

      const eventTypes = history.events.map(e => e.eventType);
      expect(eventTypes).toContain(AUDIT_EVENT_TYPES.HIRE_CREATED);
      expect(eventTypes).toContain(AUDIT_EVENT_TYPES.PDF_GENERATION_COMPLETED);
      expect(eventTypes).toContain(AUDIT_EVENT_TYPES.SIGNATURE_REQUESTED);
      expect(eventTypes.filter(e => e === AUDIT_EVENT_TYPES.SIGNATURE_RECEIVED)).toHaveLength(3);
      expect(eventTypes).toContain(AUDIT_EVENT_TYPES.DOCUMENT_ARCHIVED);
      expect(eventTypes).toContain(AUDIT_EVENT_TYPES.DOCUMENT_STORED_SHAREPOINT);
    });

    it('should support getComplianceStatus aggregation', async () => {
      const jobId = 'job-compliance-check-' + Date.now();

      // Full successful workflow
      await auditLogger.logHireCreated(jobId, {
        mondayItemId: 'item-comp-001',
        firstName: 'Iris',
        lastName: 'Inspector',
        workEmail: 'iris@example.com',
        adpJobTitle: 'Inspector',
        adpDepartment: 'QA',
      });

      const validationResult = { isValid: true, totalFields: 25, validFields: 25, missingFields: [] };
      await auditLogger.logADPValidation(jobId, validationResult);

      await auditLogger.logPDFGeneration(jobId, {
        pdfUrl: 'https://example.com/iris.pdf',
        fileSizeBytes: 250000,
      });

      await auditLogger.logSignatureRequested(jobId, {
        adobeAgreementId: 'AGR-iris-001',
        signers: [
          { email: 'hr@medwatchers.com', name: 'HR', order: 0 },
          { email: 'iris@example.com', name: 'Iris', order: 1 },
        ],
      });

      await auditLogger.logSignatureReceived(jobId, {
        adobeAgreementId: 'AGR-iris-001',
        signerEmail: 'hr@medwatchers.com',
        signerName: 'HR',
        signatureOrder: 0,
      });

      await auditLogger.logSignatureReceived(jobId, {
        adobeAgreementId: 'AGR-iris-001',
        signerEmail: 'iris@example.com',
        signerName: 'Iris',
        signatureOrder: 1,
      });

      await auditLogger.logDocumentArchived(jobId, {
        archiveLocation: 'blob://archive/iris.pdf',
        fileName: 'iris.pdf',
        fileSizeBytes: 250000,
        dataResidency: 'us-east-1',
      });

      // Get compliance status
      const complianceStatus = await auditLogger.getComplianceStatus(jobId);

      expect(complianceStatus.jobId).toBe(jobId);
      expect(complianceStatus.adpValidationPassed).toBe(true);
      expect(complianceStatus.allSignaturesCaptured).toBe(true);
      expect(complianceStatus.documentArchived).toBe(true);
      expect(complianceStatus.hasErrors).toBe(false);
      expect(complianceStatus.isCompliant).toBe(true);
      expect(complianceStatus.timeline.length).toBeGreaterThan(0);
    });
  });

  describe('Workflow Coverage Analysis', () => {
    it('should identify all required audit event types for the workflow', () => {
      const requiredEventTypes = [
        AUDIT_EVENT_TYPES.HIRE_CREATED,
        AUDIT_EVENT_TYPES.ADP_VALIDATION_PASSED,
        AUDIT_EVENT_TYPES.PDF_GENERATION_STARTED,
        AUDIT_EVENT_TYPES.PDF_GENERATION_COMPLETED,
        AUDIT_EVENT_TYPES.PDF_GENERATION_FAILED,
        AUDIT_EVENT_TYPES.SIGNATURE_REQUESTED,
        AUDIT_EVENT_TYPES.SIGNATURE_RECEIVED,
        AUDIT_EVENT_TYPES.SIGNATURE_FAILED,
        AUDIT_EVENT_TYPES.DOCUMENT_ARCHIVED,
        AUDIT_EVENT_TYPES.DOCUMENT_STORED_SHAREPOINT,
      ];

      // Verify all required event types exist
      for (const eventType of requiredEventTypes) {
        expect(eventType).toBeTruthy();
        expect(typeof eventType).toBe('string');
        expect(eventType).toMatch(/^audit:/);
      }
    });

    it('should have corresponding logger methods for each event type', async () => {
      expect(typeof auditLogger.logHireCreated).toBe('function');
      expect(typeof auditLogger.logADPValidation).toBe('function');
      expect(typeof auditLogger.logPDFGeneration).toBe('function');
      expect(typeof auditLogger.logPDFGenerationFailed).toBe('function');
      expect(typeof auditLogger.logSignatureRequested).toBe('function');
      expect(typeof auditLogger.logSignatureReceived).toBe('function');
      expect(typeof auditLogger.logSignatureFailed).toBe('function');
      expect(typeof auditLogger.logDocumentArchived).toBe('function');
      expect(typeof auditLogger.logDocumentStoredSharePoint).toBe('function');
    });
  });
});
