# DOCFLOW LOCAL SERVER - Complete Setup Guide

## What This Is
Instead of deploying to Azure Functions (which is having issues), run DocFlow as a local Node.js server on your machine and expose it publicly with ngrok. **Works exactly the same way, but faster to set up and test.**

---

## 🚀 QUICK START (5 minutes)

### Step 1: Start the Local Server
```bash
cd C:\Users\Franky.Lopez\docflow

# Option A (easiest): Double-click
START_LOCAL_SERVER.bat

# Option B (command line):
node server.js
```

You should see:
```
✓ Server running on: http://localhost:3000

📌 ENDPOINTS AVAILABLE:
  GET  /api/health
  POST /api/mondayWebhook
  ...
```

### Step 2: Expose Publicly with ngrok
In a NEW terminal:
```bash
# Install ngrok (one-time)
npm install -g ngrok

# Expose your local server
ngrok http 3000
```

You'll see:
```
Session Status                online
Forwarding                    https://abc123def456.ngrok.io -> http://localhost:3000
```

**Copy the HTTPS URL** (e.g., `https://abc123def456.ngrok.io`)

### Step 3: Wire to Monday Webhook
1. Go to **Monday.com** → **Onboarding Board (18422046530)**
2. Click **Settings** (⚙️ icon)
3. Select **Integrations** → **Webhooks** → **Add Webhook**
4. Fill in:
   - **URL:** `https://abc123def456.ngrok.io/api/mondayWebhook` (use YOUR ngrok URL)
   - **Events:** Check "Item created" and "Item updated"
   - **Name:** DocFlow Automation
5. Click **Save**
6. You should see ✓ "Active" status

### Step 4: Test with Your Monday Test Hire
The test hire (Jane Doe - Test Hire) is already in Monday!

**The workflow will:**
1. ✓ Monday webhook fires
2. ✓ Validates 25 ADP fields
3. ✓ Generates PDF with Adobe
4. ✓ Sends to 3 signers (serial)
5. ✓ Archives signed PDF
6. ✓ Updates Monday status → "Onboarding Complete"

**Timeline:** 5-15 minutes for full automation

---

## 📊 What Happens When It Works

1. **Monday item created/updated** → Monday sends webhook to your ngrok URL
2. **Local server receives it** → Calls appropriate function (validateADP, generatePDF, etc.)
3. **Functions execute** → Validation, PDF generation, signing
4. **Status updates** → Monday board automatically shows progress
5. **End result** → PDF URL and Agreement ID appear in Monday

---

## 🔧 ENVIRONMENT VARIABLES

The server reads these from your Windows environment:

```
MONDAY_API_TOKEN = your_monday_token
ADOBE_CLIENT_ID = your_adobe_id
ADOBE_CLIENT_SECRET = your_adobe_secret
STORAGE_ACCOUNT_NAME = docautomationstore
```

Already set? Great! Server will use them.
Not set? Server still runs but some features won't work (that's OK for testing).

---

## 🧪 Testing Endpoints Manually

Open another terminal:

```bash
# Test health
curl http://localhost:3000/api/health

# Test webhook (simulated Monday event)
curl -X POST http://localhost:3000/api/mondayWebhook \
  -H "Content-Type: application/json" \
  -d '{"event":"item_created"}'

# Test ping
curl http://localhost:3000/api/ping
```

---

## 📱 Monitoring

Watch the server logs in your terminal:
```
[2026-08-18T05:30:00Z] POST /api/mondayWebhook
  ✓ 200
[2026-08-18T05:30:05Z] POST /api/validateADP
  ✓ 200
```

Each request shows:
- Method (GET/POST)
- Endpoint
- Response status
- ✓ Success or ✗ Error

---

## ⚠️ Important Notes

1. **ngrok URL changes every time** you restart ngrok
   - If you restart, update the Monday webhook with the new URL

2. **Keep both terminals open**
   - Terminal 1: `node server.js` (local server)
   - Terminal 2: `ngrok http 3000` (public tunnel)

3. **For production:** Eventually deploy to Azure or similar
   - This local setup is for testing/development
   - Once working, move to Azure Functions

4. **Firewall:** Make sure port 3000 isn't blocked
   - Windows Defender might ask → Allow it

---

## 🚨 Troubleshooting

**"ngrok command not found"**
```bash
npm install -g ngrok
```

**"Port 3000 already in use"**
```bash
# Use different port:
node server.js --port 4000
# Then ngrok http 4000
```

**"Monday webhook not firing"**
1. Check ngrok status (should show "online")
2. Verify webhook URL in Monday settings
3. Check server logs in terminal

**"500 errors on functions"**
1. Check that environment variables are set
2. Look at server logs for specific error
3. Verify adobe.js and monday.js modules exist

---

## ✅ Success Criteria

When everything works:
- ✓ Server responds to health checks (HTTP 200)
- ✓ Monday webhook fires when you update items
- ✓ Server logs show requests coming in
- ✓ Jane Doe test hire status changes in Monday
- ✓ PDF URL appears in Monday
- ✓ Adobe Agreement ID appears in Monday
- ✓ Status reaches "Onboarding Complete"

---

## 📞 Next Steps

1. **Start server** → `node server.js`
2. **Expose publicly** → `ngrok http 3000`
3. **Wire to Monday** → Add webhook with ngrok URL
4. **Test** → Update Jane Doe item in Monday
5. **Monitor** → Watch server logs and Monday board

Once this works locally, we can move to Azure Functions or keep running locally!

---

**Questions?** Check the server logs - they tell you exactly what's happening.
