'use strict';

/**
 * KissKH provider
 * Source: https://kisskh.co
 *
 * Provides:
 *   - getCatalog(skip, search)   → [{id, type, name, poster, ...}]
 *   - getMeta(id)                → {meta}
 *   - getStreams(id, episodeId)  → [{title, url, subtitles, behaviorHints}]
 *
 * Stream extraction uses Puppeteer + stealth to intercept .m3u8 requests
 * that include the 'v' parameter required by kisskh's CDN.
 */

const axios = require('axios');
const { launchBrowser } = require('../utils/browser');
const { getCloudflareCookie } = require('../utils/cloudflare');
const { decryptKisskhSubtitleFull, decryptKisskhSubtitleStatic } = require('../utils/subDecrypter');
const { TTLCache } = require('../utils/cache');
const { cleanTitleForSearch, titleSimilarity, extractEpisodeNumericId } = require('../utils/titleHelper');
const { withTimeout, makeProxyAgent, getProxyAgent } = require('../utils/fetcher');
const { wrapStreamUrl } = require('../utils/mediaflow');
const { enrichFromTmdb, rpdbPosterUrl, topPosterUrl } = require('../utils/tmdb');
const { flareSolverrGetJSONWithPrimer, createSession, destroySession, sessionGet, getFlareSolverrUrl } = require('../utils/flaresolverr');
const { createLogger } = require('../utils/logger');

const log = createLogger('kisskh');

const API_BASE = 'https://kisskh.co/api';
const SITE_BASE = 'https://kisskh.co';

const catalogCache = new TTLCache({ ttl: 10 * 60_000, maxSize: 200 });
const metaCache    = new TTLCache({ ttl: 30 * 60_000, maxSize: 500 });
const streamCache  = new TTLCache({ ttl: 2 * 60 * 60_000, maxSize: 1000 });
const subCache     = new TTLCache({ ttl: 24 * 60 * 60_000, maxSize: 500 });

// ─── Shared axios headers ─────────────────────────────────────────────────────

/** Base headers without CF cookie — fast, no Puppeteer */
function _baseHeaders(clientIp) {
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': SITE_BASE + '/',
    'Origin': SITE_BASE,
  };
  if (clientIp) h['X-Forwarded-For'] = clientIp;
  return h;
}

/** Full headers with CF cookie — slow, used only when base headers get 403 */
async function _headers(clientIp) {
  const cookie = await withTimeout(getCloudflareCookie(), 3_500, 'cf-cookie').catch(() => '');
  return { ..._baseHeaders(clientIp), ...(cookie ? { 'Cookie': cookie } : {}) };
}

/**
 * GET helper for KissKH API.
 *
 * Priority:
 *   1. FlareSolverr session (primer visit → cf_clearance → API call from same Railway IP)
 *   2. Direct axios without cookie (fast, works if KissKH doesn't block the request)
 *   3. Direct axios with CF cookie from env (slow but sometimes works)
 *
 * @param {string} url
 * @param {number} [timeout=8000]
 * @param {string} [proxyUrl]
 * @returns {Promise<any|null>}
 */
async function _apiGet(url, timeout = 8_000, proxyUrl, clientIp) {
  // 1. FlareSolverr session approach: primer visit + API call from same IP
  //    Hard 20 s cap — flareSolverrGetJSONWithPrimer can take up to ~110 s
  //    (two sequential sessionGet calls × 55 s MAX_TIMEOUT each), which makes
  //    Stremio time out before getMeta/catalog ever finishes.
  if (getFlareSolverrUrl()) {
    log.info('trying FlareSolverr session approach', { url: url.slice(0, 80) });
    const FS_META_TIMEOUT = 15_000;
    const fsResult = await Promise.race([
      flareSolverrGetJSONWithPrimer(url).catch(err => {
        log.warn(`FlareSolverr session failed: ${err.message}`);
        return null;
      }),
      new Promise(r => setTimeout(() => {
        log.warn('FlareSolverr meta/catalog: 15 s cap exceeded, falling back to direct axios');
        r(null);
      }, FS_META_TIMEOUT)),
    ]);
    if (fsResult) {
      log.info('FlareSolverr session succeeded ✓');
      return fsResult;
    }
    log.warn('FlareSolverr session returned null, falling back to direct axios');
  }

  // 2. Direct axios (fast path — no proxy, no cookie)
  const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
  const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};
  try {
    const { data } = await axios.get(url, { headers: _baseHeaders(clientIp), timeout, ...proxyConfig });
    return data;
  } catch (err) {
    const status = err?.response?.status;
    log.warn(`Direct axios failed (status=${status ?? 'network'}), retrying with CF cookie`, { url });
  }

  // 3. Retry with CF cookie
  try {
    const headers = await _headers(clientIp);
    const { data } = await axios.get(url, { headers, timeout, ...proxyConfig });
    return data;
  } catch (err2) {
    log.error(`All API attempts failed: ${err2.message}`, { url });
    return null;
  }
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

/**
 * @param {number} [skip=0]
 * @param {string} [search='']
 * @returns {Promise<Array>}
 */
async function getCatalog(skip = 0, search = '', config = {}) {
  const cacheKey = `catalog:${skip}:${search}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) {
    log.debug('catalog from cache');
    return cached;
  }

  const page = Math.floor(skip / 20) + 1;
  const items = search.trim()
    ? await _searchCatalog(search.trim(), 20, config.proxyUrl, config.clientIp)
    : await _listCatalog(page, 20, config.proxyUrl, config.clientIp);

  catalogCache.set(cacheKey, items);
  return items;
}

async function _listCatalog(page, limit, proxyUrl, clientIp) {
  // country=2 → Korea only; status=0 → all (ongoing + completed)
  const url = `${API_BASE}/DramaList/List?page=${page}&type=1&sub=0&country=2&status=0&order=3&pageSize=${limit}`;
  log.info('list catalog', { url });
  const data = await _apiGet(url, 8_000, proxyUrl, clientIp);
  if (!data || !data.data) return [];
  const basicItems = data.data.map(_mapItem);
  // Enrich all items in parallel with KissKH drama detail (not CF-protected, fast)
  // Side effect: populates metaCache so getMeta hits are served instantly
  return _enrichCatalogItems(basicItems, proxyUrl, clientIp);
}

async function _searchCatalog(query, limit = 20, proxyUrl, clientIp) {
  // NOTE: KissKH's `search=` parameter is ignored by the API — it always
  // returns dramas sorted by recency. We paginate manually and apply local
  // title-similarity filtering. To find older dramas we must search more pages.
  const cleanQuery = cleanTitleForSearch(query);
  const allResults = [];
  const maxPages   = 20;  // cover ~600 most-recent Korean dramas
  const BATCH_SIZE = 3;   // fetch 3 pages in parallel per batch
  // No emptyBatches early-exit: since `search=` is ignored, every page returns
  // recent dramas that won't match until we reach the target drama's page.

  for (let batchStart = 1; allResults.length < limit && batchStart <= maxPages; batchStart += BATCH_SIZE) {
    const pages = [];
    for (let p = batchStart; p < batchStart + BATCH_SIZE && p <= maxPages; p++) {
      pages.push(p);
    }
    const batchResults = await Promise.all(
      pages.map(async p => {
        // country=2 → Korea only; status=0 → ongoing + completed
        const url = `${API_BASE}/DramaList/List?page=${p}&type=1&sub=0&country=2&status=0&order=3&pageSize=30`;
        try {
          const data = await _apiGet(url, 8_000, proxyUrl, clientIp);
          if (!data || !data.data || !data.data.length) return [];
          return data.data
            .map(_mapItem)
            .filter(item => titleSimilarity(item.name, cleanQuery) > 0.3
              || cleanTitleForSearch(item.name).includes(cleanQuery));
        } catch (err) {
          log.warn(`search page ${p} failed: ${err.message}`);
          return [];
        }
      })
    );
    const batchFlat = batchResults.flat();
    allResults.push(...batchFlat);
    // Early-exit only when we have enough results
    if (allResults.length >= limit) break;
  }

  // Deduplicate
  const seen = new Set();
  const unique = allResults.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; }).slice(0, limit);
  // Enrich found items with KissKH detail
  return _enrichCatalogItems(unique, proxyUrl, clientIp);
}

function _mapItem(item) {
  return {
    id: `kisskh_${item.id}`,
    type: 'series',
    name: item.title,
    poster: item.thumbnail,
    posterShape: 'poster',
  };
}

/**
 * Enrich basic catalog items with KissKH drama detail data in parallel.
 * Populates metaCache as a side effect so getMeta is served from cache.
 * @param {Array} items  basic _mapItem() objects
 * @returns {Promise<Array>}
 */
async function _enrichCatalogItems(items, proxyUrl, clientIp) {
  const enriched = await Promise.all(items.map(async (item) => {
    // If already in metaCache, use that
    const cached = metaCache.get(item.id);
    if (cached) {
      return _metaToCatalogItem(cached);
    }
    // Fetch drama detail from KissKH (NOT CF-protected, fast)
    const serieId = item.id.replace(/^kisskh_/, '');
    const data = await _apiGet(
      `${API_BASE}/DramaList/Drama/${serieId}?isq=false`,
      6_000, proxyUrl, clientIp
    ).catch(() => null);
    if (!data) return item; // fallback to basic item
    const meta = _buildMeta(item.id, serieId, data, null);
    metaCache.set(item.id, meta);
    return _metaToCatalogItem(meta);
  }));
  return enriched;
}

/** Build the standard meta object from KissKH drama detail response */
function _buildMeta(id, serieId, data, castData) {
  let cast;
  if (Array.isArray(castData) && castData.length) {
    cast = castData
      .map(a => { const n = a.name || a.title || ''; const c = a.characterName || a.character || ''; return c ? `${n} (${c})` : n; })
      .filter(Boolean);
  } else if (Array.isArray(data.artists) && data.artists.length) {
    cast = data.artists.map(a => (typeof a === 'string' ? a : a.name || a.title || '')).filter(Boolean);
  }
  return {
    id,
    type: 'series',
    name: data.title,
    poster: data.thumbnail,
    background: data.thumbnail || undefined,
    description: data.description || '',
    releaseInfo: data.releaseDate ? data.releaseDate.slice(0, 4) : '',
    status: data.status || undefined,
    country: data.country || undefined,
    genres: Array.isArray(data.genres) && data.genres.length
      ? data.genres.map(g => (typeof g === 'string' ? g : g.name || g.title || '')).filter(Boolean)
      : (data.subCategory ? [data.subCategory] : undefined),
    cast: cast && cast.length ? cast : undefined,
    serieId,
    videos: (data.episodes || []).map((ep, idx) => ({
      id: `${id}:${ep.id}`,
      title: ep.title || `Episode ${ep.number || idx + 1}`,
      season: Number(ep.season) || 1,
      episode: Number(ep.episode || ep.number || idx + 1),
      overview: ep.description || ep.overview || ep.synopsis || '',
      thumbnail: ep.thumbnail || data.thumbnail,
      released: ep.releaseDate || '',
    })),
  };
}

/** Convert a full meta object to a lighter Stremio catalog item */
function _metaToCatalogItem(meta) {
  const item = {
    id: meta.id,
    type: 'series',
    name: meta.name,
    poster: meta.poster,
    posterShape: 'poster',
    releaseInfo: meta.releaseInfo || '',
  };
  if (meta.description) item.description = meta.description;
  if (meta.genres?.length) item.genres = meta.genres;
  if (meta.background) item.background = meta.background;
  return item;
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} id  e.g. "kisskh_1234"
 * @returns {Promise<{meta: object}>}
 */
async function getMeta(id, config = {}) {
  const cached = metaCache.get(id);
  if (cached) {
    log.debug('meta from cache', { id });
    return { meta: cached };
  }

  const serieId = id.replace(/^kisskh_/, '');
  const url = `${API_BASE}/DramaList/Drama/${serieId}?isq=false`;
  log.info('fetching meta', { id, url });

  try {
    // Fetch drama detail and cast in parallel
    const [data, castData] = await Promise.all([
      _apiGet(url, 8_000, config.proxyUrl, config.clientIp),
      _apiGet(`${API_BASE}/DramaList/Cast/${serieId}`, 6_000, config.proxyUrl, config.clientIp).catch(() => null),
    ]);
    if (!data) return { meta: null };

    const meta = _buildMeta(id, serieId, data, castData);

    // ── TMDB enrichment (fills poster with HD artwork, cast, genres, imdb_id) ─
    if (config.tmdbKey) {
      const year = meta.releaseInfo || null;
      const tmdb = await enrichFromTmdb(meta.name, year, config.tmdbKey).catch(() => null);
      if (tmdb) {
        if (tmdb.poster)                               meta.poster      = tmdb.poster;
        if (tmdb.background)                           meta.background  = tmdb.background;
        if (!meta.description && tmdb.description)     meta.description = tmdb.description;
        if (!meta.genres?.length && tmdb.genres?.length) meta.genres    = tmdb.genres;
        if (!meta.cast?.length  && tmdb.cast?.length)  meta.cast        = tmdb.cast;
        if (!meta.imdbRating   && tmdb.imdbRating)     meta.imdbRating  = tmdb.imdbRating;
        if (!meta.director     && tmdb.director)       meta.director    = tmdb.director;
        if (tmdb.imdbId) meta.imdb_id = tmdb.imdbId;
        // Poster priority: TopPoster > RPDB > TMDB
        const tp = topPosterUrl(config.topPosterKey, tmdb.imdbId);
        if (tp) {
          meta.poster = tp;
        } else if (config.rpdbKey) {
          const rp = rpdbPosterUrl(config.rpdbKey, tmdb.imdbId);
          if (rp) meta.poster = rp;
        }
      }
    }

    metaCache.set(id, meta);
    return { meta };
  } catch (err) {
    log.error(`getMeta failed: ${err.message}`, { id });
    return { meta: null };
  }
}

// ─── Stream ───────────────────────────────────────────────────────────────────

/**
 * Returns streams for a series:episode combination.
 * @param {string} stremioId  e.g. "kisskh_1234:5678"
 * @returns {Promise<Array>}
 */
async function getStreams(stremioId, config = {}) {
  const [seriesPart, episodePart] = stremioId.split(':');
  const serieId = seriesPart.replace(/^kisskh_/, '');
  const episodeId = episodePart ? extractEpisodeNumericId(episodePart) : null;

  if (!episodeId) {
    log.warn('no episodeId in stremioId', { stremioId });
    return [];
  }

  // Fetch series title for display (typically instant from metaCache)
  const metaResult = await getMeta(seriesPart, config).catch(() => ({ meta: null }));
  const seriesTitle = metaResult?.meta?.name || null;

  const cacheKey = `stream:${serieId}:${episodeId}`;
  const cached = streamCache.get(cacheKey);

  // Cache stores { url, subtitles } (raw, unwrapped) so MFP wrapping is per-request
  let rawUrl, subtitles;
  if (cached) {
    log.debug('stream from cache', { cacheKey });
    rawUrl = cached.url;
    subtitles = cached.subtitles;
  } else {
    // 1. Try direct API (FlareSolverr session → cf_clearance → JSON response)
    log.info('trying direct API stream extraction', { serieId, episodeId });
    const apiResult = await _fetchStreamViaApi(serieId, episodeId, config.proxyUrl);

    if (apiResult && apiResult.streamUrl) {
      rawUrl     = apiResult.streamUrl;
      subtitles  = await _getSubtitlesFromApiUrl(apiResult.subApiUrl, serieId, episodeId);
    } else {
      // 2. Fallback: browser extraction (intercepts m3u8 via Puppeteer)
      log.info('direct API failed, falling back to browser extraction', { serieId, episodeId });
      const { streamUrl: extractedUrl, subApiUrl } = await _extractStreamAndSubs(serieId, episodeId);
      rawUrl    = extractedUrl;
      if (!rawUrl) {
        log.warn('no stream found via browser', { serieId, episodeId });
        return [];
      }
      subtitles = await _getSubtitlesFromApiUrl(subApiUrl, serieId, episodeId);
    }

    if (!rawUrl) {
      log.warn('no stream found', { serieId, episodeId });
      return [];
    }
    streamCache.set(cacheKey, { url: rawUrl, subtitles });
  }

  // Validate URL before wrapping
  if (!rawUrl || !rawUrl.startsWith('http')) {
    log.warn('invalid stream URL format, skipping', { rawUrl: rawUrl ? rawUrl.slice(0, 80) : null });
    return [];
  }

  // Wrap stream URL through MediaFlow Proxy if configured
  const finalUrl = wrapStreamUrl(rawUrl, config, {
    'Referer': SITE_BASE + '/',
    'Origin': SITE_BASE,
  });

  const displayTitle = seriesTitle ? seriesTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim() : null;
  const titleLine = displayTitle
    ? `📁 ${displayTitle} - Episode ${episodeId}`
    : `📁 Episode ${episodeId}`;

  return [
    {
      name: '🚀 KissKH',
      description: `${titleLine}\n👤 KissKH\n🇰🇷 Sub ITA`,
      url: finalUrl,
      subtitles,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `streamfusion-kisskh-${seriesPart}`,
      },
    },
  ];
}

// ─── Direct API stream extraction (no browser) ────────────────────────────────

/**
 * Attempts to get the KissKH stream URL directly via their API.
 *
 * Priority:
 *   1. FlareSolverr (FLARESOLVERR_URL) — real Chromium, bypasses CF Bot Management
 *   2. Direct axios + cf_clearance cookie (CF_CLEARANCE_KISSKH) — works only if IP
 *      region matches the cookie's origin; quick attempt, fails silently
 *
 * KissKH episode API:
 *   GET /api/DramaList/Episode/{id}?type=<1|2>&sub=0&source=<0|1>&quality=auto
 * Response JSON fields: Video, Sub, ThirdParty, ...
 *
 * @returns {Promise<{streamUrl:string, subApiUrl:string|null}|null>}
 */
async function _fetchStreamViaApi(serieId, episodeId, proxyUrl) {
  const _parseVideoData = (data) => {
    const videoUrl = data?.Video || data?.video || data?.url || data?.stream;
    if (videoUrl && typeof videoUrl === 'string' && videoUrl.startsWith('http')) {
      return { streamUrl: videoUrl, subApiUrl: `${API_BASE}/Sub/${episodeId}` };
    }
    return null;
  };

  // Helper: parse FlareSolverr response body — Chrome wraps JSON in <pre> tags
  const _parseBody = (b) => {
    if (!b) return null;
    const t = b.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch {} }
    const m = t.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    try { return JSON.parse(t.replace(/<[^>]+>/g, '').trim()); } catch {}
    return null;
  };

  // ── 1. FlareSolverr 3-step session approach (hard 25 s cap) ──────────────
  //   If FlareSolverr is configured, try it first with a strict timeout so we
  //   still have room for the direct-axios fallback within STREAM_TIMEOUT.
  if (getFlareSolverrUrl()) {
    const FS_STREAM_TIMEOUT = 25_000; // ms hard cap for this block
    const fsResult = await Promise.race([
      (async () => {
        const sessionId = await createSession().catch(() => null);
        if (!sessionId) {
          log.warn('FlareSolverr: createSession failed');
          return null;
        }
        try {
          // Step A: CF primer
          log.info('FS stream: visiting primer', { episodeId });
          const primerBody = await sessionGet(SITE_BASE + '/', sessionId).catch(() => null);
          const isCFBlock = !primerBody ||
            primerBody.includes('Just a moment') ||
            primerBody.includes('Checking your browser') ||
            primerBody.includes('data-cf-challenge') ||
            (primerBody.includes('www.cloudflare.com') && primerBody.length < 50_000);
          if (isCFBlock) {
            log.warn('FS stream: CF challenge NOT resolved on primer');
            return null;
          }

          // Step B: episode API — use drama page URL as Referer without visiting it
          // (saves 8-15 s within the 25 s cap; CF primer cookie is sufficient)
          const dramaPageUrl = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;

          const apiHeaders = {
            'Accept': 'application/json, text/plain, */*',
            'Referer': dramaPageUrl,
            'Origin': SITE_BASE,
            'X-Requested-With': 'XMLHttpRequest',
          };
          for (const [type, source] of [[2, 1], [1, 0], [2, 0], [1, 1]]) {
            const url = `${API_BASE}/DramaList/Episode/${episodeId}?type=${type}&sub=0&source=${source}&quality=auto`;
            log.info(`FS stream: episode API type=${type} source=${source}`, { episodeId });
            const body = await sessionGet(url, sessionId, apiHeaders).catch(() => null);
            const data = _parseBody(body);
            const result = data ? _parseVideoData(data) : null;
            if (result) {
              log.info(`FS stream: found (type=${type},source=${source})`, { url: result.streamUrl.slice(0, 80) });
              return result;
            }
          }
          log.warn('FS stream: no video URL found in any API variant', { episodeId });
          return null;
        } finally {
          destroySession(sessionId);
        }
      })(),
      new Promise(r => setTimeout(() => { log.warn('FlareSolverr stream: 25 s cap exceeded, falling back'); r(null); }, FS_STREAM_TIMEOUT)),
    ]);

    if (fsResult) return fsResult;
    log.info('FlareSolverr stream failed/timed out — trying direct axios fallback');
  }

  // ── 2. Direct axios with proxy (api.kisskh.co is reachable without CF cookie) ──
  const proxyAgent2 = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
  const proxyCfg   = proxyAgent2 ? { httpsAgent: proxyAgent2, httpAgent: proxyAgent2, proxy: false } : {};
  const dramaPageReferer = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
  const directHeaders = {
    ..._baseHeaders(),
    'Accept': 'application/json, text/plain, */*',
    'Referer': dramaPageReferer,
    'Origin': SITE_BASE,
    'X-Requested-With': 'XMLHttpRequest',
  };
  for (const [type, source] of [[2, 1], [1, 0], [2, 0], [1, 1]]) {
    const url = `${API_BASE}/DramaList/Episode/${episodeId}?type=${type}&sub=0&source=${source}&quality=auto`;
    try {
      log.debug(`direct axios type=${type} source=${source}`, { episodeId });
      const { data } = await axios.get(url, { headers: directHeaders, timeout: 8_000, ...proxyCfg });
      if (typeof data === 'string' && (data.includes('<html') || data.includes('Just a moment'))) {
        log.debug('direct axios: CF challenge — giving up on direct');
        break;
      }
      const result = _parseVideoData(data);
      if (result) {
        log.info(`direct axios: stream found (type=${type},source=${source})`, { episodeId, url: result.streamUrl.slice(0, 80) });
        return result;
      }
    } catch (err) {
      log.debug(`direct axios type=${type} source=${source} failed: ${err?.response?.status ?? err.message}`);
    }
  }

  // ── 3. CF clearance cookie fallback ──────────────────────────────────────
  const cfClearance = (process.env.CF_CLEARANCE_KISSKH || '').trim();
  if (cfClearance) {
    const cookieVal = cfClearance.startsWith('cf_clearance=') ? cfClearance : `cf_clearance=${cfClearance}`;
    const cookieHeaders = { ..._baseHeaders(), 'Cookie': cookieVal };
    const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
    const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};

    for (const [type, source] of [[2, 1], [1, 0], [2, 0], [1, 1]]) {
      const url = `${API_BASE}/DramaList/Episode/${episodeId}?type=${type}&sub=0&source=${source}&quality=auto`;
      try {
        log.debug(`cookie API try type=${type} source=${source}`, { episodeId });
        const { data } = await axios.get(url, { headers: cookieHeaders, timeout: 8_000, ...proxyConfig });
        if (typeof data === 'string' && (data.includes('<html') || data.includes('Just a moment'))) {
          log.debug(`cookie API: CF challenge returned for type=${type}`);
          break;
        }
        const result = _parseVideoData(data);
        if (result) {
          log.info(`cookie API stream found (type=${type},source=${source})`, { episodeId, url: result.streamUrl.slice(0, 80) });
          return result;
        }
      } catch (err) {
        const status = err?.response?.status;
        log.debug(`cookie API type=${type} source=${source} failed: ${status ?? err.message}`);
      }
    }
    log.warn('cookie API: no stream URL found', { episodeId });
  } else {
    log.debug('No CF_CLEARANCE_KISSKH configured');
  }

  return null;
}

// ─── Combined stream + subtitle extraction (single browser session) ───────────

/**
 * Opens ONE browser session on the episode page and intercepts BOTH the HLS
 * stream URL (*.m3u8?v=…) and the subtitle API endpoint (/api/Sub/…).
 * Returns as soon as both are found or after STREAM_MAX_WAIT ms.
 *
 * @param {string} serieId
 * @param {string|number} episodeId
 * @returns {Promise<{streamUrl:string|null, subApiUrl:string|null}>}
 */
async function _extractStreamAndSubs(serieId, episodeId) {
  const MAX_WAIT = Number(process.env.STREAM_MAX_WAIT) || 40_000; // ms
  const browser = await launchBrowser();
  let streamUrl = null;
  let subApiUrl = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Authenticate with proxy if PROXY_URL is set (credential from URL like http://user:pass@host:port)
    const proxyUrl = (process.env.PROXY_URL || '').trim();
    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        if (u.username && u.password) {
          await page.authenticate({ username: u.username, password: u.password });
          log.debug('proxy authentication set for page');
        }
      } catch (_) { /* ignore parse errors */ }
    }

    // Inject CF clearance cookie
    const cfCookieStr = await getCloudflareCookie().catch(() => '');
    if (cfCookieStr) {
      const cfVal = cfCookieStr.replace(/^cf_clearance=/, '');
      await page.setCookie({ name: 'cf_clearance', value: cfVal, domain: 'kisskh.co', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    }

    // Block heavy resources; intercept m3u8 + sub API
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(rt)) {
        req.abort().catch(() => {});
        return;
      }
      const u = req.url();
      // Log XHR/fetch for debugging
      if (!streamUrl && (rt === 'xhr' || rt === 'fetch')) {
        log.debug(`[intercept] ${rt} ${u.slice(0, 120)}`);
      }
      // Intercept HLS stream — prefer URLs with ?v= (kisskh CDN token), fall back to any .m3u8
      if (!streamUrl && /\.m3u8(\?.*)?$/i.test(u)) {
        streamUrl = u;
        const hasV  = /[?&]v=[a-zA-Z0-9]+/.test(u);
        log.info(`intercepted stream (hasVParam=${hasV}): ${u.slice(0, 120)}`);
      }
      // Intercept subtitle API endpoint
      if (!subApiUrl && u.includes('/api/Sub/')) {
        subApiUrl = u;
        log.debug(`intercepted sub API: ${u.slice(0, 120)}`);
      }
      req.continue().catch(() => {});
    });

    const targetUrl = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
    log.info('navigating to episode page', { targetUrl });

    // Use 'domcontentloaded' — faster than 'networkidle2', CF challenge resolves faster
    // then we let the polling loop wait for the HLS intercept
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: MAX_WAIT }).catch((e) => {
      log.warn(`page.goto warning: ${e.message.slice(0, 80)}`);
    });

    // Log actual URL + title to verify we're on the right page (not a CF challenge)
    try {
      const finalUrl = page.url();
      const title = await page.title().catch(() => '');
      log.info('page loaded', { finalUrl: finalUrl.slice(0, 100), title: title.slice(0, 60) });
      if (title.toLowerCase().includes('just a moment')) {
        log.warn('CF challenge detected — waiting for auto-resolution...');
      }
    } catch (_) {}

    // Give the video player 3s to start loading after the DOM is ready,
    // then poll until both m3u8 + sub are intercepted (or timeout).
    await _sleep(3_000);
    const deadline = Date.now() + MAX_WAIT;
    while (Date.now() < deadline && !(streamUrl && subApiUrl)) {
      await _sleep(500);
    }

    log.info('extraction done', { streamFound: !!streamUrl, subFound: !!subApiUrl });
  } catch (err) {
    log.error(`browser extraction error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  return { streamUrl, subApiUrl };
}

async function _extractStream(serieId, episodeId) {
  const { streamUrl } = await _extractStreamAndSubs(serieId, episodeId);
  return streamUrl;
}

// ─── Subtitle extraction ───────────────────────────────────────────────────────

/**
 * Fetch & decrypt subtitles given an already-intercepted sub API URL.
 * No browser is launched here.
 */
async function _getSubtitlesFromApiUrl(subApiUrl, serieId, episodeId) {
  const cacheKey = `sub:${serieId}:${episodeId}`;
  const cached = subCache.get(cacheKey);
  if (cached) return cached;

  if (!subApiUrl) {
    log.warn('no subtitle API endpoint found', { serieId, episodeId });
    return [];
  }

  const headers = await _headers();
  let subtitleList;
  try {
    const resp = await axios.get(subApiUrl, { headers, timeout: 10_000, responseType: 'json' });
    subtitleList = Array.isArray(resp.data) ? resp.data : [resp.data];
  } catch (err) {
    log.warn(`subtitle API request failed: ${err.message}`);
    return [];
  }

  // Filter Italian
  const ITALIAN_PATTERN = /^https?:\/\/.*\.it\.(srt|txt1|txt)$/i;
  const itSubs = subtitleList.filter(s => {
    const lang = (s.land || s.label || '').toLowerCase();
    const src = _resolveSubUrl(s);
    return lang === 'it' || lang === 'italian' || (src && ITALIAN_PATTERN.test(src));
  });

  const decoded = [];
  const H = await _headers();
  const STATIC_KEY = Buffer.from('AmSmZVcH93UQUezi');
  const STATIC_IV  = Buffer.from('ReBKWW8cqdjPEnF6');

  for (const sub of itSubs) {
    const subUrl = _resolveSubUrl(sub);
    if (!subUrl) continue;
    try {
      const sresp = await axios.get(subUrl, { responseType: 'arraybuffer', headers: H, timeout: 10_000 });
      const buf = Buffer.from(sresp.data);
      const isEncrypted = /\.(txt1|txt)$/i.test(subUrl);
      let content;

      if (isEncrypted) {
        const asText = buf.toString('utf8').trim();
        content = asText.startsWith('1') || asText.startsWith('WEBVTT')
          ? decryptKisskhSubtitleFull(asText)
          : decryptKisskhSubtitleStatic(buf, STATIC_KEY, STATIC_IV);
      } else {
        content = buf.toString('utf8');
      }

      if (content && /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}/.test(content)) {
        decoded.push({ lang: 'it', content });
        log.info('Italian subtitle decoded', { subUrl: subUrl.slice(0, 60) });
        break; // First valid subtitle is enough
      }
    } catch (err) {
      log.warn(`subtitle fetch/decrypt error: ${err.message}`);
    }
  }

  subCache.set(cacheKey, decoded);
  return decoded;
}

function _resolveSubUrl(s) {
  if (s.src) return s.src;
  if (s.GET && s.GET.host && s.GET.filename) {
    let u = `${s.GET.scheme || 'https'}://${s.GET.host}${s.GET.filename}`;
    if (s.GET.query && s.GET.query.v) u += `?v=${s.GET.query.v}`;
    return u;
  }
  return null;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { getCatalog, getMeta, getStreams };
