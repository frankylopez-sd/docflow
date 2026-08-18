# PDF Generation Templates & Adobe Integration Verification Report

## Critical Findings

### 1. **Function Mismatch in generatePDF/index.js**
**Location:** `/c/Users/Franky.Lopez/docflow/src/functions/generatePDF/index.js:44`

**Issue:** Calls non-existent function `adobe.generateOfferLetter(mergeData)`

**Actual Available Function:** `adobe.createPDF(templateId, data, schema)`

**Problem:** 
- `generateOfferLetter()` is never exported from adobe.js or adobeWithBreaker.js
- The actual function signature requires `templateId` as the first parameter
- Current code has no mechanism to resolve which PDF Services template ID to use

**Code:**
```javascript
// Current (BROKEN):
const pdfBuffer = await adobe.generateOfferLetter(mergeData);

// Expected:
const pdfBuffer = await adobe.createPDF(templateId, mergeData);
```

**Impact:** 
- PDF generation will fail with "TypeError: adobe.generateOfferLetter is not a function"
- Entire onboarding workflow blocks at PDF generation stage

---

### 2. **Function Mismatch in sendForSign/index.js**
**Location:** `/c/Users/Franky.Lopez/docflow/src/functions/sendForSign/index.js:49`

**Issue:** Calls non-existent function `adobe.createSigningAgreement({})`

**Actual Available Function:** `adobe.createEnvelope(pdf, signers, opts)`

**Problem:**
- `createSigningAgreement()` is never exported from adobe.js or adobeWithBreaker.js
- Function signature is completely different
- Parameter structure doesn't match Adobe API expectations

**Code:**
```javascript
// Current (BROKEN):
const agreementResult = await adobe.createSigningAgreement({
  documentUrl: pdfUrl,
  fileName: `offer-${firstName}-${lastName}.pdf`,
  signers: signers,
  message: `...`,
  dueDate: new Date(...)
});
const agreementId = agreementResult.id;

// Expected pattern (from adobe.js):
const envelope = await adobe.createEnvelope(pdfUrl, signers, {
  name: 'DocFlow Agreement',
  fileName: `offer-${firstName}-${lastName}.pdf`,
  message: `Please review and sign the offer letter...`
});
const agreementId = envelope.agreementId;
```

**Impact:**
- Adobe Sign envelope creation will fail
- Signing process never starts
- Secondary workflow completely broken

---

### 3. **Missing Template ID Resolution**
**Location:** `generatePDF/index.js` - no template selection logic

**Issue:** 
- `generatePDF` function receives only basic hire data (firstName, lastName, email, etc.)
- No mechanism to determine which Adobe PDF Services template to use
- `monday.readTemplates()` exists but is never called

**Expected Flow:**
1. Queue message contains itemId + boardId
2. Fetch item details from Monday to get template column value
3. Look up template in Monday template catalog board
4. Extract adobeTemplateId from catalog
5. Pass to `adobe.createPDF(adobeTemplateId, mergeData)`

**Current Flow:**
- Missing step: No template ID resolution at all
- Function signature mismatch prevents even getting to this issue

---

### 4. **Missing Hire Data Enrichment**
**Location:** `generatePDF/index.js` - data source mismatch

**Issue:**
- Queue message from mondayWebhook only contains: `{ boardId, itemId, eventType, receivedAt, userId }`
- `generatePDF` tries to destructure rich hire data from queueItem: `{ firstName, lastName, workEmail, adpJobTitle, ... }`
- This data is never populated

**Expected Flow:**
```javascript
const item = await monday.readRow(boardId, itemId);
const mergeData = {
  firstName: item.byTitle['First Name'],
  lastName: item.byTitle['Last Name'],
  // ... map other columns
};
```

---

## Adobe Integration Verification Summary

### ✅ Correctly Implemented
- **Token management** (oauth + caching with 10-min refresh margin)
- **PDF Services integration** (document generation with polling)
- **Adobe Sign envelope creation** (with serial signing order)
- **Rate limiting** (per-service limits with async acquisition)
- **Circuit breaker wrapper** (comprehensive error handling)
- **Merge field validation** (required field enforcement)
- **Webhook registration** (idempotent Adobe Sign events)
- **Signed PDF retrieval** (with retry logic)

### ❌ Broken Function Calls
- `generatePDF` → calling `adobe.generateOfferLetter()` ✗ DOES NOT EXIST
- `sendForSign` → calling `adobe.createSigningAgreement()` ✗ DOES NOT EXIST

### ⚠️ Incomplete/Missing Integrations
- **Template resolution** - no logic to select template ID
- **Hire data enrichment** - no fetch of item details from Monday
- **Merge field validation** - template schema not passed to `createPDF()`
- **Error handling** - function failures not mapping to Monday status properly

---

## Severity Assessment

| Issue | Severity | Impact | Status |
|-------|----------|--------|--------|
| `generateOfferLetter()` call | **CRITICAL** | PDF generation fails completely | BLOCKING |
| `createSigningAgreement()` call | **CRITICAL** | Signing workflow fails | BLOCKING |
| Missing template resolution | **CRITICAL** | Can't determine template to use | BLOCKING |
| Missing hire data enrichment | **CRITICAL** | No data for merge fields | BLOCKING |
| Merge field validation | **HIGH** | Silent failures if data missing | POST-FIX |

---

## Remediation Path

1. **Extract item details** in `generatePDF` before building merge data
2. **Read templates** from Monday catalog to get Adobe template ID
3. **Replace function calls:**
   - `adobe.generateOfferLetter()` → `adobe.createPDF(templateId, mergeData, schema)`
   - `adobe.createSigningAgreement()` → `adobe.createEnvelope(pdfBuffer, signers, opts)`
4. **Pass schema** to `createPDF()` for merge field validation
5. **Update Monday statuses** with proper error messages on failure

