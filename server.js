'use strict';

const express = require('express');
const app = express();

// Middleware
app.use(express.json());

// Import all functions
const mondayWebhook = require('./src/functions/mondayWebhook');
const generatePDF = require('./src/functions/generatePDF');
const sendForSign = require('./src/functions/sendForSign');
const adobeWebhook = require('./src/functions/adobeWebhook');
const downloadSigned = require('./src/functions/downloadSigned');
const archiveToBlob = require('./src/functions/archiveToBlob');
const updateMonday = require('./src/functions/updateMonday');
const health = require('./src/functions/health');
const signPoller = require('./src/functions/signPoller');
const cleanup = require('./src/functions/cleanup');
const createADPUser = require('./src/functions/createADPUser');
const validateADP = require('./src/functions/validateADP');
const queue = require('./src/lib/queue');
const logger = require('./src/lib/logger');

// Mock Azure Functions context for Express
function createFunctionContext(expressReq) {
  const context = {
    req: expressReq,
    res: undefined,
    bindings: {},
    done: () => {}, // No-op for compatibility
    log: console.log,
  };
  return context;
}

// Helper to handle queue bindings
async function handleQueueBinding(queueName, message) {
  try {
    if (message && queueName === 'generateQueue') {
      await queue.enqueue('docflow-generate', message);
    }
  } catch (err) {
    logger.error('queue-binding-failed', err);
  }
}

// Routes - HTTP Triggers
app.post('/api/mondayWebhook', async (req, res) => {
  try {
    const context = createFunctionContext(req);
    await mondayWebhook(context, req);

    // Handle any queue bindings that were set
    if (context.bindings.generateQueue) {
      await handleQueueBinding('generateQueue', context.bindings.generateQueue);
    }

    // Send response
    if (context.res) {
      res.status(context.res.status || 200)
         .set(context.res.headers || { 'Content-Type': 'application/json' })
         .json(context.res.body || {});
    } else {
      res.status(200).json({ ok: true });
    }
  } catch (err) {
    logger.error('mondayWebhook-error', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const context = createFunctionContext(req);
    await health(context);

    if (context.res) {
      res.status(context.res.status || 200)
         .set(context.res.headers || { 'Content-Type': 'application/json' })
         .json(context.res.body || {});
    } else {
      res.status(200).json({ status: 'ok' });
    }
  } catch (err) {
    logger.error('health-error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/adobeWebhook', async (req, res) => {
  try {
    const context = createFunctionContext(req);
    await adobeWebhook(context, req);

    if (context.res) {
      res.status(context.res.status || 200)
         .set(context.res.headers || { 'Content-Type': 'application/json' })
         .json(context.res.body || {});
    } else {
      res.status(200).json({ ok: true });
    }
  } catch (err) {
    logger.error('adobeWebhook-error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/validateADP', async (req, res) => {
  try {
    const context = createFunctionContext(req);
    await validateADP(context, req);

    if (context.res) {
      res.status(context.res.status || 200)
         .set(context.res.headers || { 'Content-Type': 'application/json' })
         .json(context.res.body || {});
    } else {
      res.status(200).json({ ok: true });
    }
  } catch (err) {
    logger.error('validateADP-error', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check for Azure App Service
app.get('/', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'DocFlow' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ DocFlow server running on port ${PORT}`);
  console.log(`📡 Webhook: POST /api/mondayWebhook`);
  console.log(`🏥 Health: GET /api/health`);
});

module.exports = app;
