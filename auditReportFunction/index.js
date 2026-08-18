'use strict';
/**
 * Audit Report Function
 *
 * HTTP-triggered Azure Function to query and export audit logs.
 *
 * Query Parameters:
 *   - startDate: ISO date string (YYYY-MM-DD)
 *   - endDate: ISO date string (YYYY-MM-DD)
 *   - jobId: Filter by specific job/hire
 *   - employeeEmail: Filter by employee email
 *   - status: Filter by status (all, compliant, non-compliant, pending)
 *   - format: Export format (json, csv, pdf, html)
 *   - accessKey: API key for authentication
 *
 * Example:
 *   GET /api/auditReport?startDate=2026-08-01&endDate=2026-08-31&format=csv&accessKey=secret
 */

const { BlobServiceClient } = require('@azure/storage-blob');
const { ComplianceValidator, REQUIRED_ADP_FIELDS } = require('../src/lib/complianceValidator');
const { AuditLogger } = require('../src/lib/auditLogger');
const config = require('../src/lib/config');
const logger = require('../src/lib/logger');
const eventSourcing = require('../src/lib/eventSourcing');

const AUDIT_KEY = process.env.AUDIT_REPORT_API_KEY || 'not-set';
const EVENTS_CONTAINER = 'events';

module.exports = async function (context, req) {
  context.log('auditReportFunction triggered');

  try {
    // 1. Validate access key
    const accessKey = req.query.accessKey || req.headers['x-audit-key'];
    if (accessKey !== AUDIT_KEY) {
      logger.warn('audit:unauthorized-access', { ip: req.headers['x-forwarded-for'] });
      return {
        status: 403,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // 2. Parse query parameters
    const params = {
      startDate: req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
      endDate: req.query.endDate ? new Date(req.query.endDate) : new Date(),
      jobId: req.query.jobId || null,
      employeeEmail: req.query.employeeEmail || null,
      status: req.query.status || 'all', // all, compliant, non-compliant, pending
      format: req.query.format || 'json', // json, csv, html, pdf
      limit: Math.min(parseInt(req.query.limit) || 1000, 10000),
      skip: parseInt(req.query.skip) || 0,
    };

    logger.event('audit:report-requested', {
      startDate: params.startDate.toISOString(),
      endDate: params.endDate.toISOString(),
      jobId: params.jobId,
      format: params.format,
    });

    // 3. Fetch audit events
    const events = await _fetchAuditEvents(params);

    // 4. Process and filter events
    const report = _processAuditEvents(events, params);

    // 5. Export in requested format
    let responseBody;
    const contentType = _getContentType(params.format);

    if (params.format === 'json') {
      responseBody = JSON.stringify(report, null, 2);
    } else if (params.format === 'csv') {
      responseBody = _exportAsCSV(report);
    } else if (params.format === 'html') {
      responseBody = _exportAsHTML(report);
    } else {
      return {
        status: 400,
        body: JSON.stringify({ error: `Unsupported format: ${params.format}` }),
      };
    }

    logger.event('audit:report-generated', {
      jobCount: report.jobs.length,
      eventCount: report.totalEvents,
      format: params.format,
    });

    return {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="audit-report-${Date.now()}.${params.format}"`,
      },
      body: responseBody,
    };
  } catch (error) {
    logger.error('audit-report-error', error, {});

    return {
      status: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined,
      }),
    };
  }
};

/**
 * Fetch audit events from blob storage within date range.
 */
async function _fetchAuditEvents(params) {
  const cfg = config.load();
  const url = `https://${cfg.storage.accountName}.blob.core.windows.net`;
  const credential = cfg.storage.accountKey
    ? new (require('@azure/storage-blob')).StorageSharedKeyCredential(cfg.storage.accountName, cfg.storage.accountKey)
    : new (require('@azure/identity')).DefaultAzureCredential();

  const blobClient = new BlobServiceClient(url, credential);
  const containerClient = blobClient.getContainerClient(EVENTS_CONTAINER);

  const events = [];
  const startMs = params.startDate.getTime();
  const endMs = params.endDate.getTime();

  try {
    for await (const blob of containerClient.listBlobsFlat({ prefix: 'events/' })) {
      // Parse blob name: events/{jobId}/{timestamp}-{sequence}-{eventType}.json
      const match = blob.name.match(/^events\/([^/]+)\/(.*)\.json$/);
      if (!match) continue;

      const jobId = match[1];

      // Filter by jobId if specified
      if (params.jobId && jobId !== params.jobId) continue;

      try {
        const blobClientFile = containerClient.getBlobClient(blob.name);
        const response = await blobClientFile.download();
        const chunks = [];

        for await (const chunk of response.readableStreamBody) {
          chunks.push(chunk);
        }

        const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));

        // Filter by date range
        const eventTime = new Date(event.timestamp).getTime();
        if (eventTime < startMs || eventTime > endMs) continue;

        // Filter by employee email if specified
        if (params.employeeEmail && event.data?.workEmail !== params.employeeEmail) continue;

        events.push({
          ...event,
          jobId,
          blobName: blob.name,
        });
      } catch (err) {
        logger.warn('audit-event-read-failed', { blob: blob.name, error: err.message });
      }
    }
  } catch (err) {
    logger.error('audit-events-fetch-failed', err, {});
    throw err;
  }

  return events;
}

/**
 * Process and aggregate audit events.
 */
function _processAuditEvents(events, params) {
  const jobMap = {};

  // Group events by jobId
  for (const event of events) {
    const jobId = event.jobId;
    if (!jobMap[jobId]) {
      jobMap[jobId] = {
        jobId,
        firstName: null,
        lastName: null,
        workEmail: null,
        firstEvent: event.timestamp,
        lastEvent: event.timestamp,
        events: [],
        status: 'pending',
        isCompliant: false,
        errorCount: 0,
      };
    }

    // Extract employee info from first event
    if (event.data?.firstName) jobMap[jobId].firstName = event.data.firstName;
    if (event.data?.lastName) jobMap[jobId].lastName = event.data.lastName;
    if (event.data?.workEmail) jobMap[jobId].workEmail = event.data.workEmail;

    // Track events
    jobMap[jobId].events.push({
      timestamp: event.timestamp,
      eventType: event.eventType,
      severity: event.metadata?.severity || 'info',
      userId: event.metadata?.userId || 'system',
      ipAddress: event.metadata?.ipAddress || null,
    });

    // Update last event time
    jobMap[jobId].lastEvent = event.timestamp;

    // Track errors
    if (event.eventType.includes('failed') || event.eventType.includes('error')) {
      jobMap[jobId].errorCount++;
    }

    // Track completion
    if (event.eventType === 'audit:document-archived') {
      jobMap[jobId].status = 'completed';
      jobMap[jobId].isCompliant = !jobMap[jobId].errorCount;
    }
  }

  // Filter by status if needed
  const jobs = Object.values(jobMap).filter((job) => {
    if (params.status === 'all') return true;
    if (params.status === 'compliant') return job.isCompliant && job.status === 'completed';
    if (params.status === 'non-compliant') return !job.isCompliant || job.errorCount > 0;
    if (params.status === 'pending') return job.status === 'pending';
    return true;
  });

  return {
    reportGenerated: new Date().toISOString(),
    dateRange: {
      start: params.startDate.toISOString(),
      end: params.endDate.toISOString(),
    },
    filters: {
      jobId: params.jobId,
      employeeEmail: params.employeeEmail,
      status: params.status,
    },
    summary: {
      totalJobs: jobs.length,
      totalEvents: events.length,
      completedJobs: jobs.filter((j) => j.status === 'completed').length,
      pendingJobs: jobs.filter((j) => j.status === 'pending').length,
      compliantJobs: jobs.filter((j) => j.isCompliant).length,
      nonCompliantJobs: jobs.filter((j) => !j.isCompliant).length,
      totalErrors: jobs.reduce((sum, j) => sum + j.errorCount, 0),
    },
    jobs: jobs.slice(params.skip, params.skip + params.limit),
    pagination: {
      skip: params.skip,
      limit: params.limit,
      hasMore: params.skip + params.limit < jobs.length,
    },
  };
}

/**
 * Export report as CSV.
 */
function _exportAsCSV(report) {
  const rows = [
    ['Job ID', 'Employee Name', 'Email', 'Status', 'Compliant', 'First Event', 'Last Event', 'Error Count'],
  ];

  for (const job of report.jobs) {
    rows.push([
      job.jobId,
      `${job.firstName || ''} ${job.lastName || ''}`,
      job.workEmail || '',
      job.status,
      job.isCompliant ? 'Yes' : 'No',
      job.firstEvent,
      job.lastEvent,
      job.errorCount,
    ]);
  }

  // Add summary section
  rows.push([]);
  rows.push(['Summary']);
  rows.push(['Total Jobs', report.summary.totalJobs]);
  rows.push(['Completed', report.summary.completedJobs]);
  rows.push(['Pending', report.summary.pendingJobs]);
  rows.push(['Compliant', report.summary.compliantJobs]);
  rows.push(['Non-Compliant', report.summary.nonCompliantJobs]);
  rows.push(['Total Errors', report.summary.totalErrors]);

  return rows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
}

/**
 * Export report as HTML.
 */
function _exportAsHTML(report) {
  const timestamp = new Date(report.reportGenerated).toLocaleString();

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DocFlow Audit Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 30px; }
    .header { border-bottom: 3px solid #2196F3; padding-bottom: 20px; margin-bottom: 30px; }
    .header h1 { color: #2196F3; margin-bottom: 10px; }
    .header p { color: #666; font-size: 14px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .summary-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; }
    .summary-card.green { background: linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%); color: #333; }
    .summary-card.red { background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); color: #333; }
    .summary-card h3 { font-size: 32px; font-weight: bold; margin-bottom: 5px; }
    .summary-card p { font-size: 14px; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
    th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #2196F3; }
    td { padding: 12px; border-bottom: 1px solid #ddd; }
    tr:hover { background: #f9f9f9; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge.completed { background: #4CAF50; color: white; }
    .badge.pending { background: #FF9800; color: white; }
    .badge.compliant { background: #4CAF50; color: white; }
    .badge.non-compliant { background: #f44336; color: white; }
    .date-range { color: #666; font-size: 13px; margin-bottom: 20px; }
    @media print { body { background: white; } .container { box-shadow: none; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>DocFlow Audit Report</h1>
      <p>Generated: ${timestamp}</p>
      <div class="date-range">
        Date Range: ${new Date(report.dateRange.start).toLocaleDateString()} to ${new Date(report.dateRange.end).toLocaleDateString()}
      </div>
    </div>

    <div class="summary-grid">
      <div class="summary-card">
        <h3>${report.summary.totalJobs}</h3>
        <p>Total Jobs</p>
      </div>
      <div class="summary-card green">
        <h3>${report.summary.compliantJobs}</h3>
        <p>Compliant</p>
      </div>
      <div class="summary-card red">
        <h3>${report.summary.nonCompliantJobs}</h3>
        <p>Non-Compliant</p>
      </div>
      <div class="summary-card">
        <h3>${report.summary.totalErrors}</h3>
        <p>Errors</p>
      </div>
    </div>

    <h2 style="margin-top: 30px; margin-bottom: 20px; color: #2196F3;">Job Details</h2>
    <table>
      <thead>
        <tr>
          <th>Job ID</th>
          <th>Employee</th>
          <th>Email</th>
          <th>Status</th>
          <th>Compliant</th>
          <th>Errors</th>
          <th>Timeline</th>
        </tr>
      </thead>
      <tbody>
        ${report.jobs.map((job) => `
          <tr>
            <td><code>${job.jobId.substring(0, 12)}...</code></td>
            <td>${job.firstName && job.lastName ? `${job.firstName} ${job.lastName}` : 'Unknown'}</td>
            <td>${job.workEmail || '-'}</td>
            <td><span class="badge ${job.status}">${job.status}</span></td>
            <td><span class="badge ${job.isCompliant ? 'compliant' : 'non-compliant'}">${job.isCompliant ? 'Yes' : 'No'}</span></td>
            <td>${job.errorCount}</td>
            <td style="font-size: 12px; color: #666;">${new Date(job.firstEvent).toLocaleDateString()}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div style="text-align: center; color: #999; font-size: 12px; margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd;">
      <p>This is a confidential audit report. Do not distribute without authorization.</p>
    </div>
  </div>
</body>
</html>
  `;

  return html;
}

/**
 * Get content type for format.
 */
function _getContentType(format) {
  const types = {
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    pdf: 'application/pdf',
  };
  return types[format] || 'application/octet-stream';
}
