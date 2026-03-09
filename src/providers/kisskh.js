'use strict';

/**
 * KissKH provider
 * Source: https://kisskh.do
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

const API_BASE = 'https://kisskh.do/api';
const SITE_BASE = 'https://kisskh.do';

// ─── Static API keys (embedded in kisskh.do JavaScript bundle) ───────────────
// The .png endpoint bypasses Cloudflare WAF entirely (CF only protects the old
// /api/DramaList/Episode/{id}?type= JSON endpoint, not the .png variant).
// These keys are static across all browser sessions — update if streams stop.
const EPISODE_KKEY = '1DA20BA0FA767F7FBC784A34E39191A0978830BDC4152695A655BD63A7227408BD1FEA7FCBBA0B80413AD348FADFBF1FFAC32028F7C8B5FC7F138BC2CFFC324CF3B8A357AF3C12242329E3AC9458C1FE0F3FA83DB7CC86907707598EC18789D09A02B62FEF850583B58B374BE58CBD1F6257A54C12F176DDF23A33D1AB8ED294';
const SUB_KKEY     = '43B832ED7618A14320177D239448E8189AAC2F524A0CE644F80C476A5A3F43BB031BAD3AFA35E58F9507DE22A4FB2CC4FC069410DF0AD1AF514B2FC3C95F256916A05B8620570ECAE389037A88887266F4E6CA6A305C33E45B2F62D488DB3E72E6578BAEB2CD39ED30F2E29E13A3590E5872E3EAA36C73EB5438871F3AB8A700';

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
 * CF Worker URL for kisskh.co proxy.
 * Set CF_WORKER_URL env var (and optionally CF_WORKER_AUTH) on Vercel.
 *
 * GET helper for KissKH API.
 *
 * Priority:
 *   0. CF Worker (fast, runs on Cloudflare edge — bypasses CF bot protection
 *      because the Worker is trusted on the same Cloudflare network as kisskh.co)
 *   1. FlareSolverr session (primer visit → cf_clearance → API call from same Railway IP)
 *   2. Direct axios without cookie (fast, works if KissKH doesn't block the request)
 *   3. Direct axios with CF cookie from env
 *
 * @param {string} url
 * @param {number} [timeout=8000]
 * @param {string} [proxyUrl]
 * @param {string|undefined} [clientIp]
 * @param {boolean} [skipFlare=false]  Skip Worker+FlareSolverr; use for plain JSON
 *   endpoints that are never CF-challenged (DramaList/List, DramaList/Drama).
 * @returns {Promise<any|null>}
 */
function getCfWorkerUrl() {
  return (process.env.CF_WORKER_URL || '').trim() || null;
}

async function _cfWorkerGet(targetUrl, timeout = 8_000, extraParams = {}) {
  const base = getCfWorkerUrl();
  if (!base) return null;
  const workerUrl = new URL(base.replace(/\/$/, ''));
  workerUrl.searchParams.set('url', targetUrl);
  for (const [k, v] of Object.entries(extraParams)) workerUrl.searchParams.set(k, v);
  const headers = {};
  const auth = (process.env.CF_WORKER_AUTH || '').trim();
  if (auth) headers['x-worker-auth'] = auth;
  try {
    const resp = await axios.get(workerUrl.toString(), {
      headers,
      timeout,
      validateStatus: () => true,
      responseType: 'text',
    });

    const parseWorkerData = (payload) => {
      if (!payload) return null;
      if (typeof payload === 'object') return payload;
      if (typeof payload === 'string') {
        const t = payload.trim();
        if (!t) return null;
        try { return JSON.parse(t); } catch { return null; }
      }
      return null;
    };

    const parsed = parseWorkerData(resp.data);
    if (resp.status >= 400) {
      const msg = parsed?.error || `status ${resp.status}`;
      log.warn('CF Worker upstream error', { status: resp.status, msg, url: targetUrl.slice(0, 80) });
      return null;
    }
    if (!parsed) {
      log.warn('CF Worker returned non-JSON payload', { status: resp.status, url: targetUrl.slice(0, 80) });
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(`CF Worker request failed: ${err.message}`, { url: targetUrl.slice(0, 80) });
    return null;
  }
}

async function _apiGet(url, timeout = 8_000, proxyUrl, clientIp, skipFlare = false) {
  // 0. CF Worker (fast — no 15s FlareSolverr wait; Worker runs on Cloudflare edge)
  if (getCfWorkerUrl() && !skipFlare) {
    const result = await _cfWorkerGet(url, Math.min(timeout, 8_000));
    if (result) {
      log.info('CF Worker ✓', { url: url.slice(0, 80) });
      return result;
    }
    log.warn('CF Worker returned null, falling through to FlareSolverr/axios');
  }

  // 1. FlareSolverr session approach: primer visit + API call from same IP
  //    Hard 20 s cap — flareSolverrGetJSONWithPrimer can take up to ~110 s
  //    (two sequential sessionGet calls × 55 s MAX_TIMEOUT each), which makes
  //    Stremio time out before getMeta/catalog ever finishes.
  if (getFlareSolverrUrl() && !skipFlare) {
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
  // skipFlare=true: DramaList/List is a plain JSON endpoint — no CF bypass needed
  const data = await _apiGet(url, 8_000, proxyUrl, clientIp, true);
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

  // ─── Popularity sweep (order=1, pages 1–10) ───────────────────────────────
  // Runs in parallel with the recency sweep to cover classic/popular dramas
  // not present in the 600 most-recently-updated dramas (order=3).
  // e.g. "Crash Landing on You" (page 3), "Goblin" (page 3), "Boys Over Flowers" (page 10).
  const popularSweep = Promise.all(
    Array.from({ length: 10 }, (_, i) => i + 1).map(async p => {
      const url = `${API_BASE}/DramaList/List?page=${p}&type=1&sub=0&country=2&status=0&order=1&pageSize=30`;
      try {
        const data = await _apiGet(url, 8_000, proxyUrl, clientIp, true);
        if (!data?.data?.length) return [];
        return data.data
          .map(_mapItem)
          .filter(item => titleSimilarity(item.name, cleanQuery) > 0.3
            || cleanTitleForSearch(item.name).includes(cleanQuery));
      } catch (err) {
        log.warn(`popular search page ${p} failed: ${err.message}`);
        return [];
      }
    })
  ).then(results => results.flat());

  // ─── Recency sweep (order=3) ──────────────────────────────────────────────
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
          // skipFlare=true: plain JSON list endpoint, no CF bypass needed
          const data = await _apiGet(url, 8_000, proxyUrl, clientIp, true);
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

  // Merge popularity results (swept in parallel — no added latency)
  const popularResults = await popularSweep;
  allResults.push(...popularResults);

  // Deduplicate, then sort by descending similarity so exact matches bubble up
  // before partial matches (e.g. "Crash Landing on You" > "Crash" for that query)
  const seen = new Set();
  const allUnique = allResults.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
  allUnique.sort((a, b) => titleSimilarity(b.name, query) - titleSimilarity(a.name, query));
  const unique = allUnique.slice(0, limit);
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
 *
 * Uses direct axios (no FlareSolverr) because the drama detail API is not
 * CF-protected. FlareSolverr would add a 15s dead wait for each item.
 * A 7s hard cap ensures the catalog always returns within the response budget;
 * if enrichment times out the basic _mapItem() objects are returned instead.
 *
 * @param {Array} items  basic _mapItem() objects
 * @returns {Promise<Array>}
 */
async function _enrichCatalogItems(items, proxyUrl, clientIp) {
  const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
  const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};

  const enrichPromise = Promise.all(items.map(async (item) => {
    // If already in metaCache, use that — no network call needed
    const cached = metaCache.get(item.id);
    if (cached) {
      return _metaToCatalogItem(cached);
    }
    // Direct axios — bypass FlareSolverr (drama detail API is not CF-protected)
    const serieId = item.id.replace(/^kisskh_/, '');
    try {
      const { data } = await axios.get(
        `${API_BASE}/DramaList/Drama/${serieId}?isq=false`,
        { headers: _baseHeaders(clientIp), timeout: 6_000, ...proxyConfig }
      );
      if (!data) return item;
      const meta = _buildMeta(item.id, serieId, data, null);
      metaCache.set(item.id, meta);
      return _metaToCatalogItem(meta);
    } catch {
      return item; // fallback to basic item on any error
    }
  }));

  // 7s hard cap: if enrichment is still running, return basic items so Stremio
  // always gets a response before its home-page timeout fires
  const timeout = new Promise(resolve =>
    setTimeout(() => {
      log.warn('_enrichCatalogItems: 7s cap exceeded, returning basic items');
      resolve(items);
    }, 7_000)
  );

  return Promise.race([enrichPromise, timeout]);
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
    videos: (data.episodes || []).map((ep, idx) => {
      const video = {
        id: `${id}:${ep.id}`,
        title: ep.title || `Episode ${ep.number || idx + 1}`,
        season: Number(ep.season) || 1,
        episode: Number(ep.episode || ep.number || idx + 1),
        thumbnail: ep.thumbnail || data.thumbnail,
      };

      const overview = ep.description || ep.overview || ep.synopsis;
      if (overview) video.overview = overview;

      const released = ep.releaseDate;
      if (released) video.released = released;

      return video;
    }),
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

function _buildFallbackMeta(id, serieId) {
  return {
    id,
    type: 'series',
    name: `KissKH ${serieId}`,
    poster: '',
    background: undefined,
    description: 'Metadata temporaneamente non disponibile. Riprova tra pochi secondi.',
    releaseInfo: '',
    genres: undefined,
    cast: undefined,
    serieId,
    videos: [],
  };
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
  const dramaUrls = [
    `${API_BASE}/DramaList/Drama/${serieId}?isq=false`,
    `https://kisskh.co/api/DramaList/Drama/${serieId}?isq=false`,
  ];
  const castUrls = [
    `${API_BASE}/DramaList/Cast/${serieId}`,
    `https://kisskh.co/api/DramaList/Cast/${serieId}`,
  ];
  log.info('fetching meta', { id, url: dramaUrls[0] });

  try {
    const fetchFirst = async (urls, timeout, skipFlare = true) => {
        try {
          return await Promise.any(urls.map(async u => {
            const res = await _apiGet(u, timeout, config.proxyUrl, config.clientIp, skipFlare);
            if (!res) throw new Error('empty');
            return res;
          }));
        } catch {
          return null;
        }
      };

      // Faster parallel execution
      let [data, castData] = await Promise.all([
        fetchFirst(dramaUrls, 8_000, true),
        fetchFirst(castUrls, 8_000, true)
      ]);

      // Slow fallback only if drama detail failed
      if (!data) {
        log.warn('meta drama fast-path failed, retrying with CF bypass', { id, serieId });
        [data, castData] = await Promise.all([
          fetchFirst(dramaUrls, 10_000, false),
          castData ? Promise.resolve(castData) : fetchFirst(castUrls, 10_000, false)
        ]);
      }
    if (!data) {
      const fallback = _buildFallbackMeta(id, serieId);
      metaCache.set(id, fallback);
      return { meta: fallback };
    }

    const meta = _buildMeta(id, serieId, data, castData);

    // ── TMDB enrichment (fills poster with HD artwork, cast, genres, imdb_id) ─
    if (config.tmdbKey) {
      const year = meta.releaseInfo || null;
      // Strip year suffix e.g. "Therapy (2025)" → "Therapy" for better TMDB matching
      const tmdbTitle = meta.name.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      // Hard 10s cap so the total getMeta time stays well under META_TIMEOUT (30s)
      const tmdb = await Promise.race([
        enrichFromTmdb(tmdbTitle, year, config.tmdbKey).catch(() => null),
        new Promise(r => setTimeout(() => r(null), 10_000)),
      ]);
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
    const fallback = _buildFallbackMeta(id, serieId);
    metaCache.set(id, fallback);
    return { meta: fallback };
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

  // Lazily fetch heavy helpers only when needed to preserve stream timeout budget.
  let _metaLoaded = false;
  let _meta = null;
  const getMetaLazy = async () => {
    if (_metaLoaded) return _meta;
    _metaLoaded = true;
    const metaResult = await getMeta(seriesPart, config).catch(() => ({ meta: null }));
    _meta = metaResult?.meta || null;
    return _meta;
  };

  let _vTokenLoaded = false;
  let _vToken = null;
  const getVTokenLazy = async () => {
    if (_vTokenLoaded) return _vToken;
    _vTokenLoaded = true;
    _vToken = await _extractVTokenFromEpisodeAssets(serieId, episodeId, config.proxyUrl);
    return _vToken;
  };

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
      const token = await getVTokenLazy();
      const rawApiCandidates = [apiResult.streamUrl, ...(apiResult.altUrls || [])].filter(Boolean);
      const tokenizedApiCandidates = rawApiCandidates.map(u => _withVToken(u, token));
      const apiCandidates = [...new Set([...rawApiCandidates, ...tokenizedApiCandidates])]
        .filter(Boolean);
      for (const candidate of apiCandidates) {
        if (await _isLikelyPlayableHls(candidate, config.proxyUrl)) {
          rawUrl = candidate;
          break;
        }
      }
      subtitles  = await _getSubtitlesFromApiUrl(apiResult.subApiUrl, serieId, episodeId);
      if (!rawUrl && apiCandidates.length) {
        log.warn('api candidates found but none playable', { serieId, episodeId, count: apiCandidates.length });
      }
    } else {
      // 2. Fallback: parse episode HTML for embedded m3u8 URLs (fast, no browser)
      log.info('direct API failed, trying HTML stream extraction fallback', { serieId, episodeId });
      const htmlStream = await _fetchStreamFromEpisodeHtml(serieId, episodeId, config.proxyUrl);
      if (htmlStream && htmlStream.startsWith('http')) {
        const token = await getVTokenLazy();
        const htmlCandidates = [...new Set([htmlStream, _withVToken(htmlStream, token)].filter(Boolean))];
        for (const candidate of htmlCandidates) {
          if (await _isLikelyPlayableHls(candidate, config.proxyUrl)) {
            rawUrl = candidate;
            break;
          }
        }
        subtitles = await _getSubtitlesFromApiUrl(`${API_BASE}/Sub/${episodeId}?kkey=${SUB_KKEY}`, serieId, episodeId);
      }
    }

    if (!rawUrl) {
      const meta = await getMetaLazy();
      const episodeNumHint = _episodeNumberFromMeta(meta?.videos, episodeId);
      const predicted = _predictHlsUrl(serieId, episodeNumHint);
      if (predicted) {
        const token = await getVTokenLazy();
        const tokenizedPredicted = _withVToken(predicted, token);
        const ok = await _isLikelyPlayableHls(tokenizedPredicted, config.proxyUrl);
        if (ok) {
          rawUrl = tokenizedPredicted;
          subtitles = await _getSubtitlesFromApiUrl(`${API_BASE}/Sub/${episodeId}?kkey=${SUB_KKEY}`, serieId, episodeId);
          log.warn('using heuristic predicted HLS URL fallback', { serieId, episodeId, episodeNumHint, hasVToken: !!token, url: tokenizedPredicted.slice(0, 90) });
        } else {
          log.warn('heuristic predicted HLS URL is not playable', { serieId, episodeId, episodeNumHint, hasVToken: !!token, url: tokenizedPredicted.slice(0, 90) });
        }
      }
    }

    if (!rawUrl) {
      // 3. Fallback: browser extraction (intercepts m3u8 via Puppeteer)
      log.info('heuristic fallback unavailable, trying browser extraction', { serieId, episodeId });
      const BROWSER_STREAM_TIMEOUT = 45_000;
      const browserResult = await withTimeout(
        _extractStreamAndSubs(serieId, episodeId),
        BROWSER_STREAM_TIMEOUT,
        'kisskh.browserStreamExtraction'
      ).catch(() => {
        log.warn('browser stream extraction timed out (45s cap)', { serieId, episodeId });
        return { streamUrl: null, subApiUrl: null };
      });
      const { streamUrl: extractedUrl, subApiUrl } = browserResult;
      rawUrl    = extractedUrl;
      if (!rawUrl) {
        log.warn('no stream found via browser', { serieId, episodeId });
        return [{ name: '[DEBUG]\\nKissKH', title: 'Nessun URL ottenuto da Browserless.\\nRiprova.', url: 'http://localhost/error.mp4' }];
      }
      subtitles = await _getSubtitlesFromApiUrl(subApiUrl || `${API_BASE}/Sub/${episodeId}?kkey=${SUB_KKEY}`, serieId, episodeId);
    }

    if (!rawUrl) {
      log.warn('no stream found', { serieId, episodeId });
      return [{ name: '[DEBUG]\\nKissKH', title: 'Nessun stream finale recuperato.\\nRiprova.', url: 'http://localhost/error.mp4' }];
    }

    // Last guard: avoid returning dead links that show in Stremio but fail to start.
    const playable = await _isLikelyPlayableHls(rawUrl, config.proxyUrl);
    if (!playable) {
      log.warn('final stream URL probe failed, returning no streams', { serieId, episodeId, url: rawUrl.slice(0, 100) });
      return [{ name: '[DEBUG]\\nKissKH', title: 'Stream trovato ma inattivo.\\nRiprova.', url: 'http://localhost/error.mp4' }];
    }
    streamCache.set(cacheKey, { url: rawUrl, subtitles });
  }

  // Validate URL before wrapping
  if (!rawUrl || !rawUrl.startsWith('http')) {
    log.warn('invalid stream URL format, skipping', { rawUrl: rawUrl ? rawUrl.slice(0, 80) : null });
    return [{ name: '[DEBUG]\\nKissKH', title: 'Stream URL non valido.\\nRiprova.', url: 'http://localhost/error.mp4' }];
  }

  // Wrap stream URL through MediaFlow Proxy if configured
  const finalUrl = wrapStreamUrl(rawUrl, config, {
    'Referer': SITE_BASE + '/',
    'Origin': SITE_BASE,
  });

  const metaForTitle = _metaLoaded ? _meta : null;
  const seriesTitle = metaForTitle?.name || null;
  const displayTitle = seriesTitle ? seriesTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim() : null;
  const titleLine = displayTitle
    ? `📁 ${displayTitle} - Episode ${episodeId}`
    : `📁 Episode ${episodeId}`;

  return [
    {
      name: '� KissKH',
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

function _episodeNumberFromMeta(videos, episodeId) {
  if (!Array.isArray(videos) || !episodeId) return null;
  const ep = videos.find(v => String(extractEpisodeNumericId(v.id || '')) === String(episodeId));
  if (!ep) return null;
  return Number(ep.episode) || Number(ep.number) || null;
}

function _predictHlsUrl(serieId, episodeNum) {
  if (!serieId || !episodeNum) return null;
  // Common KissKH pattern observed in production/local captures
  return `https://hls.cdnvideo11.shop/hls07/${serieId}/Ep${episodeNum}_index.m3u8`;
}

function _withVToken(url, token) {
  if (!url || !url.startsWith('http') || !token) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.get('v')) {
      u.searchParams.set('v', token);
    }
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}v=${encodeURIComponent(token)}`;
  }
}

async function _extractVTokenFromEpisodeAssets(serieId, episodeId, proxyUrl) {
  const episodeUrl = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
  const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
  const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};

  const tokenFromText = (text) => {
    if (!text) return null;
    const s = String(text);

    // 1) Explicit m3u8 with ?v=<token>
    const m3u8WithV = s.match(/\.m3u8[^"'\s<>]*[?&]v=([a-zA-Z0-9_-]{6,})/i);
    if (m3u8WithV?.[1]) return m3u8WithV[1];

    // 2) Generic token assignments used by player/runtime bundles
    const patterns = [
      /[?&]v=([a-zA-Z0-9_-]{6,})/i,
      /\bv\s*[:=]\s*['"]([a-zA-Z0-9_-]{6,})['"]/i,
      /\btoken\s*[:=]\s*['"]([a-zA-Z0-9_-]{6,})['"]/i,
      /\bvideoToken\s*[:=]\s*['"]([a-zA-Z0-9_-]{6,})['"]/i,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  };

  try {
    const { data } = await axios.get(episodeUrl, {
      headers: {
        ..._baseHeaders(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10_000,
      ...proxyConfig,
    });
    const html = String(data || '');
    if (!html) return null;

    // Check inline page source first.
    const inlineToken = tokenFromText(html);
    if (inlineToken) {
      log.info('v-token found in episode HTML', { episodeId, tokenPrefix: inlineToken.slice(0, 6) });
      return inlineToken;
    }

    // Then fetch a limited set of JS bundles referenced by the page.
    const scriptUrls = [...html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)]
      .map(m => m[1])
      .map(src => src.startsWith('http') ? src : new URL(src, SITE_BASE).toString())
      .filter(u => /\.(js)(\?|$)/i.test(u))
      .slice(0, 10);

    for (const scriptUrl of scriptUrls) {
      try {
        const { data: js } = await axios.get(scriptUrl, {
          headers: { ..._baseHeaders(), 'Accept': '*/*', 'Referer': episodeUrl },
          timeout: 8_000,
          responseType: 'text',
          ...proxyConfig,
        });
        const token = tokenFromText(js);
        if (token) {
          log.info('v-token found in player script', { episodeId, script: scriptUrl.slice(0, 80), tokenPrefix: token.slice(0, 6) });
          return token;
        }
      } catch {
        // Continue with other script candidates.
      }
    }

    log.warn('v-token not found in episode assets', { episodeId });
    return null;
  } catch (err) {
    log.warn(`v-token extraction failed: ${err.message}`, { episodeId });
    return null;
  }
}

async function _isLikelyPlayableHls(url, proxyUrl) {
  if (!url || !url.startsWith('http')) return false;
  const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
  const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};
  try {
    const resp = await axios.get(url, {
      headers: {
        ..._baseHeaders(),
        'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
      },
      timeout: 6_000,
      responseType: 'text',
      maxContentLength: 256 * 1024,
      maxBodyLength: 256 * 1024,
      validateStatus: () => true,
      ...proxyConfig,
    });
    if (resp.status < 200 || resp.status >= 300) return false;
    const text = String(resp.data || '');
    return text.includes('#EXTM3U');
  } catch {
    return false;
  }
}

async function _fetchStreamFromEpisodeHtml(serieId, episodeId, proxyUrl) {
  const episodeUrl = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
  const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
  const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};

  try {
    const { data } = await axios.get(episodeUrl, {
      headers: {
        ..._baseHeaders(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10_000,
      ...proxyConfig,
    });

    const html = String(data || '');
    if (!html) return null;

    // Try plain m3u8 URLs first.
    const direct = html.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i);
    if (direct && direct[0]) {
      log.info('html fallback found direct m3u8', { episodeId, url: direct[0].slice(0, 80) });
      return direct[0];
    }

    // Try escaped JSON form (https:\/\/...m3u8...)
    const escaped = html.match(/https?:\\\/\\\/[^"'\s<>]+\.m3u8(?:\\u0026[^"'\s<>]*)?/i);
    if (escaped && escaped[0]) {
      const normalized = escaped[0]
        .replace(/\\\//g, '/')
        .replace(/\\u0026/g, '&');
      if (normalized.startsWith('http')) {
        log.info('html fallback found escaped m3u8', { episodeId, url: normalized.slice(0, 80) });
        return normalized;
      }
    }

    log.warn('html fallback found no m3u8 URL', { episodeId });
    return null;
  } catch (err) {
    log.warn(`html fallback request failed: ${err.message}`, { episodeId });
    return null;
  }
}

// ─── Direct API stream extraction (no browser) ────────────────────────────────

/**
 * Fetches stream URL from kisskh.do's new .png endpoint (bypasses CF WAF entirely).
 *
 * The .png URL format was discovered by intercepting real browser network calls.
 * CF Bot Management only protects the old JSON endpoint (?type=), not the .png variant.
 * The kkeys are static values embedded in the kisskh.do JavaScript bundle.
 *
 * Endpoint: GET /api/DramaList/Episode/{id}.png?err=false&ts=null&time=null&kkey={EPISODE_KKEY}
 * Returns:  JSON { Video, Video_tmp, ThirdParty, Type, id, ... } with content-type image/png
 *
 * @returns {Promise<{streamUrl:string, subApiUrl:string}|null>}
 */
async function _fetchStreamViaPngApi(episodeId, proxyUrl) {
  const primaryDo = `https://kisskh.do/api/DramaList/Episode/${episodeId}.png`;
  const primaryCo = `https://kisskh.co/api/DramaList/Episode/${episodeId}.png`;
  const urls = [
    `${primaryDo}?kkey=${EPISODE_KKEY}`,
    `${primaryDo}?err=false&ts=null&time=null&kkey=${EPISODE_KKEY}`,
    `${primaryCo}?kkey=${EPISODE_KKEY}`,
    `${primaryCo}?err=false&ts=null&time=null&kkey=${EPISODE_KKEY}`,
  ];
  const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
  const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};

  const normalizeCandidateUrl = (u) => {
    if (!u || typeof u !== 'string') return null;
    const s = u.trim().replace(/\\\//g, '/');
    if (!s) return null;
    if (s.startsWith('//')) return `https:${s}`;
    if (/^https?:\/\//i.test(s)) return s;
    return null;
  };

  const parsePngPayload = (payload) => {
    let json = payload;
    if (Buffer.isBuffer(payload)) {
      json = payload.toString('utf8');
    }
    if (typeof json === 'string') {
      try { json = JSON.parse(json); } catch { return null; }
    }
    if (!json || typeof json !== 'object') return null;
    const rawCandidates = [json.Video, json.video, json.Video_tmp, json.video_tmp, json.url, json.stream, json.ThirdParty];
    const videoCandidates = [...new Set(rawCandidates.map(normalizeCandidateUrl).filter(Boolean))];
    if (!videoCandidates.length) return null;
    return {
      streamUrl: videoCandidates[0],
      altUrls: videoCandidates.slice(1),
      subApiUrl: `${API_BASE}/Sub/${episodeId}?kkey=${SUB_KKEY}`,
    };
  };

  // Try CF Worker first if available (often bypasses anti-bot checks for this endpoint)
  if (getCfWorkerUrl()) {
    for (const url of urls) {
      const workerData = await _cfWorkerGet(url, 8_000, { xhr: '1', referer: `${SITE_BASE}/` });
      const parsed = parsePngPayload(workerData);
      if (parsed) {
        log.info('.png API stream found via CF Worker', { episodeId, url: parsed.streamUrl.slice(0, 80) });
        return parsed;
      }
    }
  }

  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        headers: { ..._baseHeaders(), 'Accept': 'application/json, text/plain, */*' },
        timeout: 8_000,
        responseType: 'text',
        ...proxyConfig,
      });
      const parsed = parsePngPayload(data);
      if (!parsed) continue;
      log.info('.png API stream found', { episodeId, url: parsed.streamUrl.slice(0, 80) });
      return parsed;
    } catch (err) {
      log.warn(`_fetchStreamViaPngApi failed: ${err.message}`, { episodeId });
    }
  }

  return null;
}

/**
 * Attempts to get the KissKH stream URL via the API.
 *
 * Priority:
 *   0. .png endpoint with static kkey — no CF protection, fastest path
 *   1. FlareSolverr (FLARESOLVERR_URL) — real Chromium, bypasses CF Bot Management
 *   2. Direct axios + cf_clearance cookie (CF_CLEARANCE_KISSKH) — works only if IP
 *      region matches the cookie's origin; quick attempt, fails silently
 *
 * KissKH episode API (legacy, CF-protected):
 *   GET /api/DramaList/Episode/{id}?type=<1|2>&sub=0&source=<0|1>&quality=auto
 * Response JSON fields: Video, Sub, ThirdParty, ...
 *
 * @returns {Promise<{streamUrl:string, subApiUrl:string|null}|null>}
 */
async function _fetchStreamViaApi(serieId, episodeId, proxyUrl) {
  // ── 0. New .png endpoint (static kkey, no CF protection) ─────────────────
  log.info('trying .png API endpoint (static kkey, no CF)', { episodeId });
  const pngResult = await _fetchStreamViaPngApi(episodeId, proxyUrl);
  if (pngResult) return pngResult;
  log.warn('.png API returned no stream, falling back to legacy approaches', { episodeId });

  const _parseVideoData = (data) => {
    const rawCandidates = [
      data?.Video_tmp,
      data?.Video,
      data?.video,
      data?.url,
      data?.stream,
      data?.ThirdParty,
    ];
    const candidates = [...new Set(rawCandidates.filter(u => typeof u === 'string' && u.startsWith('http')))];
    if (candidates.length) {
      return {
        streamUrl: candidates[0],
        altUrls: candidates.slice(1),
        subApiUrl: `${API_BASE}/Sub/${episodeId}?kkey=${SUB_KKEY}`,
      };
    }
    return null;
  };

  // ── 0.5 Legacy episode API via CF Worker (fast fallback before FlareSolverr) ──
  if (getCfWorkerUrl()) {
    for (const [type, source] of [[2, 1], [1, 0], [2, 0], [1, 1]]) {
      const url = `${API_BASE}/DramaList/Episode/${episodeId}?type=${type}&sub=0&source=${source}&quality=auto`;
      const dramaPageReferer = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
      const workerData = await _cfWorkerGet(url, 8_000, { xhr: '1', referer: dramaPageReferer });
      const workerResult = _parseVideoData(workerData);
      if (workerResult) {
        log.info(`CF Worker stream found (type=${type},source=${source})`, { episodeId, url: workerResult.streamUrl.slice(0, 80) });
        return workerResult;
      }
    }
    log.warn('CF Worker episode API returned no stream URL', { episodeId });
  }

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
  //
  //   NOTE: CF Worker was tested here but kisskh.co CF Bot Management blocks
  //   Cloudflare Worker IPs (all datacenter IPs, including CF-origin ones).
  //   FlareSolverr (real Chromium browser) remains the reliable CF bypass.
  const hasBrowserless = !!(process.env.BROWSERLESS_URL || '').trim();
  if (getFlareSolverrUrl()) {
    const FS_STREAM_TIMEOUT = 15_000; // ms hard cap — reduced to leave more time for Puppeteer fallback
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
  const MAX_WAIT = Number(process.env.STREAM_MAX_WAIT) || 45_000; // ms
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

    // NOTE: Do NOT inject CF_CLEARANCE_KISSKH here — it may be stale or for a different
    // domain (kisskh.co vs kisskh.do). Injecting a wrong cookie prevents the browser from
    // solving the CF challenge fresh. Let Browserless.io handle CF naturally.

    // Block heavy resources; intercept m3u8 + sub API
    await page.setRequestInterception(true);
    const normalizeCandidateUrl = (u) => {
      if (!u || typeof u !== 'string') return null;
      const s = u.trim().replace(/\\\//g, '/');
      if (!s) return null;
      if (s.startsWith('//')) return `https:${s}`;
      if (/^https?:\/\//i.test(s)) return s;
      return null;
    };

    const pickVideoFromPayload = (payload) => {
      if (!payload || typeof payload !== 'object') return null;
      const candidates = [payload.Video, payload.video, payload.Video_tmp, payload.video_tmp, payload.url, payload.stream, payload.ThirdParty]
        .map(normalizeCandidateUrl)
        .filter(Boolean);
      return candidates.length ? candidates[0] : null;
    };

    page.on('request', req => {
      const rt = req.resourceType();
      const u = req.url();

      // Intercept HLS stream as early as possible, before any abort rules.
      // Some episodes request m3u8 as resourceType=media.
      if (!streamUrl && /\.m3u8(\?.*)?$/i.test(u)) {
        streamUrl = u;
        const hasV  = /[?&]v=[a-zA-Z0-9_-]+/.test(u);
        log.info(`intercepted stream (hasVParam=${hasV}): ${u.slice(0, 120)}`);
      }

      // Intercept subtitle API endpoint
      if (!subApiUrl && u.includes('/api/Sub/')) {
        subApiUrl = u;
        log.debug(`intercepted sub API: ${u.slice(0, 120)}`);
      }

      // Block heavy resources, but never abort m3u8 requests.
      if (['image', 'font', 'stylesheet'].includes(rt) || (rt === 'media' && !/\.m3u8(\?.*)?$/i.test(u))) {
        req.abort().catch(() => {});
        return;
      }

      // Log XHR/fetch for debugging
      if (!streamUrl && (rt === 'xhr' || rt === 'fetch')) {
        log.debug(`[intercept] ${rt} ${u.slice(0, 120)}`);
      }
      req.continue().catch(() => {});
    });

    // Some episodes fetch stream JSON via .png but delay the actual m3u8 request.
    page.on('response', async (res) => {
      if (streamUrl) return;
      const u = res.url();
      if (!/\/api\/DramaList\/Episode\/\d+\.png/i.test(u)) return;
      try {
        const txt = await res.text();
        const data = JSON.parse(txt);
        const found = pickVideoFromPayload(data);
        if (found) {
          streamUrl = found;
          log.info(`intercepted stream from .png response: ${found.slice(0, 120)}`);
        }
      } catch {
        // Ignore parse errors from non-JSON responses.
      }
    });

    const targetUrl = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
    log.info('navigating to episode page', { targetUrl });

    // Use 'domcontentloaded' — faster than 'networkidle2', CF challenge resolves faster
    // then we let the polling loop wait for the HLS intercept
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: MAX_WAIT }).catch((e) => {
      log.warn(`page.goto warning: ${e.message.slice(0, 80)}`);
    });

    // Log actual URL + title; if CF challenge is detected, wait for auto-resolution
    try {
      const finalUrl = page.url();
      const title = await page.title().catch(() => '');
      log.info('page loaded', { finalUrl: finalUrl.slice(0, 100), title: title.slice(0, 60) });
      const isCfChallenge = (t) => t.toLowerCase().includes('just a moment') || t.toLowerCase().includes('checking your browser');
      if (isCfChallenge(title)) {
        log.warn('CF challenge detected — waiting up to 18s for auto-resolution...');
        const cfDeadline = Date.now() + 18_000;
        while (Date.now() < cfDeadline) {
          await _sleep(1_500);
          const t2 = await page.title().catch(() => '');
          if (!isCfChallenge(t2)) {
            log.info('CF challenge resolved, title now:', { title: t2.slice(0, 60) });
            break;
          }
        }
      }
    } catch (_) {}

    // After potential CF resolution, extract the fresh cf_clearance and cache it so the
    // API fallback path on future warm requests benefits from a valid kisskh.do cookie.
    try {
      const pageCookies = await page.cookies();
      const freshCf = pageCookies.find(c => c.name === 'cf_clearance');
      if (freshCf && freshCf.value) {
        log.info(`browser obtained fresh cf_clearance: ${freshCf.value.slice(0, 12)}...`);
        process.env.CF_CLEARANCE_KISSKH = freshCf.value;
      }
    } catch (_) {}

    // Proactively fetch the .png episode payload from the browser context.
    // This runs with the page's live cookies/challenge state and can succeed
    // even when server-side axios receives 403.
    if (!streamUrl) {
      const browserPngUrl = await page.evaluate(async ({ epId, kkey }) => {
        const normalize = (u) => {
          if (!u || typeof u !== 'string') return null;
          const s = u.trim().replace(/\\\//g, '/');
          if (!s) return null;
          if (s.startsWith('//')) return `https:${s}`;
          if (/^https?:\/\//i.test(s)) return s;
          return null;
        };
        const pick = (payload) => {
          if (!payload || typeof payload !== 'object') return null;
          const fields = [payload.Video, payload.video, payload.Video_tmp, payload.video_tmp, payload.url, payload.stream, payload.ThirdParty];
          for (const f of fields) {
            const u = normalize(f);
            if (u) return u;
          }
          return null;
        };
        const candidateUrls = [
          `/api/DramaList/Episode/${epId}.png?kkey=${encodeURIComponent(kkey)}`,
          `/api/DramaList/Episode/${epId}.png?err=false&ts=null&time=null&kkey=${encodeURIComponent(kkey)}`,
        ];
        for (const u of candidateUrls) {
          try {
            const r = await fetch(u, { credentials: 'include' });
            if (!r.ok) continue;
            const txt = await r.text();
            const json = JSON.parse(txt);
            const found = pick(json);
            if (found) return found;
          } catch (_) {
            // Try next URL variant.
          }
        }
        return null;
      }, { epId: String(episodeId), kkey: EPISODE_KKEY }).catch(() => null);

      if (browserPngUrl) {
        streamUrl = browserPngUrl;
        log.info(`browser page fetch resolved .png stream: ${browserPngUrl.slice(0, 120)}`);
      }
    }

    // Give the video player 3s to start loading after the DOM is ready,
    // then nudge common player controls to trigger lazy stream requests.
    await page.evaluate(() => {
      const selectors = [
        'button[aria-label*="play" i]',
        '.vjs-big-play-button',
        '.jw-icon-playback',
        '.plyr__control--overlaid',
        'video',
        '.player',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && typeof el.click === 'function') {
          try { el.click(); } catch (_) {}
        }
      }
    }).catch(() => {});

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

  const headers = _baseHeaders();
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
  const H = _baseHeaders();
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
