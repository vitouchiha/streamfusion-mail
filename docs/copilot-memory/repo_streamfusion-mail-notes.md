- 2026-03-06: Vercel free plan hit daily deployment cap (`api-deployments-free-per-day`), which can block manual `npx vercel --prod` and leave production pinned to an older version despite new pushes.
- **Stremio Metadata Validation**: Never include empty string fields (`""`) for optional properties like `overview`, `released`, or `description` when returning `meta` objects or `videos` arrays to Stremio. Stremio's strict JSON validation will drop the object entirely and throw a "No metadata was found!" error. Always omit the properties entirely if the data is missing (e.g., `if (overview) video.overview = overview;` instead of `overview: ep.overview || ''`).
- 2026-03-07: `.vercelignore` pattern `cache/` can exclude `src/cache/` in Vercel bundle and cause runtime `Cannot find module '../cache/cache_layer'`; use `/cache/` to target only workspace root cache dir.
- 2026-03-10: **Cloudflare Bot Fight Mode blocks ALL cloud provider IPs from Italian streaming sites**: eurostream.ing, clicka.cc, safego.cc, deltabit.co, guardoserie.surf, mostraguarda.stream all return 403 from Vercel US IPs. Cloudflare Workers proxy (CF Worker bypass trick) does NOT work for these sites — they use stricter CF configuration than kisskh.co. GuardaSerie (guardaserietv.autos), CB01 (cb01uno.digital), and GuardaFlix (guardaplay.space) DO work from Vercel.
- 2026-03-10→13: **Eurostreaming ALL players FIXED on Vercel (v3.0.37)**: Full chain was blocked by CF Bot Fight Mode. Solution: CF Worker KV cache + `es_stream`/`es_resolve` endpoints. Worker runs at player's edge (Italy). DeltaBit/Turbovid via `es_stream` → 302 to MP4 (mfpHandled:true, direct to Stremio). MixDrop via `es_resolve` → mixdrop URL → MFP extractor URL. KV namespace `ES_CACHE` (ID `77d345738f28442c8a19fadc030eb92e`), TTL 24h for eurostream.ing/clicka.cc. All players extracted in parallel. `findEpisodeStreams` parses spoiler sections for correct ITA/SUB-ITA language detection. Cache warming: `node _warm.js <showname>` from local machine (warms all clicka.cc/delta, /mix, /tv links).
- 2026-03-10: **GuardaSerie works on Vercel** but is slow (~20s for content found via SuperVideo extraction). ToonItalia and Loonex set to 8s timeout (were 12s default) to prevent response latency from slow catalog fetches on Vercel.
- 2026-03-10: CF Worker (kisskh-proxy.vitobsfm.workers.dev) extended to also allow eurostream.ing, clicka.cc, safego.cc proxying + POST support + nofollow mode, but these sites still return 403 to CF Worker requests (stricter CF config).
- 2026-03-10: **GuardaSerie SuperVideo playback**: the old packed `serversicuro.cc` reconstruction was wrong for live playback. A real browser requests `supervideo.cc` then follows a tokenized HLS manifest on `serversicuro.cc` with referer `https://supervideo.cc/`; browser fallback should capture the actual manifest URL rather than returning the raw reconstructed path.
- 2026-03-10: If SuperVideo returns a raw `serversicuro.cc` manifest without tokens and browser capture fails, do not return it as a direct stream. Degrade to `isExternal` browser fallback; otherwise Stremio shows a playable-looking Guardaserie stream that always 403s.
- 2026-03-13: **Eurostreaming batch cache + auto-refresh (v3.0.40-41)**: See detailed guide below.
- 2026-03-13: **Anime Mapping internalized (v3.0.42-44)**:
  - External API `animemapping.stremio.dpdns.org` fully replaced by `src/mapping/index.js` + `src/mapping/anime_list.js`
  - v3.0.44: Integrated Fribb/anime-lists offline index (41,826 entries, 7MB JSON)
  - Indexes: Kitsu(21.8k), MAL(29.9k), AniList(20.3k), IMDB(5.1k), TMDB(5.3k), TVDB(4.2k), AniDB(15.6k)
  - Auto-refreshes every 24h with ETag check, pre-loaded at startup
  - Fallback chain: offline list → Kitsu API → TMDB API → title search
  - Fixes: Japanese title filtering (empty normalization), AnimeSaturn `item-archivio` parsing, IMDB→TMDB→TVDB→Kitsu chain
  - Source: `https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json`
- 2026-03-13: **v3.0.47**: Fixed episode/season parameter threading (episode now passed through `fetchMappingByRoute`, `fetchMappingByKitsu`, `resolveProviderRequestContext`). Reimplemented AnimeUnity search using POST `/archivio/get-animes` API with CSRF session management. Commit `1ac8619`.
- 2026-03-13: **v3.0.48**: Season-specific anime resolution. Uses Fribb anime-list `season.tvdb` field to find the correct Kitsu/AniList entry per season (e.g., Frieren S2 → kitsu:49240, anilist:182255). Search titles now include base versions without season suffixes. Provider paths filtered by season slug (-2, -ita etc.). Commit `e99cdd4`.
- 2026-03-13: **v3.0.49**: Fixed all 3 anime providers discarding season when using Kitsu from providerContext (`season: null` → `season: requestedSeason`). Commit `445957a`.
- 2026-03-13: **v3.0.50**: Two major fixes:
  1. **AnimeSaturn S1 related path leak**: When S2 ITA page had 0 episodes, `extractStreamsFromAnimePath` was falling back to `relatedAnimePaths` which included S1 ITA pages. Fix: pass `requestedSeason` to `extractStreamsFromAnimePath`, filter related paths by season suffix before following them.
  2. **AnimeUnity CF blocking on Vercel**: AnimeUnity's POST search API required CSRF session which failed from Vercel IPs (CF challenge). Fix: 3-tier fallback in mapping module (direct → cloudscraper → CF Worker `au_search` endpoint). CF Worker at `kisskh-proxy.vitobsfm.workers.dev` handles full session+CSRF+POST flow internally. Also added CF Worker proxy fallback in AnimeUnity provider's `fetchResource` for page fetches. Commit `6e4e47c`.

- 2026-03-14: **v3.0.55: Uprot captcha auto-solving + MaxStream streams COMPLETE**:
  - Per-digit segmentation OCR: threshold 80 binarization → column projection → individual digit PNGs → CF Worker AI per-digit
  - CF Worker AI models: `@cf/meta/llama-3.2-11b-vision-instruct` primary, `@cf/llava-hf/llava-1.5-7b-hf` fallback
  - KEY FIX: uprot bypass page has 3 types of links: (1) DECOY empty `<a>` with static dead URL `WlorSVB2Rno...` (appears 2x), (2) HONEYPOT in `display:none` div, (3) REAL link inside `<button id="buttok">C O N T I N U E</button>`. Must match buttok button, NOT first uprots URL.
  - Cookie caching: PHPSESSID + captcha hash, 22h TTL
  - Sequential digit OCR (was Promise.all causing timeouts), 45s timeout per digit
  - `src/utils/ocr.js`: new PNG encoder (`encodePngGrayscale`), binarization + noise removal (`preprocessCaptcha`)
  - Redirect chain: `maxstream.video/uprots/...` → follows HTTP redirects → watchfree URL → construct `emvvv/` embed → extract HLS m3u8
  - Tested: CB01 Gladiator II → uprot bypass → maxstream HLS `master.m3u8` (200, `application/vnd.apple.mpegurl`)

- 2026-03-14: **v3.0.59: MaxStream streams missing in Stremio — 3 root causes fixed**:
  1. **CF Worker `_uprotBypassWithCookies` broken regex**: `[^<]*C\s*O\s*N\s*T\s*I\s*N\s*U\s*E` couldn't match through `<button>` tags. Fixed to match `href="..."...<button id="buttok">C O N T I N U E`.
  2. **No honeypot stripping in CF Worker**: display:none blocks and HTML comments weren't removed, causing decoy links to be matched.
  3. **Vercel 60s timeout**: Uprot captcha solve took 45-90s (sequential per-digit OCR). Fixes:
     - KV cookie persistence: `?uprot_kv=1` CF Worker endpoint stores solved cookies in KV. Vercel loads from KV on cold start (~1s vs 45-90s).
     - Parallel digit OCR: 3 digits sent to CF Worker AI simultaneously instead of sequentially.
     - `warm-uprot.js`: local script to pre-warm cookies in KV.
  4. **uprotem redirect support**: CF Worker redirect chain now handles both `uprots` and `uprotem` domains (for /msei/ episode links).
  - NOTE: `/msf/` links are now FAST (1s with KV cache). `/msei/` links still slow (~45-60s per-URL captcha, no caching possible).
  - NOTE: uprot.net returns 403 to CF Worker IPs — all uprot fetches must be done from Vercel/local, not CF Worker.
  - NOTE: CF Worker cron `_handleScheduledUprotRefresh` fails silently (403 from uprot.net) — use `warm-uprot.js` locally instead.

- 2026-03-14: **v3.0.56: Fix uprot /msei/ episode links (token-based captcha)**:
  - ROOT CAUSE of missing MaxStream streams in CB01 series: stayonline resolves episode links to `uprot.net/msei/...` (not `/msf/`)
  - `/msei/` uses completely different captcha: token-based form (hidden `token` + `capt` field), NO PHPSESSID session
  - `/msei/` captchas have 4 digits (vs 3 for `/msf/`), lower per-attempt accuracy
  - New `_extractMseiUprot(url)`: GET page → extract token+captcha → OCR → POST token+capt → extract redirect → MaxStream
  - Per-path-type cookie cache: `/msf/` uses PHPSESSID (cached 22h), `/msei/` solves per-URL (no caching possible)
  - 5 retry attempts for `/msei/` (4-digit captcha ≈ 31-52% per-attempt)
  - Redirect pattern: `maxstream.video/uprotem/...` (different from `/msf/`'s `maxstream.video/uprots/...`)
  - Uprot URL path types: `/msf/` (single file ✅), `/mse/` → `/msf/` (✅), `/msei/` (episode ✅), `/msfld/` (folder/series ❌)




## ═══ EUROSTREAMING COMPLETE FIX GUIDE ═══

### PROBLEMA
Cloudflare blocca TUTTE le richieste da Vercel (Frankfurt) verso eurostream.ing → 403 "Just a moment...".
Il CF Worker proxy NON funziona perché il Worker esegue all'edge di Vercel (Frankfurt) → stessa cosa.
Da IP italiani residenziali (es. macchina locale) funziona tutto.

### ARCHITETTURA SOLUZIONE (3 livelli)

**Livello 1: File batch locali (deploy-time, più veloce)**
- `warm-es-cache.js` — script da eseguire in LOCALE (non su Vercel!)
  - Scarica TUTTE le pagine da `eurostream.ing/wp-json/wp/v2/posts` (100 post per pagina)
  - Salva come `es-cache/page-{N}.json.gz` (gzipped, ~8.4 MB totali per ~5100 post)
  - Genera `es-titles-index.json` (titolo → [{id, page}], ~5100 entries)
  - Comando: `cd StreamFusionMail && node warm-es-cache.js`
- Il codice legge prima i file .gz locali (zero network call)
- `vercel.json` ha `includeFiles: ["es-cache/**", "es-titles-index.json"]`
- Per aggiornare: `node warm-es-cache.js` → `git add -f es-cache/ es-titles-index.json` → commit → push

**Livello 2: CF Worker KV auto-refresh (cron, per nuove serie)**
- CF Worker ha un handler `scheduled()` con cron `*/15 * * * *` (ogni 15 min)
- Ogni esecuzione processa 10 pagine → salva in KV come `es:page:{N}` (batch)
- ~6 esecuzioni (90 min) per completare tutte le ~52 pagine
- A completamento salva indice titoli in KV come `es:titles`
- Cooldown 24 ore tra refresh completi
- ~55 KV writes per refresh (limite free: 1000/giorno)
- Stato salvato in `es:warm:state` (nextPage, titles accumulati, lastComplete timestamp)

**Livello 3: Live API fallback (locale)**
- Se né i file locali né il KV hanno risultati, prova la live WP search API
- Funziona solo da IP residenziali (locale), non da Vercel

### FLUSSO DI RICERCA (`searchAndExtract`)
1. `_searchViaKvIndex(showname)`:
   - Carica indice titoli da file locale (`es-titles-index.json`) → cache in memoria
   - Se nessun risultato nel locale, chiede indice KV al Worker (`?es_titles=1`)
   - Matching con `titleRatio()` ≥ 0.6, ordina per ratio desc
2. Per ogni candidato: `_fetchPostFromKv(postId, pageNum)`:
   - Legge `es-cache/page-{N}.json.gz` locale → gunzip → trova post per ID
   - Fallback: chiede al Worker (`?es_post_data={id}&es_page={N}`)
3. Verifica titolo (ratio ≥ 0.96 o year match ±1)
4. `findEpisodeStreams()` → parse HTML per link clicka.cc
5. `scrapingLinks()` → risolve clicka → safego → deltabit/turbovid/mixdrop
6. Se 0 risultati da KV → **Phase 2**: live WP search API (funziona solo locale)

### FLUSSO DI PLAYBACK (link resolution)
- **DeltaBit/Turbovid**: Stremio chiama Worker URL con `?es_stream=1&url=clicka.cc/...`
  - Worker: clicka → safego → captcha OCR → deltabit/turbovid page → video URL → 302 redirect
  - Stremio riproduce direttamente il video (stream set come `mfpHandled: true`)
- **MixDrop**: Worker `?es_resolve=1&url=clicka.cc/mix/...` → mixdrop URL → MFP proxy
- Worker auth: `<CF_WORKER_AUTH env var>`

### FILE CHIAVE
- `cfworker.js`: CF Worker con proxy, KV cache, es_stream, es_resolve, warm endpoints, scheduled cron
- `wrangler.toml`: config Worker (KV binding `ES_CACHE`, cron `*/15 * * * *`, smart placement)
- `src/eurostreaming/index.js`: provider completo (search, match, extract, link resolution)
- `warm-es-cache.js`: script warm-up locale (fetch diretto → .gz files + index)
- `es-cache/`: directory con page-{N}.json.gz
- `es-titles-index.json`: indice titoli statico

### TROUBLESHOOTING
- **0 stream Eurostreaming su Vercel**: verificare che `es-cache/` sia nel repo e `vercel.json` abbia `includeFiles`
- **Serie nuova non trovata**: aspettare il cron (max 90 min) o eseguire `node warm-es-cache.js` + push
- **KV non si aggiorna**: controllare `es:warm:state` via `?kv_test=1`, verificare daily write limit
- **Playback non funziona**: il Worker deve essere deployato (`npx wrangler deploy cfworker.js --name kisskh-proxy`), verificare con `?es_stream=1&url=...` manuale
- **KV daily limit esaurito**: 1000 writes/giorno account-wide. Il cron usa ~55 writes per refresh completo. NON fare warm-up manuale e cron nello stesso giorno
- **.gitignore blocca .json**: usare `git add -f es-titles-index.json es-cache/` per forzare

- 2026-03-10: Guardaserie can hit many SuperVideo mirrors in parallel; Puppeteer local launches may collide on profile dirs. Using a unique `userDataDir` per launch avoids `browser is already running for ... puppeteer_dev_profile-*` errors.
- 2026-03-10: Production browser fallback was broken by `puppeteer-extra-plugin-stealth` bundling on Vercel (`Cannot find module 'puppeteer-extra-plugin-stealth/evasions/chrome.app'`). Using plain `puppeteer-core` in `src/utils/browser.js` restores Browserless/serverless Chromium launches.
- 2026-03-10: Main `/stream` IMDB route has an outer timeout in `src/providers/index.js` for `easystreams.imdb`; if Guardaserie needs browser-based SuperVideo capture, 30s is too low even when the provider itself succeeds. Raising that outer timeout is required for Guardaserie to appear in final responses.
- 2026-03-10: Final public-series fix for Guardaserie on Vercel: preserve streams keyed by `url || externalUrl`, honor requested providers in `src/index.js`, and skip legacy KissKH/Rama IMDB jobs by default when easystreams is active. Verified `/stream/series/tt0460649:7:18.json` now returns Guardaserie streams plus the tokenized `serversicuro.cc` URL with `Referer: https://supervideo.cc/`.
- 2026-03-10: Guardaserie in-app Stremio playback fix: remove `proxyPlaybackDisabled` for header-protected direct HLS streams so `formatStream()` wraps them through `/proxy/hls/manifest.m3u8` and sets `notWebReady: false`. If any direct Guardaserie stream exists for an episode, drop the browser-only `isExternal` fallbacks to avoid Stremio opening the web page instead of playing inline.
- 2026-03-10: **serversicuro.cc HLS tokens are IP-locked**: SuperVideo manifests on serversicuro.cc contain `i=` parameter binding the token to the requesting IP. FIX: Webshare datacenter proxy pipeline — browser extracts manifest through proxy, HLS proxy fetches segments through same proxy IP. JWT token carries `p` field with proxy URL. `extractSuperVideoValidated()` allows serversicuro URLs when `result.proxyUrl` is set.
- 2026-03-10: **Guardaserie SuperVideo mirror fallback**: Some SuperVideo mirrors get Cloudflare challenge (6KB "Attention Required" page) even with proxy. Fix: try mirrors SEQUENTIALLY (not just first), early-detect CF challenge (htmlLen < 15KB + CF keywords), abort quickly and try next mirror. De-duplicate mirror URLs before iterating.
- 2026-03-10: **Browserless.io 401 inconsistency**: Browserless WSS connection returns 401 when called from extractSuperVideo code path but works from simple debug endpoints. Root cause unknown. Local @sparticuz/chromium with --proxy-server works reliably as fallback. Reduced retry from 2 attempts to 1 to save ~2.5s.
- 2026-03-10: **SuperVideo browser concurrency**: only one Browserless session at a time via `_activeBrowserPromise` flag in supervideo.js. Concurrent callers skip immediately (return null). Prevents Browserless overload and Vercel gateway timeouts when Guardaserie has multiple mirrors.

- 2026-03-10: **SuperVideo CDN 404 detection**: Some serversicuro.cc CDN nodes (e.g. hfs309) return 404 for certain video files even on the browser's FIRST request. Previously, the extraction captured the manifest URL from the `page.on('request')` event WITHOUT checking the response status, causing broken "HD" streams to be returned. FIX: Added `page.on('response')` status validation — only manifest URLs with 200-399 status are kept. 404 URLs are discarded, extraction fails gracefully, and sequential mirror fallback tries the next mirror.
- 2026-03-10: **Cached manifest body optimization**: The browser's `page.on('response')` handler now captures the manifest body via `response.text()`. This body is passed through `extractSuperVideo` → formatter → `buildProxyUrl` as `cachedBody`, embedded in the JWT token (`b` field, max 4KB). The HLS proxy serves the cached body directly via `rewritePlaylist()` without re-fetching upstream. This avoids issues with single-use CDN tokens and reduces latency. Sub-playlist URLs are still fetched normally via the proxy.

- 2026-03-10: **SuperVideo HTTP extraction (no browser)**: Replaced slow browser extraction (~30-45s) with direct HTTP fetch + JS unpack (~2s). Flow: try wsProxy → supervideo.tv (403 from Cloudflare) → fall back to CF Worker proxy → get HTML → `extractPackedValue` → get full manifest URL with all tokens. This is the same approach as EasyStreams reference code. Early-return grace period set to 12s + 25s absolute cap.
- 2026-03-10: **serversicuro.cc IP lock is UNBREAKABLE from server-side**: The `i=` HMAC token parameter is strictly enforced by nginx. Token binds to the IP that fetched the embed page. CF Worker IP is inconsistent between requests (no fixed outgoing IP). wsProxy blocked by Cloudflare on supervideo.tv. Direct Vercel → supervideo.tv times out (Cloudflare). ALL proxy paths (direct, wsProxy, CF Worker) return 403 for manifest. Pragmatic fix: return serversicuro.cc URL directly to Stremio with `behaviorHints.proxyHeaders` (same as EasyStreams). Use `proxyPlaybackDisabled: true` to skip HLS proxy wrapping. Stream appears in listing but playback depends on user's player/network.
- 2026-03-10: **Quality detection for BANDWIDTH-only HLS manifests**: serversicuro.cc master.m3u8 uses `BANDWIDTH=` without `RESOLUTION=`. Added BANDWIDTH fallback to `checkQualityFromText()` (≥3500000 = 1080p, ≥1800000 = 720p, etc.). Also added URL pattern heuristic: `serversicuro.cc…urlset/master.m3u8` → assume 1080p as highest quality.


- 2026-03-12: **SuperVideo serversicuro.cc tokens with `i=0.0` are NOT IP-locked**: CF Worker sv_extract produces tokens with `i=0.0` which work from any IP. Previous assumption of strict IP-lock was wrong — only tokens with specific `i=x.y` are IP-locked. sv_extract returns manifestBody cached in HLS proxy token; master served from cache, sub-playlists/segments via CF Worker.
- 2026-03-12: **puppeteer-extra NOT usable on Vercel**: transitive deps (fs-extra, user-data-dir, user-preferences) are dynamic requires that Vercel's bundler misses. Using manual stealth evasions via `evaluateOnNewDocument()` in `applyStealthEvasions()` (webdriver, chrome.runtime, plugins, languages, permissions).
- 2026-03-12: **extractSuperVideoValidated tightened**: requires `manifestBody` for serversicuro.cc URLs on serverless. `proxyUrl` alone is not enough (extraction may use different IP than proxyUrl entry). CF Worker hasCfProxy acceptance removed.

- 2026-03-12: **Anime providers formatter language fix (v3.0.31)**: All 3 anime providers (AnimeUnity, AnimeWorld, AnimeSaturn) set `stream.language = "🇯🇵"` for SUB or `"🇮🇹"` for ITA dub via `resolveLanguageEmoji()`. The NelloStream formatter was ignoring this and re-deriving language from text search for "SUB" → never found it (titles sanitized) → all showed `🇮🇹 ITA`. Fix: formatter now checks `lang.includes('🇯🇵')` first → `🇯🇵 SUB ITA`.
- 2026-03-12: **Anime dedup language-aware (v3.0.31)**: All 3 anime providers deduped streams by URL only, dropping JP variant when same VixCloud URL served both. Fix: dedup key changed to `url + '|' + language` in all 3 providers. Both IT and JP variants now survive.
- 2026-03-12: **VixCloud quality check optimization**: Removed `checkQualityFromPlaylist()` fetch from `extractVixCloud()` — quality now derived from URL params (`h=1`/`b=1` → FHD/1080p, else 720p). Saves ~3s per stream. This was the bottleneck causing AnimeUnity to return only 1 result on Vercel (second path timed out).
- 2026-03-12: **Anime provider timeout reduction**: FETCH_TIMEOUT reduced 10s → 8s on all 3 providers. VixCloud fetch timeouts: proxy/direct 6s (`AbortSignal.timeout`), cloudscraper 8s (was 12s). Combined with quality check removal, AnimeUnity dual-path extraction now completes in ~2.4s locally (was ~5-6s).



- 2026-03-11: **IMDB series routing**: Previously only `streamingcommunity` and `guardaserie` were selected for IMDB series requests in `src/index.js`. Added `eurostreaming`, `cb01`, `toonitalia`, `loonex` to the selection array.
- 2026-03-11: **CB01 MixDrop playback fix**: MixDrop returns MP4 URLs requiring Referer/Origin headers. CB01's `extractFromResolvedUrl()` must include `notWebReady: true` in `behaviorHints` when `proxyHeaders` are present, otherwise Stremio ignores the headers and gets 403. Also fixed `shouldSetNotWebReady()` in `src/formatter.js` to return `true` for MP4 URLs with non-empty proxyHeaders/headers.
- 2026-03-11: **VOE extractor created** (`src/extractors/voe.js`): Ported from Python (mediaflow-proxy/MammaMia). Flow: fetch page → follow redirect → extract obfuscated JSON payload + external script LUTs → ROT13 variant + strip LUTs + base64 + char shift(-3) + reverse + base64 → JSON → `data.source`. ToonItalia's `getStreams` now calls `extractFromUrl(voeUrl)` instead of returning `isExternal: true`.
- 2026-03-11: **Uprot extractor created** (`src/extractors/uprot.js`): Attempts bypass of uprot.net captcha via CF Worker proxy. Looks for "CONTINUE" link in response → follows redirects to MaxStream URL → delegates to `extractMaxStream()`. Falls back gracefully if captcha is required (Spanish IP geo-bypass unconfirmed).
- 2026-03-11: **guardaflix module was missing from git**: `src/guardaflix/index.js` existed locally but wasn't committed. Caused `Cannot find module './guardaflix/index'` on Vercel, crashing the entire providers bootstrap and returning empty streams for ALL requests. Always verify new provider directories are in git before deploying.
- 2026-03-11: **Loonex works correctly**: Returns direct M3U8 URLs with `notWebReady: true` and proper headers. Was only excluded from IMDB series routing (now fixed).
- 2026-03-11: **ToonItalia search quality issue**: Pre-existing - searching for series titles often matches movie pages instead of the episodic series page. Episode parsing then finds 0 valid episodes. The VOE extractor itself works, but ToonItalia content matching needs improvement.

- 2026-03-11: **guardoserie domain updated** from `guardoserie.surf` to `guardoserie.digital`. Also added `guardoserie` to IMDB series `selectedProviders.push()` in `src/index.js` (was accidentally excluded).
- 2026-03-11: **provider_urls.js local override precedence**: Restructured to use `localOverrides` + `remoteData` merge pattern (`lastData = { ...remoteData, ...localOverrides }`). The remote GitHub JSON (`realbestia1/easystreams`) had stale `guardoserie.space` which overwrote the correct local `guardoserie.digital`.
- 2026-03-11: **guardoserie.digital Cloudflare Bot Fight Mode — UNBYPASSABLE from cloud**: Tested ALL approaches from Vercel (Frankfurt `fra1`): direct fetch, CF Worker proxy, CF Worker Smart Placement, `got-scraping` TLS fingerprinting, `.surf`/`.digital` domains. ALL return 403 with "Just a moment..." JS challenge. The block is IP-reputation-based (datacenter IPs), not TLS-based. Works perfectly from residential IPs (local dev). Reference addons (EasyStreams, MammaMia, StreamVix) also fail from cloud — only `curl_cffi` + residential proxy (MammaMia) or Puppeteer+Stealth (BaciAsiatici) could theoretically work. Scrubs 2026 (tt40197357) is ONLY on guardoserie; no other Italian provider has it.
- 2026-03-11: **Vercel region set to `fra1`** (Frankfurt) in `vercel.json` for lower latency to Italian streaming sites. Doesn't bypass guardoserie CF but benefits all other providers.
- 2026-03-11: **guardoserie proxyFetch helper** (`src/guardoserie/index.js`): Routes all fetch calls through CF Worker when `CF_WORKER_URL` env is set. Also has direct URL slug fallback: when search returns 0, tries `{baseUrl}/serie/{slug}/` via GET. Both work from residential IPs but not from cloud.
- 2026-03-13: **v3.0.51**: GuardaSerie Kitsu season fix — IMDB requests that resolve a Kitsu ID entered the Kitsu branch with `seasonHintForKitsu = null` → defaulted to S1. Fixed by detecting `isExplicitKitsuRequest` vs IMDB-resolved Kitsu and passing explicit season. Verified: Frieren S2E7 (tt31374543:2:7) → 3 correct streams. Commit `d505b39`.
- 2026-03-13: **v3.0.52**: GuardoSerie 3 major fixes:
  1. **Kitsu season fix** (same as GuardaSerie above)
  2. **Search extraction fix**: Pattern 0 (title attribute), quality badge stripping in Pattern 1, dedup changed from Map (kept last) to Set (keeps first). Fixed "FULL HDBreaking Bad" → "Serie Di Orologi" mismatch.
  3. **Direct URL Strategy 0**: Constructs `/episodio/{slug}-stagione-{S}-episodio-{E}/` before search. Locally: 1 stream in 2.3s. Eliminates multi-step search→serie→episode chain.
  - GuardoSerie **STILL 0 streams from Vercel**: CF Worker fetch to guardoserie.digital gets 403 CF challenge from Frankfurt POP. ALL proxy strategies fail: CF Worker, Webshare, headless browser. Only Italian POP succeeds.
  - Commit `89af16f`.
- 2026-03-13→14: **GuardoSerie KV cache trick** (like Eurostreaming):
  - CF Worker `gs_warm` endpoint: accepts list of guardoserie.digital URLs, fetches + caches in KV
  - Must be called from Italian IP (local PC) — primes KV cache globally
  - Normal proxy detects CF 403 block → falls back to KV → serves cached HTML
  - KV free tier: 1,000 writes/day. **Fixed cron-state death spiral**: ES cron was saving state in KV, on write failure state was lost → every 15min cron restarted from page 1 → exhausted all 1,000 writes/day. Fix: state now stored in Cache API (no write limits, per-POP).
  - **Read-before-write optimization**: proxy cache skips KV write if entry exists and < half TTL old. Cron page writes skip if array length unchanged.
  - After fix: ES cron uses ~66 KV writes/day (vs ~1,056 before). Leaves ~934 for guardoserie priming + normal proxy cache.
  - Priming: `gs_warm=1&u=URL1&u=URL2` (max 20 per call, checks freshness 12h)
  - KV keys: `p:{full URL}`, guardoserie TTL 24h

### GUARDOSERIE PRIMING GUIDE
- **When**: once per day from Italian PC (after midnight UTC when KV limit resets)
- **How**: Call CF Worker `?gs_warm=1&u=URL1&u=URL2...` with auth header from local
- **What to prime**: episode URLs `https://guardoserie.digital/episodio/{slug}-stagione-{S}-episodio-{E}/`
- **Cache duration**: 24h in KV (global, readable from any CF POP)
- **Flow on Vercel**: CF Worker (Frankfurt) → fetch → 403 → KV fallback → cached HTML → extract players → streams!
