// DOCFLOW LOCAL SERVER - Simple version that works
// Run: node server.js
// Then expose with ngrok: ngrok http 3000

const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Simple handlers
const handlers = {
  '/api/health': (context) => {
    context.res = {
      status: 200,
      body: { status: 'ok', message: 'DocFlow running locally', timestamp: new Date().toISOString() }
    };
  },

  '/api/ping': (context) => {
    context.res = { status: 200, body: { ok: true, message: 'pong' } };
  },

  '/api/mondayWebhook': (context) => {
    const body = context.req.body;

    // Monday webhook handshake
    if (body.challenge) {
      context.res = { status: 200, body: { challenge: body.challenge } };
      return;
    }

    // Real webhook event
    console.log(`  📬 Monday webhook: event=${body.event?.type}, item=${body.payload?.itemId}`);

    context.res = {
      status: 200,
      body: { success: true, message: 'Webhook received - processing...', itemId: body.payload?.itemId }
    };

    // In production, this would queue tasks
    // For now, just acknowledge
  },

  '/api/validateADP': (context) => {
    const body = context.req.body;
    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'ADP validation complete',
        fieldsValidated: 25,
        errors: []
      }
    };
  },

  '/api/generatePDF': (context) => {
    const body = context.req.body;
    context.res = {
      status: 202,
      body: {
        success: true,
        message: 'PDF generation queued',
        pdfUrl: 'https://example.com/pdf/offer.pdf'
      }
    };
  },

  '/api/sendForSign': (context) => {
    const body = context.req.body;
    context.res = {
      status: 202,
      body: {
        success: true,
        message: 'Sent to signers (HR → Manager → Employee)',
        agreementId: 'CBJCHBCAABAAygvx',
        status: 'SENT_FOR_SIGNATURE'
      }
    };
  },

  '/api/archiveToBlob': (context) => {
    const body = context.req.body;
    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'PDF archived to blob storage',
        path: '/docflow/2026/08/jane-doe/signed.pdf'
      }
    };
  },

  '/api/updateMonday': (context) => {
    const body = context.req.body;
    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Monday status updated',
        newStatus: 'Onboarding Complete'
      }
    };
  }
};

// Create server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Find handler
  const handler = handlers[pathname];

  if (!handler) {
    console.log(`  ✗ Not found: ${pathname}`);
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found', available: Object.keys(handlers) }));
    return;
  }

  try {
    // Parse body
    let body = '';
    req.on('data', chunk => { body += chunk; });

    req.on('end', async () => {
      try {
        const context = {
          req: {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body ? JSON.parse(body) : {},
          },
          res: { status: 200, body: {} },
        };

        // Call handler
        await handler(context);

        console.log(`  ✓ HTTP ${context.res.status}`);
        res.writeHead(context.res.status || 200);
        res.end(JSON.stringify(context.res.body));
      } catch (err) {
        console.error(`  ✗ Error:`, err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } catch (err) {
    console.error(`Error:`, err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Start
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                  🚀 DOCFLOW LOCAL SERVER                       ║
╚════════════════════════════════════════════════════════════════╝

✓ Server running: http://localhost:${PORT}

📌 ENDPOINTS:
  /api/health           → Health check
  /api/mondayWebhook    → Monday webhook receiver
  /api/validateADP      → Validate fields
  /api/generatePDF      → Generate PDF
  /api/sendForSign      → Send to signers
  /api/archiveToBlob    → Archive PDF
  /api/updateMonday     → Update status
  /api/ping             → Ping test

🌐 TO GO PUBLIC:
  ngrok http ${PORT}

  Then update Monday webhook with ngrok URL:
  https://your-ngrok-url.ngrok.io/api/mondayWebhook

════════════════════════════════════════════════════════════════
`);
});

process.on('SIGINT', () => {
  console.log('\n✓ Shutting down...');
  process.exit(0);
});
