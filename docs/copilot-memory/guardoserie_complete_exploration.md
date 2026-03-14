# GuardoSerie & Eurostreaming Complete Exploration

## DATA COLLECTED
- ✅ `src/guardoserie/index.js` - Complete ~1000 line provider file
- ✅ `src/eurostreaming/index.js` - Complete ~1000 line provider file  
- ✅ `src/cache/cache_layer.js` - LRU in-memory cache (mock Redis)
- ✅ `cfworker.js` - CloudFlare Worker proxy with KV caching logic

## GUARDOSERIE FLOW (GuardoSerie.best/digital)

### Proxy Strategy Stack (Priority Order)
1. **CF Worker Fetch** - CF-to-CF bypass (fastest, uses .digital domain auto-redirect)
2. **Browser Fetch** - Puppeteer with puppeteer-stealth (solves JS challenges)
3. **WEBSHARE Residential Proxy** - Clicks.cc workaround for Cloudflare
4. **Direct PROXY_URL** - Environment fallback

### Search & Episode Resolution
1. Search by title using `/?s=query` endpoint (not admin-ajax which is broken)
2. Fetch multiple title candidates sequentially
3. Parse search results for /serie/ links + title normalization
4. Year verification via `release-year/YYYY` links in page
5. Episode extraction from series page (splits season blocks by `les-content` marker)
6. Extracts episode URLs from `<a href="/episodio/">` patterns

### Player Link Extraction
- Multi-tab support: `#player2 > div[id^="tab"]` tabs (ITA/SUB/different hosts)
- Fallback: extract ALL iframes from HTML
- Supported extractors: **Loadm**, **Uqload**, **DropLoad**

### Quality Detection
- Loadm/DropLoad: Can check .m3u8 playlist for quality
- Falls back to "HD" quality

---

## EUROSTREAMING CACHING TRICK (The Secret!)

### Two-Phase Search (Why It's Fast)

**Phase 1: KV INDEX LOOKUP** (Usually Succeeds - No Live API Call!)
```
1. Load es-titles-index.json (static file deployed with Vercel)
   OR fetch from Worker KV: ?es_titles=1
2. titleRatio(title, candidates) >= 0.6 threshold
3. For each match, fetch cached post from KV: es:page:N 
   (N = page number where post lives)
4. Parse episode links from cached post HTML
5. Extract streams (MixDrop, DeltaBit, Turbovid, MaxStream)
```

**Phase 2: Live WP API Fallback**
```
Only if Phase 1 returns no results or KV unavailable:
- /wp-json/wp/v2/search?search=query
- Fetch post details from live API
- Parse episodes and extract
```

### Cache Warming Strategy (Genius Part!)

**Warm-Up Process (triggered manually or via cron)**
1. Fetch ALL posts from `/wp-json/wp/v2/posts?per_page=100&page=N`
2. **Store ENTIRE PAGE as ONE KV entry** (`es:page:N`)
   - Not 100 individual KV writes - just ONE write per page!
   - Much cheaper on KV operations quota
   - Much faster retrieval

3. Build **titles index** from all posts
   ```json
   {
     "snowpiercer": [{"id": 12345, "page": 5}],
     "attack on titan": [{"id": 54321, "page": 3}, {"id": 54322, "page": 8}]
   }
   ```
4. Store index in KV: `es:titles`
5. Run every 24 hours (state tracked in KV)

### Response-Level Caching (Secondary)

In cfworker.js:
```javascript
_KV_CACHEABLES = {
  'eurostream.ing': 86400,      // Cache live responses 24h
  'eurostreamings.life': 86400,
  'clicka.cc': 86400,
  'deltabit.co': 3600
}
```
- When live fetch succeeds: cache response in KV (key = `p:{url}`)
- When Cloudflare blocks: fallback to cached response
- Prevents repeated CF blocks from affecting performance

---

## GUARDOSERIE FAILURES vs EUROSTREAMING SUCCESS

| Failure Point | GuardoSerie | Eurostreaming |
|---|---|---|
| **Live API blocks** | Retries proxies repeatedly, costs time | Falls back to cached index immediately |
| **Every search is live** | Calls /?s= for EACH title candidate | Uses pre-built titles index in memory |
| **No post caching** | Re-fetches series page each time | Page HTML cached in KV for 48h |
| **Proxy rotations** | Must try CF Worker → Browser → Webshare | CF Worker isn't required often (uses cache) |
| **Cloudflare detection** | Browser fetch required if CF blocks | Can work without calling live API at all |

---

## WHY EUROSTREAMING CACHING WOULD HELP GUARDOSERIE

1. **Pre-cache search results**: Cache guardoserie search pages (title → /serie/ URLs)
2. **Episode extraction**: Cache parsed episode lists per show
3. **Player extraction**: Cache extracted player links (refreshed weekly)
4. **Reduce proxy load**: Most requests served from cache, fewer live calls needed

vs current GuardoSerie:
- Every search = live /?s= call
- Every series page = live fetch
- Every episode page = live fetch
- Every extractor call = live player link resolution

---

## FILES TO UNDERSTAND

### GuardoSerie Main Challenges
- `proxyFetch()` (lines ~65-340): Multi-strategy proxy logic
- `getStreams()` (lines ~695-1025): Search + episode extraction
- `extractAllPlayerLinksFromHtml()` (lines ~486-538): Tab-aware link extraction
- `extractEpisodeUrlFromSeriesPage()` (lines ~362-406): Season/episode parsing

### Eurostreaming Caching Benefits
- `_loadTitlesIndex()` (line ~1156): Load static JSON (zero network)
- `_searchViaKvIndex()` (line ~1175): Search cached titles (5ms response)
- `_fetchPostFromKv()` (line ~1254): Get post from local .gz batch file
- `searchAndExtract()` (line ~1309): Falls back to live API only if needed

### Worker KV Warm-Up
- `_handleWarmEs()` in cfworker.js: Cache pagination
- `_handleScheduledWarm()`: Cron job for auto-refresh
- Caches posts per page (100 posts → 1 KV entry)
- Maintains titles index separately
