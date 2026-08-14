'use strict';
/**
 * Event Ledger Function: Query and replay job event history.
 *
 * Endpoints:
 *   GET /api/eventLedger?jobId=...                 — Get all events for a job
 *   GET /api/eventLedger?jobId=...&action=state    — Replay to current state
 *   GET /api/eventLedger?jobId=...&action=replay&fromSeq=N  — Replay from point N
 *   GET /api/eventLedger?action=listJobs           — List all jobs with events
 *
 * This function demonstrates integrating the EventSourcing module for
 * audit trails, debugging, and state recovery.
 */

const eventSourcing = require('../../lib/eventSourcing');
const logger = require('../../lib/logger');

/**
 * Sample reducer: reconstructs job state from event log.
 * Adapt this to match your document workflow.
 */
const jobStateReducer = (state, event) => {
  const et = event.eventType;

  if (et === 'job-created') {
    state.created = event.timestamp;
    state.status = 'created';
    Object.assign(state, event.data);
  }

  if (et === 'pdf-generated') {
    state.status = 'pdf-ready';
    state.pdfUrl = event.data.pdfUrl;
    state.pdfSize = event.data.size;
    state.generatedAt = event.timestamp;
  }

  if (et === 'pdf-generation-failed') {
    state.status = 'failed';
    state.lastError = event.data.error;
    state.errorCode = event.data.code;
    state.failedAt = event.timestamp;
  }

  if (et === 'sent-for-signature' || et === 'sent-for-sign') {
    state.status = 'awaiting-signature';
    state.agreementId = event.data.agreementId;
    state.signerEmail = event.data.signerEmail;
    state.sentForSignAt = event.timestamp;
  }

  if (et === 'signed' || et === 'signature-received') {
    state.status = 'signed';
    state.signedAt = event.timestamp;
    state.signatureId = event.data.signatureId;
    state.completedAt = event.data.completedAt;
  }

  if (et === 'archived') {
    state.status = 'archived';
    state.archiveUrl = event.data.blobUrl;
    state.archivedAt = event.timestamp;
  }

  if (et === 'failed' || et === 'error') {
    state.status = 'failed';
    state.lastError = event.data.error || event.data.message;
    state.failedAt = event.timestamp;
  }

  return state;
};

/**
 * Format event for JSON response (cleanups).
 */
function _formatEvent(event) {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.eventType,
    timestamp: event.timestamp,
    data: event.data,
    author: event.metadata?.author,
    source: event.metadata?.source,
  };
}

/**
 * GET /api/eventLedger?jobId=...
 * List all events for a job.
 */
async function handleGetHistory(jobId) {
  const history = await eventSourcing.getHistory(jobId, {});
  return {
    status: 200,
    body: {
      jobId,
      totalEvents: history.total,
      returned: history.returned,
      events: history.events.map(_formatEvent),
    },
  };
}

/**
 * GET /api/eventLedger?jobId=...&action=state
 * Replay events to compute current job state.
 */
async function handleGetState(jobId) {
  const count = await eventSourcing.getEventCount(jobId);
  if (count === 0) {
    return {
      status: 404,
      body: { error: `No events found for job ${jobId}` },
    };
  }

  const state = await eventSourcing.reduceEvents(
    jobId,
    { jobId, status: 'unknown' },
    jobStateReducer
  );

  return {
    status: 200,
    body: {
      jobId,
      eventCount: count,
      currentState: state,
    },
  };
}

/**
 * GET /api/eventLedger?jobId=...&action=replay&fromSeq=N
 * Replay events from a specific sequence number.
 */
async function handleReplay(jobId, fromSeq) {
  const fromSequence = parseInt(fromSeq, 10);
  if (!Number.isFinite(fromSequence)) {
    return {
      status: 400,
      body: { error: 'fromSeq must be a number' },
    };
  }

  const replay = await eventSourcing.replayFrom(jobId, { fromSequence });

  // Compute state from replayed events
  let state = { jobId, status: 'unknown' };
  for (const event of replay.events) {
    state = jobStateReducer(state, event);
  }

  return {
    status: 200,
    body: {
      jobId,
      fromSequence,
      eventsReplayed: replay.count,
      computedState: state,
      events: replay.events.map(_formatEvent),
    },
  };
}

/**
 * GET /api/eventLedger?action=listJobs
 * List all jobs with recorded events.
 */
async function handleListJobs() {
  const jobs = await eventSourcing.listJobs();
  return {
    status: 200,
    body: {
      totalJobs: jobs.length,
      jobs,
    },
  };
}

/**
 * Main handler
 */
module.exports = async function (context, req) {
  const startMs = Date.now();
  let response;

  try {
    const { jobId, action, fromSeq } = req.query || {};

    if (action === 'listJobs') {
      response = await handleListJobs();
    } else if (!jobId) {
      response = {
        status: 400,
        body: {
          error: 'jobId query parameter required (or action=listJobs)',
          usage: {
            history: 'GET /api/eventLedger?jobId=...',
            state: 'GET /api/eventLedger?jobId=...&action=state',
            replay: 'GET /api/eventLedger?jobId=...&action=replay&fromSeq=N',
            list: 'GET /api/eventLedger?action=listJobs',
          },
        },
      };
    } else if (action === 'state') {
      response = await handleGetState(jobId);
    } else if (action === 'replay') {
      response = await handleReplay(jobId, fromSeq);
    } else {
      response = await handleGetHistory(jobId);
    }

    const durationMs = Date.now() - startMs;

    logger.event('event-ledger-request', {
      jobId: jobId || 'none',
      action: action || 'history',
      statusCode: response.status,
      durationMs,
    });
  } catch (err) {
    logger.error('event-ledger-handler-error', err, {
      jobId: req.query?.jobId,
      action: req.query?.action,
    });

    response = {
      status: 500,
      body: { error: err.message },
    };
  }

  context.res = response;
};
