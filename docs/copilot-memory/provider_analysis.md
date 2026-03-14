# Provider Deep Dive Analysis

## 1. KISSKH Provider (src/providers/kisskh.js)

### Overview
Korean drama streaming provider (kisskh.do/kisskh.co) with heavy CF WAF protection.

### Static API Keys (Embedded, Long-Lived)
```javascript
EPISODE_KKEY = '1DA20BA0FA767F7FBC784A34E39191A0978830BDC4152695A655BD63A7227408BD1FEA7FCBBA0B80413AD348FADFBF1FFAC32028F7F7C8B5FC7F138BC2CFFC324CF3B8A357AF3C12242329E3AC9458C1FE0F3FA83DB7CC86907707598EC18789D09A02B62FEF850583B58B374BE58CBD1F6257A54C12F176DDF23A33D1AB8ED294'
SUB_KKEY = '43B832ED7618A14320177D239448E8189AAC2F524A0CE644F80C476A5A3F43BB031BAD3AFA35E58F9507DE22A4FB2CC4FC069410DF0AD1AF514B2FC3C95F256916A05B8620570ECAE389037A88887266F4E6CA6A305C33E45B2F62D488DB3E72E6578BAEB2CD39ED30F2E29E13A3590E5872E3EAA36C73EB5438871F3AB8A700'
```

### Stream Extraction Paths (Prioritized)

#### Path 1: Direct API - .png Endpoint (FASTEST)
- **URL**: `GET /api/DramaList/Episode/{id}.png?kkey={EPISODE_KKEY}`
- **Why it works**: Bypasses CF Bot Management (AF only protects `/api/DramaList/Episode/{id}?type=` variant)
- **Returns**: JSON with content-type: image/png containing `Video`, `Video_tmp`, `ThirdParty` fields
- **Variants tried**:
  - `https://kisskh.do/api/DramaList/Episode/{id}.png?kkey={KEY}`
  - `https://kisskh.do/api/DramaList/Episode/{id}.png?err=false&ts=null&time=null&kkey={KEY}`
  - `.co` domain variants
- **Fallback**: CF Worker routes if `CF_WORKER_URL` env var set
- **CURRENT STATUS**: Implemented but failing — likely KKEY rotation needed (kisskh updates keys periodically)

#### Path 2: FlareSolverr Session + API (REAL BROWSER)
- **Prerequisites**: `FLARESOLVERR_URL` env var set
- **Flow**:
  1. Create browser session → CF primer visit → cf_clearance cookie acquired
  2. Request episode API: `/api/DramaList/Episode/{id}?type=2&sub=0&source=1&quality=auto`
  3. Destroy session
- **Pros**: Bypasses CF Bot Management with real Chromium
- **Cons**: ~15-20s latency (hard capped)
- **Status**: Implemented, working but slow

#### Path 3: HTML Fallback (FAST PARSE)
- **URL**: `GET /Drama/Any/Episode-Any?id={serieId}&ep={episodeId}`
- **Parse**: Extract embedded m3u8 URL from HTML using regex
- **Patterns**:
  - Direct: `/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i`
  - Escaped: `/https?:\\\/\\\/[^"'\s<>]+\.m3u8/i` (JSON form)
- **Status**: Implemented, often works

#### Path 4: Browser Extraction (SLOWEST, 45s timeout)
- **Method**: Puppeteer + stealth plugin
- **Intercepts**: 
  - m3u8 requests via request interception
  - Response parsing from `.png` endpoint
- **Timeout**: 45 seconds hard cap (causing the issue!)
- **Issue**: Browser extraction too slow, falls back to this too often

#### Path 5: Heuristic Fallback (GUESS)
- **Pattern**: `https://hls.cdnvideo11.shop/hls07/{serieId}/Ep{episodeNum}_index.m3u8`
- **Used when**: Meta info available with episode number
- **Reliability**: Low

### Why .png Path Fails (INVESTIGATION NEEDED)
1. **KKEY Rotation**: kisskh updates EPISODE_KKEY and SUB_KKEY periodically (every 2-4 weeks based on history)
   - Current keys are hardcoded static strings
   - **FIX**: Need to extract KKEY from current kisskh.do bundle JS or implement key discovery
   
2. **Domain Whitelisting**: One domain might be CF-blocked (kisskh.do vs kisskh.co)
   - Both should work; try prioritizing `.co`
   
3. **Parameter Sensitivity**: Extra params (`err=false&ts=null&time=null`) may have changed
   - Simplify: try just `?kkey={KEY}` variants

4. **CF Worker Route Issues**: If CF_WORKER_URL is set, worker may be outdated/blocked
   - Workers are IP-specific; may be on CF blocklist

### V-Token (Required for CDN)
- **Purpose**: Some CDN URLs require `?v={token}` parameter for authentication
- **Extraction**: Scanned from episode page JavaScript
- **Patterns**:
  - In m3u8: `/\.m3u8[^"'\s<>]*[?&]v=([a-zA-Z0-9_-]{6,})/i`
  - In bundles: `/\b(videoToken|token|v)\s*[:=]\s*['"']([a-zA-Z0-9_-]{6,})['"']/i`
- **Applied**: `?v={token}` added to m3u8 URL if not present
- **Status**: Working

### Subtitle Extraction
- **API**: `/api/Sub/{episodeId}?kkey={SUB_KKEY}`
- **Decryption**: Uses `decryptKisskhSubtitleFull()` or `decryptKisskhSubtitleStatic()`
- **Language Filter**: Only Italian subtitles returned
- **Caching**: 24 hour TTL

### Environment Variables Required
- `CF_WORKER_URL` (optional) - Cloudflare Worker proxy URL
- `CF_WORKER_AUTH` (optional) - Worker authentication header
- `CF_CLEARANCE_KISSKH` (optional) - Cached cf_clearance cookie
- `FLARESOLVERR_URL` (optional) - FlareSolverr.io endpoint
- `PROXY_URL` (optional) - SOCKS/HTTP proxy
- `STREAM_MAX_WAIT` (optional, default 45000ms) - Browser extraction timeout

### Configuration Needed
- `config.proxyUrl` - Proxy URL passed to provider
- `config.clientIp` - client IP for headers (X-Forwarded-For)

### Timeouts & Caps
- CF Worker: 8s
- FlareSolverr: 15s hard cap
- Direct axios: 8s
- Cookie API: 8s
- HTML fallback: 10s
- V-token extraction: 10s
- Browser extraction: 45s hard cap (THIS IS THE BOTTLENECK!)

### MediaFlow Proxy Integration
- **Function**: `wrapStreamUrl(rawUrl, config, { Referer, Origin })`
- **When applied**: After stream extraction, before returning to Stremio
- **Headers forwarded**: Referer, Origin as URL params
- **Config params**: `mfpUrl`, `mfpKey`

---

## 2. GUARDAFLIX Provider (src/guardaflix/index.js)

### Overview
Italian movie provider (guardaplay.space) with WordPress search API.

### Search Flow
1. **Title Resolution**: `getTitleAndYear(id, type)`
   - Accepts: IMDB ID (tt...), TMDB numeric ID, tmdb: prefix
   - Queries TMDB API to get title + release year
   
2. **WordPress Search**: `searchMovies(title)`
   - Endpoint: `/wp-admin/admin-ajax.php`
   - Method: POST with form data `action=action_tr_search_suggest&nonce=20115729b4&term={title}`
   - Returns: HTML with movie results

3. **Link Parsing**: Extract `<a href="URL">Title</a>` from search results
   - Pattern: `/<li class="..."><a href="([^"]+)"[^>]*>.*?<span class="type-movies".*?>.*?<\/span>([^<]+)<\/a>/gi`
   - Must have: `class="type-movies"` (movie type marker)

4. **Embed Resolution**: `getEmbedUrl(pageUrl)`
   - Fetches movie page
   - Extracts: `data-src="https://...trembed..."` iframe URL
   - **ALSO EXTRACTS YEAR** from page: `<span class="year">2023</span>`

5. **Player Extraction**: `getPlayerUrl(embedUrl)`
   - Fetches trembed iframe
   - Extracts: `src="..."` with video player URL (usually MixDrop, MaxStream, etc.)

6. **Extractor**: Format stream and pass to `extractFromUrl(playerUrl, context)`

### Year Matching Issue (ROOT CAUSE)

**Current Logic**:
```javascript
if (year && pageYear && year !== pageYear) {
  console.log(`Year mismatch: expected ${year}, got ${pageYear}`);
  continue; // SKIP THIS RESULT
}
```

**Problem Scenarios**:
1. **TMDB year != page year**: 
   - "Barbie" TMDB: 2023
   - Guardaflix page shows: 2024 (different release date region)
   - **Result**: Search skips correct movie, returns wrong year result
   
2. **Missing year on page**:
   - Some movies don't have `<span class="year">...` on page
   - `pageYear` is null → skip (even if TMDB says 2023)
   
3. **Year not in TMDB result**:
   - TMDB might return empty `release_date`
   - `year` is empty string/null → skip year check entirely
   - Falls back to partial title matches (may return wrong movie)

### Environment/Config
- `GUARDAFLIX_PROVIDER_URL` override URL (env var)
- Default: `https://guardaplay.space`
- Nonce: `20115729b4` (static, may need updating if WordPress admin changes it)
- TMDB Key: `68e094699525b18a70bab2f86b1fa706` (hardcoded)

### Data Flow
1. `id` (IMDB/TMDB) → `getTitleAndYear()` → TMDB API
2. `title` → `searchMovies()` → WordPress search
3. Search results (5 max) → `getEmbedUrl()` → trembed frame
4. Year check here: EXPECTED vs PAGE YEAR
5. Valid embed → `getPlayerUrl()` → actual player URL
6. Player URL → extractor
7. Stream formatted and returned

### Issues & Gaps
- No fallback if year check fails (strict filtering)
- Nonce is hardcoded (may expire/change)
- TMDB API call per search (slow, ~2-3s)
- No caching of search results
- Only checks first 5 results
- No fuzzy year matching (e.g., within ±1 year)

---

## 3. MIXDROP EXTRACTOR (src/extractors/mixdrop.js)

### Extraction Logic (SIMPLE)

```javascript
async function extractMixDrop(url, refererBase = 'https://m1xdrop.net/') {
  // 1. Check if disabled
  if (isMixDropDisabled()) return null;
  
  // 2. Normalize URL
  url = normalizeExtractorUrl(url);
  if (!url) return null;
  
  // 3. Fetch iframe HTML
  const html = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Referer': refererBase }
  }).then(r => r.text());
  
  // 4. Extract packed value (packed JavaScript)
  const packed = extractPackedValue(html, [
    /MDCore\.wurl\s*=\s*"([^"]+)"/i,
    /MDCore\.wurl\s*=\s*'([^']+)'/i,
    /wurl\s*=\s*"([^"]+)"/i,
  ]);
  
  // 5. Normalize URL
  const streamUrl = normalizeExtractorUrl(packed.value, url);
  if (!streamUrl) return null;
  
  // 6. Return with headers
  return {
    url: streamUrl,
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': `${getUrlOrigin(url)}/`,
      'Origin': getUrlOrigin(url)
    }
  };
}
```

### Key Functions
- **`isMixDropDisabled()`**: Checks `DISABLE_MIXDROP` env var or `global.DISABLE_MIXDROP`
- **`extractPackedValue(html, patterns)`**: Finds packed JS in HTML using regex patterns (from common.js)
- **`normalizeExtractorUrl(url, relativeBase?)`**: Converts relative URLs to absolute, validates scheme
- **`getUrlOrigin(url)`**: Extracts origin (scheme + domain) from URL

### Patterns Matched
1. `MDCore.wurl = "..."` (primary, newer format)
2. `MDCore.wurl = '...'` (single quote variant)
3. `wurl = "..."` (fallback, bare variable)

### Output
```javascript
{
  url: "https://...",  // Actual video stream URL
  headers: {
    'User-Agent': '...',
    'Referer': 'https://m1xdrop.net/',  // MixDrop domain
    'Origin': 'https://m1xdrop.net'
  }
}
```

### Disable Mechanism
```javascript
// Via env var
process.env.DISABLE_MIXDROP = '1' // or 'true', 'yes', 'on'

// Via global flag (Node.js)
global.DISABLE_MIXDROP = true;
```

### Issues
- **Packed JS extraction**: Relies on `extractPackedValue()` to decode packed JavaScript
  - If MixDrop changes obfuscation, extraction breaks
  - No fallback if patterns don't match
  
- **No fallback**: Returns null if extraction fails (doesn't try alternative patterns or methods)

- **No caching**: Every extraction fetches fresh HTML

- **Referer domain**: Hardcoded to `https://m1xdrop.net/` (may vary by region/mirror)

### Integration Points
- Used in CB01 provider (primary extractor)
- Used in Guardaflix provider (for embedded videos)
- Part of extractors suite (src/extractors/index.js → extractFromUrl())

---

## 4. MEDIAFLOW PROXY INTEGRATION (Already Implemented)

### Location
`src/utils/mediaflow.js`

### Functions
**`wrapStreamUrl(url, config, fwdHeaders?)`**
- Wraps HLS/DASH/MP4 URLs through MFP
- Routes:
  - `.m3u8` → `/proxy/hls/manifest.m3u8?d=URL`
  - `.mpd` → `/proxy/mpd/manifest.m3u8?d=URL`
  - `.mp4/.mkv/.avi/.ts` → `/proxy/stream?d=URL`
- Query params: `d=URL`, `api_password=KEY`, `h_referer=...`, `h_origin=...`

**`wrapSubUrl(url, config)`**
- Wraps subtitle URLs through MFP

**`wrapProviderStreamsWithMfp(streams, config)`**
- Post-processes provider stream array
- Only wraps if headers present or HLS playlist
- Prevents double-wrapping

### Integration in KissKH
```javascript
const finalUrl = wrapStreamUrl(rawUrl, config, {
  'Referer': SITE_BASE + '/',
  'Origin': SITE_BASE,
});
```

### Configuration
```javascript
config.mfpUrl  // e.g., "https://mfp.example.com"
config.mfpKey  // MFP API password (if required)
```

---

## SUMMARY TABLE

| Component | Status | Issue | Priority |
|-----------|--------|-------|----------|
| KissKH .png API | Implemented | KKEY outdated | HIGH |
| KissKH Browser | Implemented | 45s timeout too slow | HIGH |
| KissKH FlareSolverr | Implemented | 15-20s latency | MEDIUM |
| Guardaflix search | Implemented | Year mismatch filtering too strict | MEDIUM |
| Guardaflix nonce | Hardcoded | May expire | LOW |
| MixDrop extractor | Implemented | Packed JS pattern may break | LOW |
| MFP integration | Implemented | Working | N/A |
