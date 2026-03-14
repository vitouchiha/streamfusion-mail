# StreamFusionMail Provider Disaster Recovery Guide
## Last Updated: 2026-03-12

---

## ENVIRONMENT VARIABLES (Vercel)

```
BROWSERLESS_URL=wss://chrome.browserless.io?token=<TOKEN>   # Remote Chrome for SuperVideo extraction
WEBSHARE_PROXIES=http://gmcimwlz:fyegql9qqbxh@ip1:port1,http://gmcimwlz:fyegql9qqbxh@ip2:port2,...  # 10 datacenter proxies
HLS_PROXY_SECRET=<secret>                                     # JWT signing for /proxy/hls/manifest.m3u8
```

TMDB API key is hardcoded: `68e094699525b18a70bab2f86b1fa706`

---

## PROVIDER URLS (provider_urls.json)

```json
{
  "guardaserie": "https://guardaserietv.skin",
  "streamingcommunity": "https://vixsrc.to",
  "animeunity": "https://www.animeunity.so",
  "guardahd": "https://mostraguarda.stream",
  "guardaflix": "https://guardaplay.space",
  "mapping_api": "https://animemapping.stremio.dpdns.org"
}
```

Remote auto-update from: `https://raw.githubusercontent.com/realbestia1/easystreams/refs/heads/main/provider_urls.json` (every 10s)

**⚠️ Domain changes are the #1 cause of provider breakage. Check these first.**

---

## GUARDASERIE (working 2026-03-12, v3.0.30)

### Files
- `src/guardaserie/index.js` — main provider (search, episode parsing, mirror iteration)
- `src/extractors/supervideo.js` — SuperVideo extraction cascade
- `src/utils/browser.js` — Puppeteer launcher + `applyStealthEvasions()` (manual, NO puppeteer-extra)
- `src/utils/hlsProxy.js` — HLS manifest proxy with JWT tokens
- `server.js` — HLS proxy handler + debug endpoints
- CF Worker `streamfusion-proxy.vitobsfm.workers.dev` — sv_extract + p.a.c.k.e.r unpacker

### Extraction Cascade (extractSuperVideo) — DO NOT CHANGE ORDER
1. **Strategy 1 — CF Worker sv_extract** (~2s): Worker fetches supervideo.tv embed, unpacks p.a.c.k.e.r JS, extracts master.m3u8 on serversicuro.cc. Returns `{ url, headers, manifestBody }`. Accepted ONLY if `manifestBody` present.
2. **Strategy 1b — Browser-first** (~10-15s): Only if `SHOULD_PREFER_BROWSER && wsProxy`. Launches `@sparticuz/chromium` + `--proxy-server=wsProxy`. Captures manifest URL + body via `page.on('response')`.
3. **Strategy 2 — HTTP chain**: wsProxy HTTP → CF Worker page fetch → browser. Last resort.

### HLS Proxy Playback Chain (CRITICAL)
1. Stremio → `/proxy/hls/manifest.m3u8?token=JWT`
2. JWT fields: `u` (manifest URL), `h` (headers), `b` (cached manifestBody ≤4KB), `p` (proxyUrl)
3. Master manifest served FROM CACHED `b` field — NO upstream fetch!
4. Sub-playlist URLs rewritten to proxy URLs, fetched via CF Worker
5. TS segments fetched via CF Worker for serversicuro.cc

**server.js routing rule:**
```
const usesCfProxy = cfProxyUrl && !proxyTarget.proxyUrl && /serversicuro\.cc/i.test(proxyTarget.url);
```
- Has per-stream `proxyUrl` → use that (NOT CF Worker)
- No per-stream proxy + serversicuro.cc → use CF Worker
- Other hosts → direct fetch

### KEY DISCOVERY: `i=0.0` tokens are NOT IP-locked
CF Worker sv_extract produces tokens with `i=0.0` → works from ANY IP. Only `i=x.y.z.w` tokens are IP-locked. This means sv_extract output works for all Stremio clients without proxy.

### Stealth Evasions (browser.js)
puppeteer-extra **BREAKS on Vercel** (transitive deps: fs-extra, user-data-dir, user-preferences). Use manual `applyStealthEvasions(page)`:
- `navigator.webdriver` → false
- `chrome.runtime` → fake object
- `navigator.plugins` → fake array
- `navigator.languages` → `['it-IT','it','en-US','en']`

### Quality Filter
- FHD only (1080p+). BANDWIDTH fallback: ≥3500000=1080p, ≥1800000=720p
- URL heuristic: `serversicuro.cc…urlset/master.m3u8` → 1080p

### Timeouts
- Provider: 45000ms, Outer: 50000ms, Vercel maxDuration: 60s
- Browser: 40000ms, Page goto: 12000ms, CF challenge wait: 12s

### Debug Endpoints
- `/debug/guardaserie-trace?key=debug123` — search + scraping
- `/debug/supervideo-extract?key=debug123&url=<embed>` — full cascade
- `/debug/browser-sv?key=debug123&url=<embed>&noproxy=1` — browser only

### If It Breaks — CHECKLIST
1. **Domain changed?** → provider_urls.json `guardaserie` key (#1 cause)
2. **sv_extract fails?** → Check CF Worker wildcard list in cfworker-proxy.js
3. **manifestBody empty?** → Test video may be dead on serversicuro (try different ID)
4. **Browser crash?** → Someone re-added puppeteer-extra → remove, use manual stealth
5. **HLS 404 segments?** → Check server.js usesCfProxy logic, CF Worker deployed?
6. **All streams gone?** → Missing provider module from git (crashes bootstrap)
7. **Opens browser not player?** → Check notWebReady/proxyPlaybackDisabled in formatter

### FAILED APPROACHES (don't retry)
- ❌ Direct serversicuro.cc URLs to Stremio (403)
- ❌ HLS proxy + rotating wsProxy (IP mismatch with token)
- ❌ CF Worker fixed IP for segments (CF has no fixed outgoing IP)
- ❌ MFP/easy.koyeb.app for serversicuro (can't handle auth)
- ❌ puppeteer-extra on Vercel (bundling nightmare)
- ❌ Browserless.io (401 from extraction path, unknown root cause)

---

## STREAMINGCOMMUNITY (working 2026-03-10)

### Files
- `src/streamingcommunity/index.js` — main provider

### How It Works
1. IMDB → TMDB conversion
2. Fetch page: `{baseUrl}/titles/{tmdbId}-{slug}` (movies) or with season/episode
3. Parse HTML for `window.title`, `window.season`, episode data JSON
4. Build playlist URL from `vixsrc.to/playlist/{id}.m3u8?token=...&expires=...&h=1&lang=it`
5. Verify Italian audio in playlist (logs warning if missing, doesn't block)
6. Return single HLS stream through proxy

### Timeout: 14000ms

### If It Breaks
1. Check `vixsrc.to` domain in provider_urls.json
2. Page structure may change (JSON parsing from HTML `<script>` tags)
3. Token/expires extraction regex: look for `'token':\s*'([^']+)'` patterns
4. No browser needed — pure HTTP

---

## ANIME PROVIDERS: ANIMEUNITY, ANIMEWORLD, ANIMESATURN (working 2026-03-12, v3.0.31)

All 3 anime providers share the SAME architecture. Fix one → fix all.

### Files
- `src/animeunity/index.js` — AnimeUnity provider
- `src/animeworld/index.js` — AnimeWorld provider
- `src/animesaturn/index.js` — AnimeSaturn provider
- `src/extractors/vixcloud.js` — VixCloud embed extractor (used by AnimeUnity)
- `src/formatter.js` — NelloStream stream formatter (language display)

### Architecture (IDENTICAL for all 3)

**1. Mapping API → Multiple Anime Paths**
- Uses `animemapping.stremio.dpdns.org` to translate IMDb/TMDB/Kitsu → provider-specific paths
- API returns MULTIPLE paths per provider: e.g. `/anime/4290-solo-leveling` (SUB) + `/anime/5080-solo-leveling-ita` (ITA dub)
- Each path scraped independently via `mapLimit(animePaths, 3, ...)`
- Both IT dub and JP sub versions come from different anime entries on the site

**2. Language Detection**
- `inferSourceTag(title, animePath)`: checks if title/URL contains "ita" → returns `"ITA"` or `"SUB"`
- `resolveLanguageEmoji(sourceTag)`: `"ITA"` → `🇮🇹`, anything else → `🇯🇵`
- Language set per anime PATH, not per individual stream URL

**3. Deduplication (CRITICAL — was broken)**
- Dedup key: `normalizedUrl + '|' + language` — preserves IT + JP variants even with same URL
- OLD (broken): dedup by URL only → JP version dropped when URL matched IT version
- FIX (v3.0.31): added language to dedup key in all 3 providers

**4. Formatter Language (CRITICAL — was broken)**
- Provider sets `stream.language = "🇯🇵"` or `"🇮🇹"`
- Formatter must RESPECT this emoji, not re-derive from text matching
- OLD (broken): formatter checked for "SUB" string in title → not found → defaulted to `🇮🇹 ITA` for ALL streams
- FIX (v3.0.31): formatter checks `lang.includes('🇯🇵')` → `🇯🇵 SUB ITA`, `lang.includes('🇰🇷')` → `🇰🇷 SUB ITA`, else falls back to text matching, default `🇮🇹 ITA`

### Formatter Language Logic (src/formatter.js)
```js
if (lang.includes('🇯🇵'))      → '🇯🇵 SUB ITA'
else if (lang.includes('🇰🇷')) → '🇰🇷 SUB ITA'
else if ('SUB' in text)         → '🇯🇵 SUB ITA'
else                            → '🇮🇹 ITA'
```

### Provider-Specific Notes

**AnimeUnity** (`animeunity.so`):
- Episodes from `<video-player episodes="[...]">` HTML attribute or chunk API
- VixCloud extraction for embedded players (`embed-url/{episodeId}`)
- Fallback: resolveEmbedUrl → embed page HTML → media links
- VixCloud URLs are different per language version (e.g. playlist/183342 vs playlist/189766)

**AnimeWorld** (`animeworld.so`):
- Episodes from page scraping, direct media links
- Server extraction: SweetPixel, StreamTape, etc.
- Same `inferSourceTag`/dedup pattern

**AnimeSaturn** (`animesaturn.in`):
- Episodes from page scraping
- Server extraction: Srv18, Srv21, Srv25, Srv31, etc.
- Has related anime path detection for ITA variants

### Timeouts
- FETCH_TIMEOUT: 8000ms (all 3 providers)
- VixCloud proxy/direct fetch: 6s (`AbortSignal.timeout`)
- VixCloud cloudscraper fallback: 8s
- Mapping API: cached 2min
- Anime pages: cached 15min
- Stream pages: cached 5min

### VixCloud Quality Detection (IMPORTANT — no extra fetch)
Quality is derived from URL params, NOT by fetching the playlist:
- `h=1` or `b=1` in URL → **1080p/FHD**
- Otherwise → **720p/HD**
This saves ~3s per stream. The old `checkQualityFromPlaylist()` was causing timeouts on Vercel (second anime path timed out before completing).

### If It Breaks — CHECKLIST
1. **Domain changed?** → Check provider_urls.json (most frequent cause)
2. **Only 1 language variant?** → Check dedup key includes language (`url|language`)
3. **All streams show 🇮🇹 ITA?** → Formatter ignoring provider emoji — check `src/formatter.js` language detection block
4. **Only 1 AnimeUnity result on Vercel?** → Second path is timing out. Check FETCH_TIMEOUT, VixCloud AbortSignal timeouts. Ensure `checkQualityFromPlaylist` is NOT re-added to VixCloud extractor.
5. **0 AnimeUnity streams on Vercel?** → CF blocks Vercel IPs. Fix: CF Worker `au_search` endpoint handles CSRF+search. Check `kisskh-proxy` worker is deployed, `animeunity.so` in ALLOWED_HOSTS. Mapping module has 3-tier fallback: direct → cloudscraper → CF Worker.
6. **AnimeSaturn S1 content in S2 results?** → `extractStreamsFromAnimePath` should receive `requestedSeason` param. Season filter on `relatedAnimePaths` prevents S1 paths leaking into S2.
7. **0 streams?** → Internal mapping module (`src/mapping/index.js`) may fail. Check offline Fribb list loading.
8. **Episodes not found?** → Check `<video-player>` attribute parsing, `episodes_count` regex
9. **VixCloud 403?** → Domain may have changed, check `extractVixCloud` in extractors
10. **Mapping returns 0 paths?** → Try TMDB fallback (provider does IMDb→TMDB retry automatically)

### FAILED APPROACHES (don't retry)
- ❌ Dedup by URL only (drops JP variant when URL matches IT)
- ❌ Formatter re-deriving language from stream title text (provider strips lang tags via `sanitizeAnimeTitle`)
- ❌ Korean flag 🇰🇷 for Japanese anime sub (should be 🇯🇵)
- ❌ `checkQualityFromPlaylist()` in VixCloud extractor (extra fetch causes Vercel timeout, use URL-based quality instead)
- ❌ Korean flag 🇰🇷 for Japanese anime sub (should be 🇯🇵)

---

## GUARDAHD (working 2026-03-10 for movies only)

### Files
- `src/guardahd/index.js` — main provider (MOVIES ONLY, returns [] for TV)

### How It Works
1. IMDB → TMDB for metadata
2. Cloudscraper fetch: `{baseUrl}/set-movie-a/{imdbId}`
3. Parse `<iframe id="_player">` and `data-link="..."` for embed URLs
4. Fallback to browser if cloudscraper fails
5. Extractors: SuperVideo, MixDrop, etc. via `extractFromUrl()`

### Timeout: 22000ms

### If It Breaks
1. Check `mostraguarda.stream` domain — under CF Bot Fight Mode
2. Cloudscraper may not bypass CF anymore
3. Browser fallback available but slow (25s+)
4. **Only movies** — TV requests return [] by design

---

## GUARDAFLIX (working 2026-03-10 for movies)

### Files
- `src/guardaflix/index.js` — main provider

### How It Works
1. WordPress AJAX search: POST `{baseUrl}/wp-admin/admin-ajax.php`
   - action: `action_tr_search_suggest`
   - nonce: `20115729b4` (hardcoded — may expire!)
2. Parse `<li class="type-movies">` results
3. Fetch movie page, extract `<iframe src="...">` embeds
4. Extract via standard extractors

### Timeout: 20000ms

### If It Breaks
1. Check `guardaplay.space` domain
2. WordPress nonce `20115729b4` may have expired — need to fetch new one from page source
3. No browser needed

---

## HLS PROXY PIPELINE

### JWT Token Structure
```json
{
  "u": "https://hfs325.serversicuro.cc/hls2/.../master.m3u8?t=...&i=142.111&sp=3000",
  "h": { "User-Agent": "...", "Referer": "https://supervideo.cc/" },
  "e": 1773185849323,
  "p": "http://gmcimwlz:fyegql9qqbxh@142.111.67.146:5611"
}
```

Signed with HMAC-SHA256 using `HLS_PROXY_SECRET`.

### Flow
1. Stremio requests `/proxy/hls/manifest.m3u8?token=<JWT>`
2. Server verifies signature, checks expiry
3. Fetches upstream manifest through proxy `p` (if present)
4. Rewrites all segment/media URLs to also go through proxy
5. Returns rewritten M3U8 — Stremio fetches segments transparently

### Header Allowlist
Only: Referer, Origin, User-Agent, Accept, Accept-Language

---

## BROWSER LAUNCHER PRIORITY

1. **BROWSERLESS_URL** → WSS connect to remote Chrome (currently 401s from extraction path)
2. **@sparticuz/chromium** → Local headless Chrome on Vercel Lambda (works with --proxy-server)
3. **PUPPETEER_EXECUTABLE_PATH** → Custom binary (Docker/VPS)
4. **Auto-detect** → System Chrome (local dev)

Key args: `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --no-zygote --disable-gpu`
With proxy: adds `--proxy-server=http://host:port`, then `page.authenticate({username, password})`

---

## DEBUG ENDPOINTS

All require `?key=debug123` query param.

| Endpoint | Purpose |
|----------|---------|
| `/debug/guardaserie-trace` | Full scraping trace (search → show page → episode links) |
| `/debug/guardaserie-streams` | Actual `getStreams()` call with log capture |
| `/debug/supervideo-extract` | SuperVideo extraction with browser logs |
| `/debug/browser-sv` | Simple Browserless+proxy page load (no extraction machinery) |
| `/debug/browser-proxy` | Browserless+proxy IP check |
| `/debug/browser` | Basic Browserless connectivity test |
| `/debug/http-fetch` | Generic fetch through Vercel |

---

## KEY DEPENDENCIES (package.json)

- `puppeteer-core@24.38.0`
- `@sparticuz/chromium@143.0.4`
- `cloudscraper@4.6.0`
- `axios@1.9.0`
- `cheerio@1.2.0`
- `https-proxy-agent@7.0.6`
- `jsonwebtoken` (HLS proxy JWT)
