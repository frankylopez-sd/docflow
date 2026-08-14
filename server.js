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

// Routes - HTTP Triggers
app.post('/api/mondayWebhook', async (req, res) => {
  const context = { req, res };
  await mondayWebhook(context);
});

app.get('/api/health', async (req, res) => {
  const context = { req, res };
  await health(context);
});

app.post('/api/adobeWebhook', async (req, res) => {
  const context = { req, res };
  await adobeWebhook(context);
});

app.post('/api/validateADP', async (req, res) => {
  const context = { req, res };
  await validateADP(context);
});

// Health check for Azure App Service
app.get('/', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'DocFlow' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DocFlow server running on port ${PORT}`);
});

module.exports = app;
