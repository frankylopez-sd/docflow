'use strict';

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const monday = require('../../lib/monday');
const queue = require('../../lib/priorityQueueService');
const { stepHeader, friendlyFieldName } = require('../../lib/util');

/**
 * validateADP: Validates 25 required ADP/HR fields from Monday hire record.
 * Updates Monday status column immediately with validation result.
 * If valid → queues PDF generation. If invalid → marks as "Missing Required Fields".
 */

const REQUIRED_FIELDS = [
  'firstName', 'lastName', 'workEmail', 'badgeNumber',
  'adpJobTitle', 'adpDepartment', 'adpWorkLocation', 'workerType', 'supervisor', 'reasonForHire',
  'payType', 'payRate', 'payFrequency', 'companyCode', 'payClass',
  'flsaStatus', 'suiSdiTaxCode',
  'workersCompStatus', 'workersCompJobClass', 'workedInState', 'livedInState', 'timeZone',
  'benefitsEligibility', 'benefitsEligibilityClass', 'onboardingExperience'
];

module.exports = async function (context, req) {
  const cfg = config.load();
  const labels = (cfg.monday && cfg.monday.statusLabels) || {};
  const STATUS_VALID = labels.createNewHire || 'Create New Hire';
  const STATUS_INVALID = labels.missingFields || 'Missing Required Fields';

  try {
    const { boardId, itemId, ...hireData } = req.body;

    if (!boardId || !itemId) {
      return context.res = {
        status: 400,
        body: { error: 'Missing boardId or itemId' }
      };
    }

    // Validate all 23 fields
    const missing = REQUIRED_FIELDS.filter(f => !hireData[f] || String(hireData[f]).trim() === '');
    const isValid = missing.length === 0;

    logger.info('validateADP-check', {
      itemId,
      totalFields: REQUIRED_FIELDS.length,
      providedFields: Object.keys(hireData).length,
      missingFields: missing,
      isValid
    });

    // Update Monday status based on validation
    const statusValue = isValid ? STATUS_VALID : STATUS_INVALID;

    try {
      await monday.updateItemStatus(boardId, itemId, statusValue);
      logger.info('validateADP-monday-status-updated', {
        itemId,
        status: statusValue
      });
    } catch (err) {
      logger.warn('validateADP-monday-update-failed', {
        error: err.message,
        itemId,
        note: 'Validation complete but Monday update failed'
      });
    }

    // Name the gaps on the card so nobody has to guess what "missing" means
    if (!isValid) {
      try {
        await monday.logAction(itemId,
          stepHeader(2, 'Hire details')
          + `✋ The ADP user can't be created yet — ${missing.length === 1 ? 'one field is' : missing.length + ' fields are'} still empty:\n`
          + missing.map((f) => `    ${friendlyFieldName(f)}`).join('\n')
          + `\n\nYour move\n`
          + `    ✎ fill ${missing.length === 1 ? 'it' : 'them'} in on this card — the validation passes on the next check`
        );
      } catch (_) { /* comment is best-effort — validation result stands */ }
    }

    // If valid, queue PDF generation
    if (isValid) {
      try {
        const routed = await queue.routeMessage({
          boardId,
          itemId,
          ...hireData,
          timestamp: new Date().toISOString()
        });
        // routeMessage only builds the routing descriptor — the physical enqueue
        // happens through the queue output binding declared in function.json.
        context.bindings = context.bindings || {};
        context.bindings[routed.binding] = routed.message;
        logger.info('validateADP-queued-pdf-generation', {
          itemId,
          queueName: routed.queueName,
          priority: routed.priority
        });
      } catch (err) {
        logger.error('validateADP-queue-failed', {
          error: err.message,
          itemId
        });
        return context.res = {
          status: 503,
          body: { error: 'Failed to queue PDF generation' }
        };
      }
    }

    // Return result
    context.res = {
      status: 200,
      body: {
        itemId,
        validated: isValid,
        status: statusValue,
        missingFields: missing.length > 0 ? missing : undefined,
        nextStep: isValid ? 'PDF Generation Queued' : 'Waiting for Missing Fields'
      }
    };

  } catch (error) {
    logger.error('validateADP-error', { error: error.message });
    context.res = {
      status: 500,
      body: { error: 'Validation failed' }
    };
  }
};
