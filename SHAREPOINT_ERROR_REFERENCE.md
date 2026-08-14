# SharePoint Integration — Error Reference & Handling

Quick lookup for Graph API error codes and remediation strategies.

## HTTP Status Codes

| Code | Meaning | Retryable | Action |
|------|---------|-----------|--------|
| **200** | OK | N/A | Success path |
| **204** | No Content | N/A | Success (delete/empty response) |
| **400** | Bad Request | ❌ No | Fix request body/params; redeploy |
| **401** | Unauthorized | ❌ No | Rotate client secret |
| **403** | Forbidden | ❌ No | Grant app role to SharePoint |
| **404** | Not Found | ⚠️ Context | Create missing folder/file |
| **408** | Request Timeout | ✅ Yes | Retry with backoff |
| **409** | Conflict | ⚠️ Context | File exists; use conflictBehavior |
| **429** | Too Many Requests | ✅ Yes | Respect Retry-After header |
| **500** | Internal Server Error | ✅ Yes | Retry; escalate if persistent |
| **502** | Bad Gateway | ✅ Yes | Retry; typically transient |
| **503** | Service Unavailable | ✅ Yes | Retry; check status page |
| **504** | Gateway Timeout | ✅ Yes | Retry with longer backoff |

## Graph API Error Response Format

```json
{
  "error": {
    "code": "itemNotFound",
    "message": "The item does not exist",
    "innerError": {
      "date": "2026-08-13T18:30:00Z",
      "request-id": "uuid-here",
      "client-request-id": "uuid-here"
    }
  }
}
```

### Extract Error Code

```javascript
const graphErr = err.response?.data?.error?.code || 'unknown';
const retryAfter = parseInt(err.response?.headers['retry-after'] || '60', 10);
```

## Common Error Codes & Solutions

### `invalidRequest`
**Message:** "Invalid request syntax"
**Cause:** Malformed request body or headers
**Fix:**
- Validate JSON syntax
- Check required fields
- Example:
  ```javascript
  // ❌ WRONG: name is missing
  POST /drives/{driveId}/items/{parentId}/children
  { "folder": {} }

  // ✅ CORRECT:
  POST /drives/{driveId}/items/{parentId}/children
  { "name": "FolderName", "folder": {} }
  ```

### `itemNotFound`
**Message:** "The item does not exist"
**Cause:** Referenced folder/file/site doesn't exist
**Fix:**
```javascript
// Retry logic in uploadPDF
try {
  const existing = await graphRequest('GET', `/drives/${driveId}/items/${folderId}`);
} catch (err) {
  if (err.graphStatus === 404) {
    // Create the folder
    await createFolderPath(driveId, folderPath);
  }
}
```

### `accessDenied`
**Message:** "Access denied. Check consent and assignment."
**Cause:** App doesn't have permission to resource
**Fix:**
1. Check app has `Sites.ReadWrite.All` permission
2. Grant app role to SharePoint site:
   ```powershell
   # As SharePoint admin
   Add-PnPGroupMember -Group "Owners" -LoginName "app-uuid@[tenant].onmicrosoft.com"
   ```
3. Or, limit to specific site:
   - Azure AD > App > API permissions > Sites.Selected
   - SharePoint admin > Advanced > Grant app role

### `tokenNotFound` / `authenticationError`
**Message:** "Invalid or expired token"
**Cause:** Token expired, invalid secret, or permission revoked
**Fix:**
```javascript
// Token cache invalidation on auth error
if (err.graphStatus === 401) {
  sharepoint._resetTokenCache();
  retry(getAccessToken);
}
```

### `throttledRequest` / 429 Too Many Requests
**Message:** "Request throttled; retry after {N} seconds"
**Cause:** Exceeded rate limit (600 req/min tenant-wide)
**Fix:**
```javascript
// Already handled in graphRequest:
if (err.response?.status === 429) {
  const retryAfter = parseInt(err.response.headers['retry-after'] || '60', 10) * 1000;
  await sleep(retryAfter);
  return retry(fn); // retry at full backoff
}

// For prevention:
// - Add jitter to retries
// - Distribute uploads over time (don't batch all at once)
// - Use queue-based model (✅ our approach)
```

### `invalidRange` / `contentLengthMissing`
**Message:** "Upload range is invalid" or "Content-Length header required"
**Cause:** File size mismatch or streaming headers
**Fix:**
```javascript
// Ensure Buffer has valid size
if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
  throw new Error('File buffer is empty');
}

// Set explicit Content-Length
headers: {
  'Content-Type': 'application/pdf',
  'Content-Length': fileBuffer.length, // Explicit size
}
```

### `notImplemented`
**Message:** "Feature not available in this API version"
**Cause:** Using deprecated or beta API endpoints
**Fix:**
- Always use `/v1.0` (production), not `/beta`
- Check [Graph API changelog](https://learn.microsoft.com/en-us/graph/changelog)
- Example:
  ```javascript
  // ❌ WRONG (beta)
  const url = `https://graph.microsoft.com/beta/drives/${driveId}/...`

  // ✅ CORRECT (v1.0)
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/...`
  ```

## Retry Logic Decision Tree

```
Error Occurs
    ↓
Is it a network error?
├─ ETIMEDOUT, ECONNRESET, ENOTFOUND? → RETRY
└─ No
    ↓
Is it HTTP 5xx?
├─ Yes (500, 502, 503, 504)? → RETRY
└─ No
    ↓
Is it HTTP 429?
├─ Yes (Throttled)? → RETRY after Retry-After header
└─ No
    ↓
Is it HTTP 408?
├─ Yes (Request Timeout)? → RETRY
└─ No
    ↓
Is it HTTP 4xx?
├─ 400, 401, 403, 404, 409? → DON'T RETRY (fix + redeploy)
└─ No
    ↓
Unknown error? → LOG + THROW
```

## Transient vs. Permanent Errors

### Transient (Retryable)

```javascript
// In util.js
function _isTransient(err) {
  if (err.transient === true) return true;
  if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code)) return true;
  const status = err?.response?.status;
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}
```

**Examples:**
- Network timeouts
- Server overload (429, 503)
- Temporary Azure outage
- Token cache invalidation (401 → refresh token → retry)

### Permanent (Non-Retryable)

```javascript
const permanentErrors = {
  '400': 'Invalid request body — fix code',
  '403': 'Permission denied — grant app role',
  '404': 'Item not found — create it',
  '409': 'Conflict — use conflictBehavior: "rename"',
};
```

**Examples:**
- Malformed requests
- Missing permissions
- Invalid configuration
- Caller bugs (bad JSON, wrong parameter names)

## Error Handling Patterns

### Pattern 1: Retry with Exponential Backoff

```javascript
// Already used in sharepoint.js::graphRequest()
async function makeRequest(url, options) {
  const maxRetries = 3;
  const baseDelay = 500; // ms

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios(url, options);
    } catch (err) {
      if (!_isTransient(err) || attempt >= maxRetries) {
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt); // 500, 1000, 2000, 4000
      await sleep(delay);
    }
  }
}
```

### Pattern 2: Non-Blocking Fallback

```javascript
// Used for Monday.com updates after SharePoint success
try {
  await sharepoint.uploadPDF(buffer, metadata);
  // ✅ Success — now update Monday
  await monday.updateStatus(boardId, itemId, { link: spUrl });
} catch (spErr) {
  // SharePoint failed → propagate
  throw spErr;
}

// In uploadToSharePoint function:
try {
  const spUpload = await sharepoint.uploadPDF(...);
} catch (err) {
  throw err; // Fail the queue message → DLQ
}

// But Monday update is non-blocking:
try {
  await monday.updateStatus(...);
} catch (mondayErr) {
  logger.warn('monday-update-failed', mondayErr);
  // Don't throw — we already have the file in SharePoint
}
```

### Pattern 3: Idempotency (Safe to Retry)

```javascript
// SharePoint upload with conflictBehavior
const uploadData = {
  '@microsoft.graph.conflictBehavior': 'rename', // Safe if retried
  name: fileName,
  // ... other fields
};

// Result: if called twice, second call creates "fileName (2).pdf"
// No duplicate overwrites or data loss
```

### Pattern 4: Dead-Letter Queue (DLQ) Handling

```javascript
// Azure Functions auto-routes poison messages to DLQ:
// 1. If exception thrown from trigger, message is retried
// 2. After max retries (default 5), message moves to {queue-name}-poison
// 3. Manual inspection + replay via Storage Explorer

// To replay from DLQ:
// 1. Copy message from {queue}-poison
// 2. Delete original poison message
// 3. Add back to main queue
// 4. Function will retry
```

## Monitoring & Observability

### Log Levels by Error Type

```javascript
// TRANSIENT ERRORS (warn level)
logger.warn('retrying:graph-429', { attempt: 2, retryAfterMs: 60000 });

// PERMANENT ERRORS (error level + context)
logger.error('graph-request-failed', err, {
  graphStatus: err.graphStatus,
  graphCode: err.graphData?.error?.code,
  graphMessage: err.graphData?.error?.message,
  url: err.config?.url,
  method: err.config?.method,
});

// SUCCESS (info level)
logger.event('sharepoint-upload-complete', { ... });
```

### Query in Application Insights

```kusto
// Find all GraphErrors
customEvents
| where name startswith "graph-"
| extend ErrorCode = tostring(customDimensions.graphCode)
| summarize Count = count() by ErrorCode
| order by Count desc

// Top failed operations
customEvents
| where name startswith "graph-" and customDimensions.graphStatus >= 400
| summarize Count = count() by tostring(customDimensions.graphStatus)

// Retry exhaustion pattern
exceptions
| where outerMessage contains "retry-exhausted"
| summarize Count = count() by tostring(outerMessage)

// P95 latency (upload operations)
customMetrics
| where name == "graph-request-latency"
| summarize P95 = percentile(value, 95), P99 = percentile(value, 99)
```

## Testing Error Scenarios

### Unit Test: Retry on 429

```javascript
test('retries on 429 with Retry-After', async () => {
  const err429 = new Error('Too Many Requests');
  err429.response = { status: 429, headers: { 'retry-after': '2' } };
  
  axios
    .mockRejectedValueOnce(err429)
    .mockResolvedValueOnce({ data: { id: 'success' } });

  const result = await sharepoint.graphRequest('GET', '/...');
  expect(result.id).toBe('success');
});
```

### Integration Test: DLQ Scenario

```javascript
test('message goes to DLQ after max retries', async () => {
  // Mock all retries to fail
  sharepoint.uploadPDF.mockRejectedValue(new Error('500 Server Error'));

  const context = { 
    invocationId: 'test-123',
    bindings: { queueTrigger: '...' }
  };
  
  // Function throws after retries
  await expect(uploadToSharePoint(context, message))
    .rejects.toThrow('500 Server Error');
  
  // Azure Functions runtime moves message to DLQ
  // (in real environment, check: storage-account/sharepoint-upload-queue-poison)
});
```

## Summary Table

| Error | Cause | Action | Retryable |
|-------|-------|--------|-----------|
| Token 401 | Secret expired | Rotate in Portal | ✅ Refresh |
| 403 Forbidden | No permission | Grant app role | ❌ No |
| 404 Not Found | Folder missing | Create folder | ⚠️ Then retry |
| 409 Conflict | File exists | Use rename behavior | ❌ No (idempotent) |
| 429 Too Many | Rate limited | Respect Retry-After | ✅ Yes |
| 500/503 | Server error | Retry backoff | ✅ Yes |
| Network timeout | Connectivity | Retry + backoff | ✅ Yes |

---

**Document Version:** 1.0  
**Last Updated:** August 2026
