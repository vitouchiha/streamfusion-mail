'use strict';

/**
 * StreamFusion Mail — Entry point
 *
 * Supports per-user configuration via base64url-encoded config in the URL path:
 *   /manifest.json                   → default (no proxy, no MFP)
 *   /BASE64_CONFIG/manifest.json     → custom user config
 *
 * The same applies to all Stremio routes:
 *   /BASE64_CONFIG/catalog/:type/:id/:extra.json
 *   /BASE64_CONFIG/meta/:type/:id.json
 *   /BASE64_CONFIG/stream/:type/:id.json
 *
 * Compatible with:
 *   - Vercel serverless: exports `module.exports` as Express app
 *   - Local dev:         node server.js
 *   - Docker:            node server.js (PORT env var)
 */

require('dotenv').config();

const express  = require('express');
const manifest = require('./manifest.json');
const { decodeConfig, isValidConfig, DEFAULT_CONFIG } = require('./src/utils/config');
const { createLogger } = require('./src/utils/logger');

const log = createLogger('server');

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

let _providersApi = null;
function getProvidersApi() {
  if (_providersApi) return _providersApi;
  try {
    _providersApi = require('./src/providers/index');
    return _providersApi;
  } catch (err) {
    log.error('providers bootstrap failed: ' + err.message);
    return null;
  }
}

// ─── Global 50s timeout guard (Vercel limit is 60s) ──────────────────────────
const SERVERLESS_TIMEOUT = Number(process.env.SERVERLESS_TIMEOUT) || 50_000;
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      log.warn('Request timed out', { path: req.path });
      res.status(504).json({ error: 'Gateway Timeout' });
    }
  }, SERVERLESS_TIMEOUT);
  // Clear timer when response finishes
  res.once('finish', () => clearTimeout(timer));
  res.once('close',  () => clearTimeout(timer));
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse extra args from path segment, e.g. "skip=20" or "search=my+drama" */
function parseExtra(str) {
  if (!str) return {};
  const out = {};
  for (const part of decodeURIComponent(str).split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** Get config from path param or return default */
function cfgFrom(param) {
  return (param && isValidConfig(param)) ? decodeConfig(param) : { ...DEFAULT_CONFIG };
}

/**
 * Extract the real client IP from standard proxy headers.
 * Vercel sets x-forwarded-for to the original client IP.
 */
function clientIpFrom(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

/** Stremio JSON response with optional Cache-Control */
function stremioJson(res, data, { maxAge = 0 } = {}) {
  if (maxAge > 0) {
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 3}`);
  } else {
    // Explicitly prevent Vercel Edge CDN from caching empty/null responses
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(data);
}

// ─── Stremio Protocol Routes ─────────────────────────────────────────────────
// Both default (no config prefix) and /:config prefixed variants.

// ─── Manifest builder (config-aware) ─────────────────────────────────────────

/**
 * Build a Stremio manifest tailored to the user's config.
 * - hideCatalogs: removes catalogs from the home screen
 * - providers: filters which provider catalogs appear
 * - cinemeta: enables stream requests for Cinemeta IMDB IDs (tt*)
 *
 * When cinemeta=true we declare resources with per-resource idPrefixes so that:
 *   • meta   only handles kisskh_* / rama_* → prevents "metadati non trovati"
 *     on Cinemeta items (getMeta returns null for tt* — Stremio must NOT call us)
 *   • stream handles kisskh_*, rama_*, AND tt* → Cinemeta → KissKH/Rama flow works
 */
function buildManifest(config) {
  const { hideCatalogs = false, providers = 'all', cinemeta = false } = config || {};

  // Filter catalogs by provider setting
  let catalogs = manifest.catalogs || [];
  if (providers === 'kisskh') catalogs = catalogs.filter(c => c.id.startsWith('kisskh'));
  else if (providers === 'rama') catalogs = catalogs.filter(c => c.id.startsWith('rama'));
  else if (providers === 'drammatica') catalogs = catalogs.filter(c => c.id.startsWith('drammatica'));
  else if (providers === 'guardaserie') catalogs = catalogs.filter(c => c.id.startsWith('guardaserie'));

  const nativeTypes    = manifest.types      || ['series'];
  const nativePrefixes = manifest.idPrefixes || ['kisskh_', 'rama_'];

  if (!cinemeta) {
    // Default: simple format, no Cinemeta support
    return {
      ...manifest,
      catalogs: hideCatalogs ? [] : catalogs,
    };
  }

  // cinemeta=true: use per-resource idPrefixes to avoid "metadati non trovati"
  const streamTypes    = [...new Set([...nativeTypes, 'movie'])];
  const streamPrefixes = [...new Set([...nativePrefixes, 'tt'])];

  return {
    ...manifest,
    catalogs:   hideCatalogs ? [] : catalogs,
    types:      streamTypes,
    idPrefixes: streamPrefixes,
    // Override resources with explicit per-resource idPrefixes:
    //   meta  → only our own IDs (no tt*) so Stremio uses Cinemeta for meta
    //   stream → our IDs + tt* so Cinemeta → KissKH/Rama works
    resources: [
      'catalog',
      { name: 'meta',   types: nativeTypes,  idPrefixes: nativePrefixes },
      { name: 'stream', types: streamTypes,   idPrefixes: streamPrefixes },
    ],
  };
}

// Manifest
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  const config = cfgFrom(req.params.config);
  stremioJson(res, buildManifest(config));
});

// Catalog — handles optional /skip=N extra segment
app.get([
  '/catalog/:type/:id/:extra.json',
  '/catalog/:type/:id.json',
  '/:config/catalog/:type/:id/:extra.json',
  '/:config/catalog/:type/:id.json',
], async (req, res) => {
  const config = { ...cfgFrom(req.params.config), clientIp: clientIpFrom(req) };
  const extra  = parseExtra(req.params.extra);
  try {
    const providersApi = getProvidersApi();
    if (!providersApi?.handleCatalog) return stremioJson(res, { metas: [] });
    const result = await providersApi.handleCatalog(req.params.type, req.params.id, extra, config);
    const age = result.metas && result.metas.length > 0 ? 300 : 0;
    stremioJson(res, result, { maxAge: age });
  } catch (err) {
    log.error(`catalogRoute: ${err.message}`);
    stremioJson(res, { metas: [] });
  }
});

// Meta
app.get([
  '/meta/:type/:id.json',
  '/:config/meta/:type/:id.json',
], async (req, res) => {
  const config = { ...cfgFrom(req.params.config), clientIp: clientIpFrom(req) };
  try {
    const providersApi = getProvidersApi();
    if (!providersApi?.handleMeta) return stremioJson(res, { meta: null });
    const metaResult = await providersApi.handleMeta(req.params.type, req.params.id, config);
    // Don't cache null results — let Stremio retry next time
    const age = (metaResult?.meta?.videos?.length > 0) ? 1800 : 0;
    stremioJson(res, metaResult, { maxAge: age });
  } catch (err) {
    log.error(`metaRoute: ${err.message}`);
    stremioJson(res, { meta: null });
  }
});

// Stream
app.get([
  '/stream/:type/:id.json',
  '/:config/stream/:type/:id.json',
], async (req, res) => {
  const config = { ...cfgFrom(req.params.config), clientIp: clientIpFrom(req) };
  try {
    const providersApi = getProvidersApi();
    if (!providersApi?.handleStream) return stremioJson(res, { streams: [] });
    const result = await providersApi.handleStream(req.params.type, req.params.id, config);
    const age = result.streams && result.streams.length > 0 ? 3600 : 0;
    stremioJson(res, result, { maxAge: age });
  } catch (err) {
    log.error(`streamRoute: ${err.message}`);
    stremioJson(res, { streams: [] });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: manifest.version, ts: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  res.json({
    providers: ["Easystreams", "Baciasiatici", "Drammatica", "GuardaSerie", "KissKH"],
    stats: { movies: 12500, series: 3400 }
  });
});

// ─── Debug (provider reachability) ───────────────────────────────────────────

/**
 * Simple token-based auth for debug endpoints.
 * Set DEBUG_TOKEN env var; pass as ?token=... or Authorization: Bearer ...
 */
function requireDebugAuth(req, res, next) {
  const token = (process.env.DEBUG_TOKEN || '').trim();
  if (!token) return next(); // no token configured → open (dev mode)
  const provided = req.query.token || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== token) {
    return res.status(401).json({ error: 'Unauthorized — set ?token= header or DEBUG_TOKEN env' });
  }
  next();
}

app.get('/debug/providers', requireDebugAuth, async (req, res) => {
  const axios = require('axios');
  const { getProxyAgent } = require('./src/utils/fetcher');
  const pa = getProxyAgent();
  const pc = pa ? { httpsAgent: pa, httpAgent: pa, proxy: false } : {};
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36';
  const result = { proxyConfigured: !!(process.env.PROXY_URL || '').trim() };
  for (const [key, url, opts] of [
    ['kisskh', 'https://kisskh.co/api/DramaList/List?page=1&type=1&sub=0&country=2&status=2&order=3&pageSize=5',
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://kisskh.co/' } }],
    ['rama', 'https://ramaorientalfansub.live/', { headers: { 'User-Agent': UA } }],
  ]) {
    try {
      const t0 = Date.now();
      const r = await axios.get(url, { ...opts, timeout: 8000, ...pc });
      result[key] = { ok: true, status: r.status, ms: Date.now() - t0, count: r.data?.data?.length };
    } catch (e) {
      result[key] = { ok: false, status: e?.response?.status, error: e.message };
    }
  }
  res.json(result);
});

app.get('/debug/providers-stream', requireDebugAuth, async (req, res) => {
  const raw = String(req.query.id || req.query.imdb || 'tt0944947:1:1').trim();
  const type = String(req.query.type || 'series').toLowerCase() === 'movie' ? 'movie' : 'series';
  const parts = raw.split(':');
  const imdbId = parts[0];
  const season = Number(parts[1] || 1);
  const episode = Number(parts[2] || 1);
  const timeoutMs = Number(req.query.timeout || 25_000);

  if (!/^tt\d+$/i.test(imdbId)) {
    return res.status(400).json({ error: 'Use an IMDb id (tt...) in ?id=tt1234567:1:1' });
  }

  const classifyError = (err) => {
    const msg = String(err?.message || err || '').toLowerCase();
    const code = String(err?.code || '').toUpperCase();
    const status = err?.response?.status || null;
    if (msg.startsWith('timeout:')) return { kind: 'timeout', code, status };
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('enotfound') || msg.includes('getaddrinfo')) {
      return { kind: 'dns', code, status };
    }
    if (status === 403 || status === 429 || msg.includes('cloudflare') || msg.includes('just a moment')) {
      return { kind: 'cloudflare', code, status };
    }
    if (status) return { kind: 'http', code, status };
    if (msg.includes('cannot find module')) return { kind: 'module', code, status };
    return { kind: 'runtime', code, status };
  };

  const resolveTitleForDebug = async () => {
    const out = { imdbId, source: null, title: null, error: null };
    try {
      const axios = require('axios');
      const metaType = type === 'movie' ? 'movie' : 'series';
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`, { timeout: 5000 });
      const title = r?.data?.meta?.name || null;
      if (title) {
        out.source = 'cinemeta';
        out.title = title;
        return out;
      }
    } catch (e) {
      out.error = String(e?.message || e);
    }
    try {
      const { findTitleByImdbId } = require('./src/utils/tmdb');
      const tmdbKey = process.env.TMDB_API_KEY || '6e0a84ca7b324763793422a6656d34ff';
      const title = await findTitleByImdbId(imdbId, tmdbKey);
      if (title) {
        out.source = 'tmdb';
        out.title = title;
      }
    } catch (e) {
      out.error = String(e?.message || e);
    }
    return out;
  };

  const withProbeTimeout = async (name, fn) => {
    const t0 = Date.now();
    try {
      const timer = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timeout:${timeoutMs}`)), timeoutMs);
      });
      const streams = await Promise.race([Promise.resolve().then(fn), timer]);
      const count = Array.isArray(streams) ? streams.length : 0;
      return {
        provider: name,
        status: count > 0 ? 'ok' : 'no_match',
        count,
        ms: Date.now() - t0,
        sampleNames: (Array.isArray(streams) ? streams : [])
          .slice(0, 3)
          .map(s => String(s?.name || '').trim())
          .filter(Boolean),
      };
    } catch (err) {
      const msg = String(err?.message || err);
      const cls = classifyError(err);
      return {
        provider: name,
        status: msg.startsWith('timeout:') ? 'timeout' : 'error',
        count: 0,
        ms: Date.now() - t0,
        error: msg,
        errorKind: cls.kind,
        errorCode: cls.code || null,
        errorStatus: cls.status,
      };
    }
  };

  const providersApi = getProvidersApi();
  const legacyConfig = {
    cinemeta: true,
    tmdbKey: process.env.TMDB_API_KEY || '6e0a84ca7b324763793422a6656d34ff',
  };
  const compositeId = type === 'movie' ? imdbId : `${imdbId}:${season}:${episode}`;

  const tests = [
    {
      name: 'kisskh',
      run: async () => (await providersApi?.handleStream?.(type, compositeId, { ...legacyConfig, providers: 'kisskh' }))?.streams || [],
    },
    {
      name: 'rama',
      run: async () => (await providersApi?.handleStream?.(type, compositeId, { ...legacyConfig, providers: 'rama' }))?.streams || [],
    },
    {
      name: 'drammatica',
      run: async () => (await providersApi?.handleStream?.(type, compositeId, { ...legacyConfig, providers: 'drammatica' }))?.streams || [],
    },
    {
      name: 'guardaserie-legacy',
      run: async () => (await providersApi?.handleStream?.(type, compositeId, { ...legacyConfig, providers: 'guardaserie' }))?.streams || [],
    },
    {
      name: 'streamingcommunity',
      run: async () => (await require('./src/streamingcommunity').getStreams(imdbId, type, season, episode)) || [],
    },
    {
      name: 'guardahd',
      run: async () => (await require('./src/guardahd').getStreams(imdbId, type, season, episode)) || [],
    },
    {
      name: 'guardaserie-easystreams',
      run: async () => (await require('./src/guardaserie').getStreams(imdbId, type, season, episode)) || [],
    },
    {
      name: 'guardoserie',
      run: async () => (await require('./src/guardoserie').getStreams(imdbId, type, season, episode)) || [],
    },
    {
      name: 'animeunity',
      run: async () => (await require('./src/animeunity').getStreams(imdbId, type, season, episode)) || [],
    },
    {
      name: 'animeworld',
      run: async () => (await require('./src/animeworld').getStreams(imdbId, type, season, episode)) || [],
    },
    {
      name: 'animesaturn',
      run: async () => (await require('./src/animesaturn').getStreams(imdbId, type, season, episode)) || [],
    },
  ];

  const results = [];
  for (const t of tests) {
    results.push(await withProbeTimeout(t.name, t.run));
  }

  const summary = {
    total: results.length,
    ok: results.filter(r => r.status === 'ok').length,
    noMatch: results.filter(r => r.status === 'no_match').length,
    timeout: results.filter(r => r.status === 'timeout').length,
    error: results.filter(r => r.status === 'error').length,
    streamTotal: results.reduce((acc, r) => acc + (r.count || 0), 0),
    byErrorKind: results
      .filter(r => r.status === 'error' || r.status === 'timeout')
      .reduce((acc, r) => {
        const k = r.errorKind || (r.status === 'timeout' ? 'timeout' : 'runtime');
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
  };

  const titleResolution = await resolveTitleForDebug();

  res.json({
    input: { id: raw, imdbId, type, season, episode, timeoutMs },
    titleResolution,
    summary,
    results,
  });
});

app.get('/debug/flaresolverr', requireDebugAuth, async (req, res) => {
  const { getFlareSolverrUrl } = require('./src/utils/flaresolverr');
  const url = getFlareSolverrUrl();
  const result = { FLARESOLVERR_URL: url ? url.slice(0, 60) : null, configured: !!url };
  if (!url) return res.json(result);

  const t0 = Date.now();
  // Test 1: FlareSolverr /health endpoint
  try {
    const axios = require('axios');
    const health = await axios.get(url.replace(/\/$/, '') + '/health', { timeout: 8000 });
    result.health = { status: health.data?.status, ms: Date.now() - t0 };
  } catch (err) {
    result.health = { error: err.message, ms: Date.now() - t0 };
  }

  // Test 2: FlareSolverr session+primer → KissKH catalog + episode API
  const t1 = Date.now();
  const testEpId = req.query.ep || '202614';
  try {
    const { createSession, destroySession, sessionGet } = require('./src/utils/flaresolverr');

    const sessionId = await createSession();
    result.sessionCreated = !!sessionId;
    if (!sessionId) { result.totalMs = Date.now()-t0; return res.json(result); }

    // Primer: visit main page to get cf_clearance into session
    const tP = Date.now();
    const primerBody = await sessionGet('https://kisskh.co/', sessionId);
    const isCFBlock = !primerBody ||
      primerBody.includes('Just a moment') ||
      primerBody.includes('Checking your browser') ||
      primerBody.includes('data-cf-challenge') ||
      (primerBody.includes('www.cloudflare.com') && primerBody.length < 50_000);
    result.primer = { ok: !!primerBody && !isCFBlock, bodyLen: primerBody?.length ?? 0, isCFBlock, ms: Date.now()-tP };

    if (!isCFBlock && primerBody) {
      // Chrome wraps JSON API responses in <pre> tags — strip HTML before parsing
      const parseBody = (b) => {
        if (!b) return null;
        const t = b.trim();
        if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch {} }
        const m = t.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (m) { try { return JSON.parse(m[1]); } catch {} }
        try { return JSON.parse(t.replace(/<[^>]+>/g, '').trim()); } catch {}
        return null;
      };

      const JSON_HEADERS = {
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://kisskh.co/',
        'Origin': 'https://kisskh.co',
        'X-Requested-With': 'XMLHttpRequest',
      };

      // Catalog API
      const tC = Date.now();
      const catBody = await sessionGet('https://kisskh.co/api/DramaList/List?page=1&type=1&sub=0&country=2&status=2&order=3&pageSize=5', sessionId, JSON_HEADERS);
      const catData = parseBody(catBody);
      result.kisskhCatalogApi = { gotJSON: !!catData, count: catData?.data?.length ?? 0, ms: Date.now()-tC };

      // Episode stream API — 3-step: primer + drama page + episode API with drama Referer
      const tE = Date.now();
      // Get first real series + episode from catalog
      let realSerieId = '12203'; let realEpId = testEpId;
      if (catData?.data?.length) {
        const firstSeriesId = catData.data[0].id; realSerieId = String(firstSeriesId);
        const detailBody = await sessionGet(`https://kisskh.co/api/DramaList/Drama/${firstSeriesId}?isq=false`, sessionId, JSON_HEADERS);
        const detailData = parseBody(detailBody);
        const firstEp = detailData?.episodes?.[0];
        if (firstEp?.id) realEpId = String(firstEp.id);
      }
      // Visit drama page to establish context
      const dramaPage = `https://kisskh.co/Drama/Any/Episode-Any?id=${realSerieId}&ep=${realEpId}`;
      await sessionGet(dramaPage, sessionId).catch(() => null);
      // Now call episode API with drama page as Referer
      const epApiHeaders = { 'Accept': 'application/json, text/plain, */*', 'Referer': dramaPage, 'Origin': 'https://kisskh.co', 'X-Requested-With': 'XMLHttpRequest' };
      const epBody = await sessionGet(`https://kisskh.co/api/DramaList/Episode/${realEpId}?type=2&sub=0&source=1&quality=auto`, sessionId, epApiHeaders);
      const epData = parseBody(epBody);
      result.kisskhEpisodeApi = {
        testedEpId: realEpId, testedSerieId: realSerieId,
        gotJSON: !!epData, hasVideo: !!(epData?.Video || epData?.video),
        videoPreview: epData?.Video ? String(epData.Video).slice(0, 80) : null,
        bodyPreview: !epData && epBody ? epBody.replace(/<[^>]+>/g,'').trim().slice(0,150) : undefined,
        ms: Date.now()-tE,
      };
    }

    destroySession(sessionId);
  } catch (err) {
    result.sessionTest = { error: err.message, ms: Date.now()-t1 };
  }

  result.totalMs = Date.now() - t0;
  res.json(result);
});

app.get('/debug/browser', requireDebugAuth, async (req, res) => {
  const { launchBrowser } = require('./src/utils/browser');
  const cfClearance = (process.env.CF_CLEARANCE_KISSKH || '').trim();
  const result = {
    BROWSERLESS_URL: (process.env.BROWSERLESS_URL || '').trim().slice(0, 60) || null,
    PROXY_URL: (process.env.PROXY_URL || '').trim().slice(0, 40) || null,
    CF_CLEARANCE_SET: !!cfClearance,
    CF_CLEARANCE_PREVIEW: cfClearance ? cfClearance.slice(0, 20) + '...' : null,
  };
  const t0 = Date.now();
  try {
    const browser = await launchBrowser();
    const version = await browser.version().catch(() => '?');
    result.connected = true;
    result.version = version;
    result.connectMs = Date.now() - t0;

    // Try navigating to kisskh — inject CF cookie if available
    const page = await browser.newPage();
    const proxyUrl = (process.env.PROXY_URL || '').trim();
    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        if (u.username) await page.authenticate({ username: u.username, password: u.password });
      } catch (_) {}
    }
    // Inject CF clearance cookie before navigation
    if (cfClearance) {
      const cfVal = cfClearance.replace(/^cf_clearance=/, '');
      await page.setCookie({ name: 'cf_clearance', value: cfVal, domain: 'kisskh.co', path: '/', httpOnly: true, secure: true }).catch(() => {});
    }
    await page.goto('https://kisskh.co/', { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    result.kisskhUrl = page.url();
    result.kisskhTitle = await page.title().catch(() => '?');
    result.cfChallenge = result.kisskhTitle.toLowerCase().includes('moment');
    await browser.close();
    result.totalMs = Date.now() - t0;
    res.json(result);
  } catch (err) {
    result.connected = false;
    result.error = err.message;
    result.ms = Date.now() - t0;
    res.json(result);
  }
});

app.get('/debug/drammatica', requireDebugAuth, async (req, res) => {
  // Drammatica.it is domain-parked (ParkLogic). This endpoint checks live status.
  const { fetchWithCloudscraper } = require('./src/utils/fetcher');
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const base = (req.query.url || 'https://www.drammatica.it').trim();
  const t0 = Date.now();
  try {
    const html = await fetchWithCloudscraper(base + '/', { referer: base, proxyUrl });
    const cheerio = require('cheerio');
    const $ = html ? cheerio.load(html) : null;
    const title = $ ? $('title').text().trim().slice(0, 80) : '';
    const isParked = !html || html.includes('parklogic') || html.includes('Redirecting...') || html.length < 6000;
    const articleCount = $ ? $('article').length : 0;
    res.json({ url: base, alive: !!html && !isParked, isParked, htmlLen: html?.length ?? 0, title, articleCount, ms: Date.now()-t0 });
  } catch (err) {
    res.json({ url: base, alive: false, error: err.message, ms: Date.now()-t0 });
  }
});

// ─── Landing Page ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(req.protocol + '://' + req.get('host'), null, null, _serverStatus()));
});

  app.get('/dashboard', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const landingPath = path.join(__dirname, '../web/landing/index.html');
    if (fs.existsSync(landingPath)) {
      res.sendFile(landingPath);
    } else {
      res.status(404).send('Dashboard not found');
    }
  });
  app.get('/:config', (req, res, next) => {
    if (!isValidConfig(req.params.config)) return next();
    const cfg = decodeConfig(req.params.config);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(req.protocol + '://' + req.get('host'), cfg, req.params.config, _serverStatus()));
});

// Stremio "Configure" button opens: transportUrl.replace('/manifest.json','') + '/configure'
// (some Stremio versions append /configure explicitly — handle both)
app.get(['/configure', '/:config/configure'], (req, res, next) => {
  const raw = req.params.config;
  if (raw && !isValidConfig(raw)) return next();
  const cfg = raw ? decodeConfig(raw) : null;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(req.protocol + '://' + req.get('host'), cfg, raw || null, _serverStatus()));
});

function _serverStatus() {
  return {
    proxyOk: !!(process.env.PROXY_URL || '').trim(),
    blOk:    !!(process.env.BROWSERLESS_URL || '').trim(),
    fsOk:    !!(process.env.FLARESOLVERR_URL || '').trim(),
  };
}

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  log.error('Express error: ' + err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Landing Page HTML Builder ────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

function buildPage(req, host) {
  const v = manifest.version;
  const f = req.config || {};
  function esc(s) { return (s || '').replace(/"/g, '&quot;'); }
  
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${manifest.name} ${v}</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #ff7eb3;
      --secondary: #00f2fe;
      --bg: #09090b;
      --bg-card: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 15% 50%, rgba(255, 126, 179, 0.12), transparent 25%),
        radial-gradient(circle at 85% 30%, rgba(0, 242, 254, 0.1), transparent 25%);
      color: var(--text);
      font-family: 'Poppins', sans-serif;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 40px 20px;
    }
    .container {
      max-width: 650px; width: 100%; background: var(--bg-card);
      backdrop-filter: blur(20px); border: 1px solid var(--glass-border);
      border-radius: 24px; padding: 45px 35px;
      box-shadow: 0 30px 60px -15px rgba(0,0,0,0.6); position: relative;
    }
    .container::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
    }
    .header { text-align: center; margin-bottom: 35px; }
    h1 {
      font-weight: 800; font-size: 2.8rem; margin-bottom: 10px; letter-spacing: -1px;
      background: -webkit-linear-gradient(0deg, var(--primary), var(--secondary));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .badge {
      display: inline-block; vertical-align: super;
      background: rgba(255, 126, 179, 0.15); border: 1px solid rgba(255, 126, 179, 0.3);
      color: var(--primary); padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: 600;
    }
    .lead { color: var(--text-muted); font-size: 0.95rem; line-height: 1.6; }
    .card { background: rgba(0,0,0,0.2); border-radius: 16px; padding: 25px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.05); }
    .card-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; color: #fff; text-transform:uppercase; font-size:0.9rem; letter-spacing:1px; }
    .input-grp { margin-bottom: 15px; }
    label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; font-weight: 500; }
    input[type=url] {
      width: 100%; background: #18191c; border: 1px solid #272a30; border-radius: 10px;
      padding: 14px 16px; color: #fff; font-size: 0.95rem; font-family: 'Poppins', sans-serif;
      transition: all 0.2s ease; outline: none;
    }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(255, 126, 179, 0.15); }
    .hint { font-size: 0.75rem; color: #64748b; margin-top: 8px; line-height: 1.4; }
    .checks { display: flex; flex-direction: column; gap: 12px; margin-top: 5px; }
    .check-label {
      display: flex; align-items: center; gap: 12px; font-size: 0.9rem; color: #cbd5e1; cursor: pointer;
      background: #18191c; padding: 12px 16px; border-radius: 10px; border: 1px solid #272a30; transition: 0.2s;
    }
    .check-label:hover { border-color: #475569; }
    .check-label input { width: 18px; height: 18px; accent-color: var(--primary); }
    .btn-submit {
      width: 100%; padding: 16px; margin-top: 10px;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: #000; border: none; border-radius: 12px; font-family: 'Poppins', sans-serif; font-size: 1.1rem;
      font-weight: 700; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 8px 20px rgba(255, 126, 179, 0.3);
    }
    .btn-submit:hover { transform: translateY(-2px); box-shadow: 0 12px 25px rgba(255, 126, 179, 0.4); }
    .btn-submit:active { transform: translateY(1px); }
    .result {
      display: none; background: rgba(0,0,0,0.3); border: 1px solid var(--secondary); border-radius: 16px;
      padding: 25px; margin-top: 25px; 
    }
    .result.show { display: block; animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
    .url-box {
      background: #0f1115; border: 1px solid #272a30; border-radius: 10px; padding: 14px;
      font-family: monospace; color: #a5b4fc; font-size: 0.9rem; word-break: break-all; margin-bottom: 20px;
    }
    .actions { display: flex; gap: 12px; }
    .btn-action {
      flex: 1; padding: 14px; border-radius: 10px; text-align: center; text-decoration: none;
      font-weight: 600; font-size: 0.95rem; cursor: pointer; border: none; font-family: 'Poppins', sans-serif;
    }
    .btn-stremio { background: linear-gradient(135deg, var(--secondary), #0093E9); color: #000; }
    .btn-stremio:hover { opacity: 0.9; }
    .btn-copy { background: #1e293b; color: #f8fafc; border: 1px solid #334155; }
    .toast { display: none; text-align: center; color: var(--secondary); font-size: 0.85rem; margin-top: 12px; font-weight: 500; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Nello Drama <span class="badge">v${v}</span></h1>
      <p class="lead">Il meglio dei Drama Coreani e Asiatici per Stremio.</p>
    </div>

    <form id="cfgForm">
      <div class="card">
        <div class="card-title">⚡ Reti e Bypass</div>
        <div class="input-grp">
          <label>URL Proxy MediaFlow (Opzionale)</label>
          <input type="url" id="m_url" placeholder="https://nome-mediaflow.com" value="${esc(f.mfpUrl)}"/>
          <div class="hint">Usato per sbloccare i flussi HLS se supportato dal server.</div>
        </div>
        <div class="input-grp">
          <label>IP Bypass Proxy Personale</label>
          <input type="url" id="p_url" placeholder="http://user:pass@host:port" value="${esc(f.proxyUrl)}"/>
          <div class="hint">Obbligatorio per i server Vercel al fine di aggirare Cloudflare su KissKH.</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🎭 Impostazioni Catalogo</div>
        <div class="checks">
          <label class="check-label">
            <input type="checkbox" id="h_cat" ${f.hideCats?'checked':''}/> 
            Nascondi cloni delle sezioni (Mostra solo le principali Cinemeta)
          </label>
          <label class="check-label">
            <input type="checkbox" id="c_mode" ${f.cinemetaMode !== false ? 'checked' : ''}/> 
            Attiva compatibilità con IMDb/Cinemeta (Consigliato)
          </label>
        </div>
      </div>

      <button type="submit" class="btn-submit">Ottieni Addon Nello Drama</button>
    </form>

    <div id="res" class="result">
      <div style="color:var(--secondary); font-weight:600; margin-bottom:10px; text-transform:uppercase;">Tutto Pronto</div>
      <div id="udisp" class="url-box"></div>
      <div class="actions">
        <button id="_actCp" class="btn-action btn-copy">Copia Link</button>
        <a id="_actInst" class="btn-action btn-stremio" href="#">Apri in Stremio</a>
      </div>
      <div id="okmsg" class="toast">✨ Link magico copiato negli appunti!</div>
    </div>
  </div>

<script>
document.addEventListener('DOMContentLoaded', function() {
    var frm = document.getElementById('cfgForm');
    if (!frm) return;
    
    // Prevent default form submission and generate correct URL
    frm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        function b64e(str) {
            return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(a,p){
                return String.fromCharCode(parseInt(p, 16));
              })).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
        }
        var pUrl = document.getElementById('p_url') ? document.getElementById('p_url').value.trim() : '';
        var mUrl = document.getElementById('m_url') ? document.getElementById('m_url').value.trim() : '';
        var hCat = document.getElementById('h_cat') ? document.getElementById('h_cat').checked : false;
        var cMode = document.getElementById('c_mode') ? document.getElementById('c_mode').checked : false;
        
        var c = {
            px: pUrl,
            mfp: mUrl,
            pv: 'a',
            hc: hCat ? 1 : 0,
            cm: cMode ? 1 : 0,
            tm: '6e0a84ca7b324763793422a6656d34ff'
        };
        
        // Base64 configuration string
        var enc = b64e(JSON.stringify(c));
        var base = window.location.origin;
        var finalUrl = enc ? (base + '/' + enc + '/manifest.json') : (base + '/manifest.json');
        
        // Translate format for stremio apps
        var stremioUrl = finalUrl.replace(/^https?:/, 'stremio:');
        
        var res = document.getElementById('res');
        res.style.display = 'block';
        res.classList.add('show');
        
        document.getElementById('udisp').textContent = finalUrl;
        document.getElementById('_actInst').href = stremioUrl;
        
        document.getElementById('_actCp').onclick = function(){
            navigator.clipboard.writeText(finalUrl).then(function(){
                var msg = document.getElementById('okmsg');
                msg.style.display = 'block';
                setTimeout(function(){ msg.style.display='none'; }, 3000);
            });
        };
    });
});</script>
</body>
</html>`;
}


// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    log.info('StreamFusion Mail running', { port: PORT });
    console.log('\n  ✅  StreamFusion Mail v' + manifest.version);
    console.log('  📡  http://localhost:' + PORT + '\n');
  });
}

module.exports = app;
