# MammaMia vs StreamFusionMail: DeltaBit/Eurostreaming Comparison

## Critical Findings

### 1. MammaMia Flow (Python)
- **Location**: `tmp_mammamia/Src/API/eurostreaming.py`
- **Link Resolution**:
  1. Extracts href regex pattern from episode HTML for target host (DeltaBit/MixDrop/MaxStream)
  2. Calls `get_host_link()` → follows redirects up to 5 times with `client.get()` + `Range: bytes=0-0`
  3. When safego detected, calls `real_page()` to solve captcha
  4. Uses **file-based cookie persistence** (`cookie.txt`)
  5. Captcha solved via **Tesseract OCR** (pytesseract - server-side dependency)
- **Turbovid Extraction** (via `deltabit()` extractor - not shown but referenced):
  - Gets Turbovid page after safego bypass
  - Extracts form fields
  - POSTs form with `imhuman=""` field
  - **Explicitly waits 5 seconds** (required by Turbovid JS protection)
  - Unpacks PACKER-encoded JS to extract `sources:[]` array

### 2. Our Flow (JavaScript)
- **Location**: `src/eurostreaming/index.js` + `src/extractors/turbovidda.js`
- **Link Resolution**:
  1. Same HTML regex extraction
  2. Calls `resolveHostLink()` → follows redirects up to 6 times
  3. When safego detected, calls `bypassSafego()`
  4. Uses **in-memory cache** (3-hour TTL) + env var fallback
  5. Captcha solved via **OCR.space API** (external) with pixel-based fallback
- **Turbovid Extraction**:
  - Same flow but **wait only 2.5 seconds** (vs MammaMia's 5s)
  - Form submission identical
  - PACKER unpacking identical
  - URL extraction patterns: `sources:[...]` or `file:...`

## Key Differences

| Aspect | MammaMia | StreamFusionMail | Issue for Vercel |
|--------|----------|------------------|------------------|
| **Safego Cookies** | File-based (`cookie.txt`) | In-memory + env fallback | ⚠️ Cookies lost on cold start; no persistence |
| **OCR** | Tesseract (server-side) | OCR.space API + pixel fallback | ⚠️ External API call; rate-limited; network latency |
| **OCR Fallback** | N/A (Tesseract required) | Pixel-based algorithm | ✓ Good |
| **Safego Bypass** | Manual file logic | Sophisticated multi-step (8 hops) | ✓ More robust |
| **Turbo Wait** | 5 seconds | 2.5 seconds | ❌ **May timeout if JS not ready** |
| **Redirect Hops** | 5 max | 6 max | ✓ Same order of magnitude |
| **Error Recovery** | MixDrop fallback in code | MixDrop fallback in code | ✓ Both have it |

## Vercel-Specific Problems

### 1. **Safego Cookie Persistence (CRITICAL)**
**Problem**: In-memory cache on Vercel creates new process per invocation
- Cold start = empty `_safegoCache`
- Cookies not in env vars = must re-solve captcha every time
- OCR.space API rate limit hit quickly (free tier: 25 req/day or 100 concurrent)
- **Symptom**: Frequent "Safego bypass failed" errors

**MammaMia Advantage**:
- File cookies persist across server restarts
- Can cache cookies for the entire server lifetime

**Fix Needed**:
- Store cookies in Redis/external cache OR
- Pre-inject `SAFEGO_PHPSESSID` + `SAFEGO_CAPTCH5` env vars from persistent source

### 2. **OCR.space API Dependency (HIGH RISK)**
```javascript
const ocrResp = await fetch('https://api.ocr.space/parse/image', {
  method: 'POST',
  body: ocrForm,
  signal: AbortSignal.timeout(10000), // 10s timeout
});
```

**Problems**:
- External HTTP call to unpredictable API
- Free tier: 25 requests/day limit
- Network latency on serverless (no connection pooling)
- **Vercel timeout**: 10s OCR + 2.5s upload + network = too close to function timeout
- If OCR.space fails, falls back to pixel-based (slower, less reliable)

**MammaMia Advantage**:
- Local Tesseract = predictable speed (~1-2s per captcha)
- No external API calls = no rate limiting
- Fast and reliable

**Mitigation**:
- Cache pre-solved capltcha images with their answers
- Use paid OCR service with higher rate limit
- Disable OCR.space; rely on pixel-based only (faster fallback)

### 3. **Wait Time Too Short (MEDIUM RISK)**
```javascript
await new Promise((r) => setTimeout(r, 2500)); // 2.5 seconds
```

**Problem**:
- MammaMia waits 5 seconds; we wait 2.5 seconds
- Turbovid's client-side JS protection may not finish in 2.5s
- If JS timer not complete, POST returns wrong data
- **Symptom**: Unpacking fails → returns null → "no stream found"

**Evidence**: MammaMia code explicitly mentions "required by Turbovid's JS protection"

**Fix**: Increase to 4-5 seconds or detect JS readiness (check page for completion marker)

### 4. **Stateless Environment (MEDIUM RISK)**
- Vercel functions are transient
- Env vars are the only cross-request state
- Each cold start = new process = new in-memory cache
- **Result**: Every first request to each function instance must re-solve captcha

## Recommendation Priority

### High Priority
1. **Pre-solve and cache safego captcha**
   - Store as env var or Redis
   - Update monthly or on failure
   - Eliminates cold start penalty

2. **Increase Turbovid wait from 2.5s → 4s**
   - Simple 1-line change
   - Reduces "no stream found" failures

### Medium Priority
3. **Replace OCR.space with cached pixel-based OCR**
   - Remove external API call
   - Use pixel algorithm as primary (already implemented)
   - Faster, no rate limiting

4. **Add healthcheck endpoint**
   - Pre-check safego before user requests
   - Detect if captcha refresh needed

### Lower Priority
5. **Redis cookie store** (if budget allows)
   - Cross-instance cookie sharing
   - Handles all future safego issues

## Summary
MammaMia's file-based persistence + server-resident Tesseract are optimized for traditional servers. Our in-memory cache + external OCR API are vulnerable on serverless. The 2.5s wait is also risky for Turbovid's JS timer.

**Root cause of Vercel failures**: Every cold start forces captcha re-solve due to empty cache + OCR.space rate limiting.
