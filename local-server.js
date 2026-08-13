const http = require('http');

const PORT = 7071;

const server = http.createServer(async (req, res) => {
  const now = new Date().toISOString();
  console.log(`${now} ${req.method} ${req.url}`);

  try {
    if (req.url === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      return;
    }

    if (req.url === '/api/mondayWebhook' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        console.log('Monday webhook received:', body.substring(0, 100));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'webhook received' }));
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('Error:', err);
    res.writeHead(500);
    res.end('Error');
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('✅ DocFlow LOCAL SERVER RUNNING');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Endpoints:');
  console.log('  Health: http://localhost:7071/api/health');
  console.log('  Monday: http://localhost:7071/api/mondayWebhook');
  console.log('');
  console.log('To test Monday webhook:');
  console.log('  1. Get your local IP: ipconfig | findstr IPv4');
  console.log('  2. Wire Monday to: http://YOUR_IP:7071/api/mondayWebhook');
  console.log('  3. Check "Generate Docs" on test hire in Monday');
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');
});
