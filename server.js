'use strict';

/**
 * StreamFusion Mail — Entry point
 *
 * Supports per-user configuration via base64url-encoded config in the URL path:
 *   /manifest.json                   → default (no proxy, no MFP)
 *   /BASE64_CONFIG/manifest.json     → custom user config
 *   /install/vX.Y.Z/manifest.json    → versioned install path for cache-busting
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

const axios = require('axios');
const crypto = require('crypto');
const express  = require('express');
const path = require('path');
const manifest = require('./manifest.json');
const { decodeConfig, isValidConfig, DEFAULT_CONFIG } = require('./src/utils/config');
const { getProxyAgent, makeProxyAgent, randomUA } = require('./src/utils/fetcher');
const {
  HLS_PROXY_PATH,
  isLikelyHlsPlaylist,
  parseProxyToken,
  rewritePlaylist,
} = require('./src/utils/hlsProxy');
const { createLogger } = require('./src/utils/logger');

const log = createLogger('server');

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', true);

// Serve file statici dalla cartella `public/` per copertine e loghi
app.use('/public', express.static(path.join(__dirname, 'public')));


let _providersApi = null;
let _providersBootstrapError = null;
function getProvidersApi() {
  if (_providersApi) return _providersApi;
  try {
    _providersApi = require('./src/providers/index');
    return _providersApi;
  } catch (err) {
    _providersBootstrapError = err.stack || err.message;
    log.error('providers bootstrap failed: ' + err.stack);
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

function addonBaseUrlFrom(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function currentInstallReleaseTag() {
  return `v${manifest.version}`;
}

function normalizeManifestConfig(config = {}) {
  return {
    mfpUrl: String(config.mfpUrl || '').trim(),
    mfpKey: String(config.mfpKey || '').trim(),
    proxyUrl: String(config.proxyUrl || '').trim(),
    hideCatalogs: Boolean(config.hideCatalogs),
    providers: String(config.providers || 'all').trim() || 'all',
    cinemeta: Boolean(config.cinemeta),
    tmdbKey: String(config.tmdbKey || DEFAULT_CONFIG.tmdbKey || '').trim(),
    rpdbKey: String(config.rpdbKey || '').trim(),
    topPosterKey: String(config.topPosterKey || '').trim(),
  };
}

function isDefaultManifestConfig(config = {}) {
  return JSON.stringify(normalizeManifestConfig(config)) === JSON.stringify(normalizeManifestConfig(DEFAULT_CONFIG));
}

function shouldUseConfiguredManifestIdentity(config = {}, options = {}) {
  return Boolean(options.forceConfiguredIdentity) || !isDefaultManifestConfig(config);
}

function buildManifestId(config = {}, options = {}) {
  const baseId = String(manifest.id || 'org.nello.drama').trim() || 'org.nello.drama';
  if (!shouldUseConfiguredManifestIdentity(config, options)) return baseId;
  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify(normalizeManifestConfig(config)))
    .digest('hex')
    .slice(0, 12);
  return `${baseId}.cfg${digest}`;
}

function buildManifestName(config = {}, options = {}) {
  return shouldUseConfiguredManifestIdentity(config, options) ? `${manifest.name} Config` : manifest.name;
}

function copyProxyResponseHeaders(res, headers = {}) {
  const passthrough = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ];

  for (const key of passthrough) {
    const value = headers[key];
    if (!value) continue;
    res.setHeader(key, value);
  }
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

app.get(HLS_PROXY_PATH, async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({ error: 'Missing proxy token' });
  }

  let proxyTarget;
  try {
    proxyTarget = parseProxyToken(token);
  } catch (err) {
    log.warn(`hlsProxy invalid token: ${err.message}`);
    return res.status(400).json({ error: 'Invalid proxy token' });
  }

  try {
    // This is critical for CDN nodes (e.g. serversicuro.cc) that invalidate master.m3u8 tokens
    // after the first browser fetch.
    if (proxyTarget.cachedBody && isLikelyHlsPlaylist(proxyTarget.url, '')) {
      try {
        const rewritten = rewritePlaylist(
          proxyTarget.cachedBody,
          proxyTarget.url,
          proxyTarget.headers,
          addonBaseUrlFrom(req),
          proxyTarget.expiresAt,
          proxyTarget.proxyUrl
        );
        res.status(200);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(rewritten);
      } catch (err) {
        log.error(`hlsProxy cached body rewrite error: ${err.message}`);
        // Fall through to normal upstream fetch
      }
    }

    // Use per-stream proxy (from token) if available; else fall back to global PROXY_URL
    const proxyAgent = proxyTarget.proxyUrl
      ? makeProxyAgent(proxyTarget.proxyUrl)
      : getProxyAgent();

    // For serversicuro.cc: tokens are IP-locked to the CF Worker that extracted them.
    // Route through the CF Worker proxy instead of wsProxy so the IP matches.
    const cfProxyUrl = (process.env.CF_PROXY_URL || '').trim();
    const usesCfProxy = cfProxyUrl && /serversicuro\.cc/i.test(proxyTarget.url);
    const fetchUrl = usesCfProxy
      ? `${cfProxyUrl}${cfProxyUrl.includes('?') ? '&' : '?'}url=${encodeURIComponent(proxyTarget.url)}`
      : proxyTarget.url;
    const fetchAgent = usesCfProxy ? null : proxyAgent;

    const upstream = await axios.get(fetchUrl, {
      responseType: 'stream',
      timeout: Number(process.env.HLS_PROXY_TIMEOUT) || 20_000,
      headers: {
        'User-Agent': proxyTarget.headers['User-Agent'] || randomUA(),
        'Accept': proxyTarget.headers['Accept'] || '*/*',
        ...(proxyTarget.headers['Accept-Language']
          ? { 'Accept-Language': proxyTarget.headers['Accept-Language'] }
          : {}),
        ...(proxyTarget.headers['Referer']
          ? { 'Referer': proxyTarget.headers['Referer'] }
          : {}),
        ...(proxyTarget.headers['Origin']
          ? { 'Origin': proxyTarget.headers['Origin'] }
          : {}),
        'Accept-Encoding': 'identity',
      },
      ...(fetchAgent ? { httpsAgent: fetchAgent, httpAgent: fetchAgent, proxy: false } : {}),
    });

    const contentType = String(upstream.headers['content-type'] || '');
    if (!isLikelyHlsPlaylist(proxyTarget.url, contentType)) {
      res.status(upstream.status);
      res.setHeader('Cache-Control', 'no-store');
      copyProxyResponseHeaders(res, upstream.headers);
      upstream.data.on('error', (err) => {
        log.error(`hlsProxy upstream stream error: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).end('Proxy stream error');
          return;
        }
        res.destroy(err);
      });
      upstream.data.pipe(res);
      return;
    }

    const chunks = [];
    upstream.data.setEncoding('utf8');
    upstream.data.on('data', (chunk) => chunks.push(chunk));
    upstream.data.on('error', (err) => {
      log.error(`hlsProxy playlist read error: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Playlist proxy error' });
      }
    });
    upstream.data.on('end', () => {
      try {
        const rewritten = rewritePlaylist(
          chunks.join(''),
          proxyTarget.url,
          proxyTarget.headers,
          addonBaseUrlFrom(req),
          proxyTarget.expiresAt,
          proxyTarget.proxyUrl
        );
        res.status(upstream.status);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
      } catch (err) {
        log.error(`hlsProxy rewrite error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Playlist rewrite error' });
        }
      }
    });
  } catch (err) {
    log.error(`hlsProxy failed: ${err.message}`);
    const status = err?.response?.status;
    if (status) {
      return res.status(status).json({ error: `Upstream returned HTTP ${status}` });
    }
    return res.status(502).json({ error: 'Proxy upstream failed' });
  }
});

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
function buildManifest(config, options = {}) {
  const { hideCatalogs = false, providers = 'all' } = config || {};
  const cinemeta = true; // Always active by default for NelloStream

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
      id: buildManifestId(config, options),
      name: buildManifestName(config, options),
      catalogs: hideCatalogs ? [] : catalogs,
    };
  }

  // cinemeta=true: use per-resource idPrefixes to avoid "metadati non trovati"
  const streamTypes    = [...new Set([...nativeTypes, 'movie'])];
  const streamPrefixes = [...new Set([...nativePrefixes, 'tt'])];

  return {
    ...manifest,
    id: buildManifestId(config, options),
    name: buildManifestName(config, options),
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
app.get([
  '/manifest.json',
  '/:config/manifest.json',
  '/install/:release/manifest.json',
  '/:config/install/:release/manifest.json',
], (req, res) => {
  const config = cfgFrom(req.params.config);
  const forceConfiguredIdentity = Boolean(req.params.config && isValidConfig(req.params.config));
  stremioJson(res, buildManifest(config, { forceConfiguredIdentity }));
});

// Catalog — handles optional /skip=N extra segment
app.get([
  '/catalog/:type/:id/:extra.json',
  '/catalog/:type/:id.json',
  '/:config/catalog/:type/:id/:extra.json',
  '/:config/catalog/:type/:id.json',
  '/install/:release/catalog/:type/:id/:extra.json',
  '/install/:release/catalog/:type/:id.json',
  '/:config/install/:release/catalog/:type/:id/:extra.json',
  '/:config/install/:release/catalog/:type/:id.json',
], async (req, res) => {
  const config = { ...cfgFrom(req.params.config), clientIp: clientIpFrom(req), addonBaseUrl: addonBaseUrlFrom(req) };
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
  '/install/:release/meta/:type/:id.json',
  '/:config/install/:release/meta/:type/:id.json',
], async (req, res) => {
  const config = { ...cfgFrom(req.params.config), clientIp: clientIpFrom(req), addonBaseUrl: addonBaseUrlFrom(req) };
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
  '/install/:release/stream/:type/:id.json',
  '/:config/install/:release/stream/:type/:id.json',
], async (req, res) => {
  const config = { ...cfgFrom(req.params.config), clientIp: clientIpFrom(req), addonBaseUrl: addonBaseUrlFrom(req) };
  try {
    const providersApi = getProvidersApi();
    if (!providersApi?.handleStream) return stremioJson(res, { streams: [] });
    const result = await providersApi.handleStream(req.params.type, req.params.id, config);
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    const webReadyCount = streams.filter((entry) => entry?.behaviorHints?.notWebReady !== true).length;
    log.info('stream response', {
      type: req.params.type,
      id: req.params.id,
      release: req.params.release || null,
      configured: Boolean(req.params.config),
      count: streams.length,
      webReady: webReadyCount,
    });
    // Stream payloads are short-lived and can contain expiring URLs or flaky provider results.
    // Never cache them at the edge, otherwise Stremio can keep seeing stale empty responses.
    stremioJson(res, result, { maxAge: 0 });
  } catch (err) {
    log.error(`streamRoute: ${err.message}`);
    stremioJson(res, { streams: [] });
  }
});

// Debug Stream Route
app.get([
  '/debug-stream/:type/:id.json',
  '/:config/debug-stream/:type/:id.json',
], async (req, res) => {
  const config = { ...cfgFrom(req.params.config), clientIp: clientIpFrom(req), addonBaseUrl: addonBaseUrlFrom(req) };
  try {
    const providersApi = getProvidersApi();
    if (!providersApi?.handleStream) return res.json({ error: 'No stream handler' });
    const result = await providersApi.handleStream(req.params.type, req.params.id, config);
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    
    // Add debug context to each stream
    const debugStreams = streams.map(s => {
      const urlStr = s.url || '';
      return {
        ...s,
        _debug: {
          hasUrl: !!s.url,
          isHttps: urlStr.startsWith('https://'),
          hasNotWebReady: s.behaviorHints?.notWebReady === true,
          hasProxyHeaders: s.behaviorHints?.proxyHeaders != null,
          hasGenericHeaders: s.headers != null,
          behaviorHintsKeys: Object.keys(s.behaviorHints || {}),
        }
      };
    });

    res.json({
      summary: {
        total: streams.length,
        webReady: streams.filter(s => s.behaviorHints?.notWebReady !== true).length,
      },
      streams: debugStreams
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: manifest.version, ts: new Date().toISOString(), providersLoaded: !!_providersApi, bootstrapError: _providersBootstrapError });
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
  const providerFilter = String(req.query.provider || '').trim().toLowerCase();
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
    enableLegacyEngine: false,
    imdbJobTimeout: Math.max(1500, timeoutMs),
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

  const selectedTests = providerFilter
    ? tests.filter((t) => t.name.toLowerCase() === providerFilter)
    : tests;

  if (providerFilter && selectedTests.length === 0) {
    return res.status(400).json({
      error: `Unknown provider filter: ${providerFilter}`,
      availableProviders: tests.map((t) => t.name),
    });
  }

  const results = [];
  for (const t of selectedTests) {
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
    providerFilter: providerFilter || null,
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

app.get('/debug/browser-proxy', requireDebugAuth, async (req, res) => {
  const { launchBrowser } = require('./src/utils/browser');
  const raw = (process.env.WEBSHARE_PROXIES || '').trim();
  const proxies = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const proxyUrl = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : null;
  const result = {
    BROWSERLESS_URL_RAW: (process.env.BROWSERLESS_URL || '').slice(0, 80),
    BROWSERLESS_URL_LEN: (process.env.BROWSERLESS_URL || '').length,
    WEBSHARE_PROXIES_COUNT: proxies.length,
    selectedProxy: proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ':***@') : null,
  };
  const t0 = Date.now();
  try {
    const browser = await launchBrowser(proxyUrl ? { proxyUrl } : {});
    result.connected = true;
    result.connectMs = Date.now() - t0;
    result.proxyAuth = !!browser._proxyAuth;
    const page = await browser.newPage();
    if (browser._proxyAuth) await page.authenticate(browser._proxyAuth);
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 15000 });
    const ipText = await page.evaluate(() => document.body.innerText).catch(() => '?');
    result.browserIp = ipText;
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

app.get('/debug/guardaserie-streams', requireDebugAuth, async (req, res) => {
  const guardaserie = require('./src/guardaserie/index');
  const imdbId = String(req.query.imdb || 'tt0460649').trim();
  const season = Number(req.query.s || 7);
  const episode = Number(req.query.e || 18);
  const t0 = Date.now();
  const logs = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const intercept = (chunk) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (/guardaserie|supervideo|browser|extractor/i.test(s)) {
      try { logs.push(JSON.parse(s.trim())); } catch { logs.push({ raw: s.trim().substring(0, 300) }); }
    }
  };
  process.stderr.write = (chunk, ...args) => { intercept(chunk); return origStderrWrite(chunk, ...args); };
  process.stdout.write = (chunk, ...args) => { intercept(chunk); return origStdoutWrite(chunk, ...args); };
  try {
    const streams = await guardaserie.getStreams(imdbId, 'series', season, episode, {});
    res.json({
      count: streams.length,
      streams: streams.map(s => ({
        name: s.name,
        title: s.title,
        url: s.url ? s.url.substring(0, 150) : null,
        quality: s.quality,
        isExternal: s.isExternal,
        behaviorHints: s.behaviorHints,
      })),
      ms: Date.now() - t0,
      logs: logs.map(l => l.raw ? l : { ts: l.ts, msg: l.message, tag: l.tag }).slice(-60),
    });
  } catch (err) {
    res.json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5), ms: Date.now() - t0, logs: logs.slice(-60) });
  } finally {
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
  }
});

app.get('/debug/browser-sv', requireDebugAuth, async (req, res) => {
  const { launchBrowser } = require('./src/utils/browser');
  const raw = (process.env.WEBSHARE_PROXIES || '').trim();
  const proxies = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const proxyUrl = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : null;
  const embedUrl = String(req.query.url || 'https://supervideo.tv/e/914t0hxfcmcj').trim();
  const t0 = Date.now();
  const result = { proxy: proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ':***@') : null };
  let browser;
  try {
    browser = await launchBrowser(proxyUrl ? { proxyUrl } : {});
    result.connected = true;
    result.connectMs = Date.now() - t0;
    const page = await browser.newPage();
    if (browser._proxyAuth) await page.authenticate(browser._proxyAuth);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    let manifestUrl = null;
    page.on('request', (r) => { if (!manifestUrl && /master\.m3u8/i.test(r.url())) manifestUrl = r.url(); });
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    result.gotoMs = Date.now() - t0;
    result.finalUrl = page.url();
    result.manifestUrl = manifestUrl;
    const html = await page.content().catch(() => '');
    result.htmlLen = html.length;
    result.hasJwplayer = /jwplayer/i.test(html);
    result.hasCF = /cloudflare|just a moment/i.test(html);
    result.title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null;
    await page.close().catch(() => {});
    result.totalMs = Date.now() - t0;
    res.json(result);
  } catch (err) {
    result.error = err.message;
    result.ms = Date.now() - t0;
    res.json(result);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.get('/debug/supervideo-extract', requireDebugAuth, async (req, res) => {
  const { extractSuperVideo } = require('./src/extractors/supervideo');
  const embedUrl = String(req.query.url || 'https://supervideo.tv/e/fipur2tfqif7').trim();
  const t0 = Date.now();
  const logs = [];
  // Capture structured logger output (uses process.stderr.write in prod)
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk, ...args) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (s.includes('supervideo') || s.includes('browser')) {
      try { logs.push(JSON.parse(s.trim())); } catch { logs.push({ raw: s.trim().substring(0, 200) }); }
    }
    return origStderrWrite(chunk, ...args);
  };
  process.stdout.write = (chunk, ...args) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (s.includes('supervideo') || s.includes('browser')) {
      try { logs.push(JSON.parse(s.trim())); } catch { logs.push({ raw: s.trim().substring(0, 200) }); }
    }
    return origStdoutWrite(chunk, ...args);
  };
  try {
    const result = await extractSuperVideo(embedUrl, { refererBase: 'https://guardaserie.ceo/' });
    res.json({
      url: result?.url,
      hasProxy: !!result?.proxyUrl,
      proxy: result?.proxyUrl ? result.proxyUrl.replace(/:[^:@]+@/, ':***@') : null,
      isExternal: !!result?.isExternal,
      headers: result?.headers ? Object.keys(result.headers) : null,
      ms: Date.now() - t0,
      logs: logs.map(l => l.raw ? l : { ts: l.ts, msg: l.message, tag: l.tag, ...Object.fromEntries(Object.entries(l).filter(([k]) => !['ts','level','tag','message'].includes(k))) }).slice(-40),
    });
  } catch (err) {
    res.json({ error: err.message, ms: Date.now() - t0, logs: logs.slice(-40) });
  } finally {
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
  }
});

app.get('/debug/guardaserie-trace', requireDebugAuth, async (req, res) => {
  const trace = [];
  const t0 = Date.now();
  const ts = () => Date.now() - t0;
  try {
    const { getProviderUrl } = require('./src/provider_urls');
    const baseUrl = getProviderUrl('guardaserie');
    trace.push({ step: 'baseUrl', value: baseUrl, ms: ts() });

    const imdbId = String(req.query.imdb || 'tt0460649').trim();
    const season = Number(req.query.s || 7);
    const episode = Number(req.query.e || 18);
    trace.push({ step: 'params', imdbId, season, episode, ms: ts() });

    // Step 1: DLE search by IMDB ID (same as getStreams)
    const params = new URLSearchParams();
    params.append('do', 'search');
    params.append('subaction', 'search');
    params.append('story', imdbId);
    const searchUrl = `${baseUrl}/index.php?${params.toString()}`;
    trace.push({ step: 'searchUrl', url: searchUrl, ms: ts() });

    const searchResp = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': baseUrl,
      },
      signal: AbortSignal.timeout(15000),
    });
    const searchHtml = await searchResp.text();
    const hasMlnh2 = /mlnh-2/.test(searchHtml);
    const hasCF = /cloudflare|just a moment/i.test(searchHtml);
    const resultRegex = /<div class="mlnh-2">\s*<h2>\s*<a href="([^"]+)" title="([^"]+)">/i;
    const match = resultRegex.exec(searchHtml);
    trace.push({
      step: 'dleSearch',
      status: searchResp.status,
      htmlLen: searchHtml.length,
      hasMlnh2,
      hasCF,
      matchFound: !!match,
      matchUrl: match ? match[1] : null,
      matchTitle: match ? match[2] : null,
      titleTag: (searchHtml.match(/<title>([^<]*)<\/title>/i) || [])[1] || null,
      preview: searchHtml.substring(0, 300),
      ms: ts(),
    });

    // Step 2: If match found, fetch the show page and look for episode links
    if (match) {
      let showPageUrl = match[1];
      if (showPageUrl.startsWith('/')) showPageUrl = `${baseUrl}${showPageUrl}`;
      const pageResp = await fetch(showPageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Referer: baseUrl },
        signal: AbortSignal.timeout(10000),
      });
      const pageHtml = await pageResp.text();
      // Look for episode links
      const dataLinks = [...pageHtml.matchAll(/data-link=["']([^"']+)["']/g)].map(m => m[1]);
      const svLinks = dataLinks.filter(l => /supervideo/i.test(l));

      // Test episode link extraction
      const season = Number(req.query.s || 7);
      const episode = Number(req.query.e || 18);
      const episodeIds = [
        `serie-${season}_${episode}`,
        `serie-${season}_${String(episode).padStart(2, '0')}`,
      ];
      const hasEpId = episodeIds.map(id => pageHtml.includes(`id="${id}"`));
      const dataNumStr = `${season}x${episode}`;
      const dataNumPad = `${season}x${String(episode).padStart(2, '0')}`;
      const hasDataNum = pageHtml.includes(`data-num="${dataNumStr}"`) || pageHtml.includes(`data-num="${dataNumPad}"`);
      // Try actual extraction
      const { getStreams } = require('./src/guardaserie/index');
      let epLinks = [];
      try {
        const collectEpisodeLinks = require('./src/guardaserie/index').collectEpisodeLinks;
        // Fall back: extract inline
        for (const episodeId of episodeIds) {
          const blockRegex = new RegExp(`<li[^>]*>[\\s\\S]*?<a[^>]+id="${episodeId}"[\\s\\S]*?<\\/li>`, "i");
          const blockMatch = pageHtml.match(blockRegex);
          if (blockMatch) {
            for (const m of blockMatch[0].matchAll(/data-link="([^"]+)"/g)) {
              epLinks.push(m[1]);
            }
            break;
          }
        }
        if (!epLinks.length) {
          const episodeRegex = new RegExp(`data-num="${dataNumStr}"|data-num="${dataNumPad}"`, "i");
          const epMatch = episodeRegex.exec(pageHtml);
          if (epMatch) {
            const searchFrom = epMatch.index;
            const mirrorsStart = pageHtml.indexOf('<div class="mirrors">', searchFrom);
            if (mirrorsStart !== -1) {
              const mirrorsEnd = pageHtml.indexOf("</div>", mirrorsStart);
              if (mirrorsEnd !== -1) {
                const mirHtml = pageHtml.substring(mirrorsStart, mirrorsEnd);
                for (const m of mirHtml.matchAll(/data-link="([^"]+)"/g)) {
                  epLinks.push(m[1]);
                }
              }
            }
          }
        }
      } catch (e) {}

      trace.push({
        step: 'showPage',
        url: showPageUrl,
        status: pageResp.status,
        htmlLen: pageHtml.length,
        dataLinkCount: dataLinks.length,
        superVideoLinks: svLinks.length,
        svSample: svLinks.slice(0, 3),
        episodeIds,
        hasEpId,
        hasDataNum,
        epLinks: epLinks.slice(0, 5),
        ms: ts(),
      });
    }

    res.json({ trace, ms: ts() });
  } catch (err) {
    trace.push({ step: 'error', message: err.message, ms: ts() });
    res.json({ trace, ms: ts() });
  }
});

app.get('/debug/http-fetch', requireDebugAuth, async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  const referer = String(req.query.referer || '').trim();
  const origin = String(req.query.origin || '').trim();
  const userAgent = String(req.query.ua || '').trim() || 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const timeoutMs = Math.max(1000, Number.parseInt(String(req.query.timeout || '15000'), 10) || 15000);

  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'Use a full http(s) URL in ?url=' });
  }

  const headers = { 'User-Agent': userAgent };
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;

  const timeoutConfig = createTimeoutSignal(timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(targetUrl, {
      headers,
      redirect: 'follow',
      signal: timeoutConfig.signal,
    });
    const body = await response.text();
    const dataLinkMatches = [...body.matchAll(/data-link=["']([^"']+)["']/g)].map((match) => match[1]);
    const iframeMatches = [...body.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1]);

    return res.json({
      input: {
        url: targetUrl,
        referer: referer || null,
        origin: origin || null,
        userAgent,
        timeoutMs,
      },
      status: response.status,
      ok: response.ok,
      finalUrl: response.url,
      contentType: response.headers.get('content-type') || null,
      ms: Date.now() - startedAt,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 1200),
      dataLinkCount: dataLinkMatches.length,
      dataLinkSample: dataLinkMatches.slice(0, 10),
      iframeCount: iframeMatches.length,
      iframeSample: iframeMatches.slice(0, 10),
      hasCloudflareBlock: /attention required|just a moment|cf-wrapper|cloudflare/i.test(body),
    });
  } catch (err) {
    return res.status(500).json({
      input: {
        url: targetUrl,
        referer: referer || null,
        origin: origin || null,
        userAgent,
        timeoutMs,
      },
      error: String(err?.message || err),
      ms: Date.now() - startedAt,
    });
  } finally {
    if (typeof timeoutConfig.cleanup === 'function') timeoutConfig.cleanup();
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

// ─── Eurostreaming network diagnostics ───────────────────────────────────────

app.get('/debug/eurostreaming', requireDebugAuth, async (req, res) => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  const out = {};

  // Test any URL
  const testUrl = async (label, url, opts = {}) => {
    const t = Date.now();
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' },
        redirect: opts.nofollow ? 'manual' : 'follow',
        signal: AbortSignal.timeout(opts.timeout || 7000),
      });
      const body = await r.text();
      out[label] = {
        status: r.status,
        ok: r.ok,
        blocked: body.includes('Just a moment') || body.includes('Checking your browser'),
        len: body.length,
        location: r.headers.get('location'),
        ms: Date.now() - t,
      };
    } catch (e) {
      out[label] = { error: e.message, ms: Date.now() - t };
    }
  };

  // CF Worker helper
  const cfWorkerUrl = (process.env.CF_WORKER_URL || '').trim();
  const cfWorkerAuth = (process.env.CF_WORKER_AUTH || '').trim();
  const testViaCF = async (label, targetUrl) => {
    if (!cfWorkerUrl) { out[label] = { error: 'CF_WORKER_URL not set' }; return; }
    const t = Date.now();
    try {
      const wUrl = new URL(cfWorkerUrl.replace(/\/$/, ''));
      wUrl.searchParams.set('url', targetUrl);
      const headers = { 'User-Agent': UA };
      if (cfWorkerAuth) headers['x-worker-auth'] = cfWorkerAuth;
      const r = await fetch(wUrl.toString(), { headers, signal: AbortSignal.timeout(12000) });
      const body = await r.text();
      out[label] = { status: r.status, ok: r.ok, blocked: body.includes('Just a moment'), len: body.length, bodyPreview: body.substring(0, 150), ms: Date.now() - t };
    } catch (e) { out[label] = { error: e.message, ms: Date.now() - t }; }
  };

  // Run all tests in parallel
  await Promise.all([
    testUrl('eurostream_wp', 'https://eurostream.ing/wp-json/wp/v2/search?search=Scrubs&_fields=id,subtype&per_page=2'),
    testUrl('clickaCC', 'https://clicka.cc/delta/039rfckolqwa', { nofollow: true }),
    testUrl('safego', 'https://safego.cc/safe.php?url=YmZ2RlNqSHMwckM0YU1XdVpoQWMxSEJQeEEwM21WcGpvRkIrYWJvZ09kTllMLzBxN0wrU3U1NUVoWGVXblQ0Q0FrbTFJOGhlTWFmVGdyeThGSkR3UVE9PQ==', { nofollow: true }),
    testUrl('deltabit', 'https://deltabit.co/'),
    testUrl('guardaserie', 'https://guardaserietv.autos/'),
    testUrl('guardoserie', 'https://guardoserie.surf/'),
    testUrl('mostraguarda', 'https://mostraguarda.stream/'),
    testUrl('guardaflix', 'https://guardaplay.space/'),
    testUrl('cb01', 'https://cb01uno.digital/'),
    testViaCF('eurostream_viaCF', 'https://eurostream.ing/wp-json/wp/v2/search?search=Scrubs&_fields=id,subtype&per_page=2'),
    testViaCF('clickaCC_viaCF', 'https://clicka.cc/delta/039rfckolqwa'),
    testViaCF('safego_viaCF', 'https://safego.cc/safe.php?url=YmZ2RlNqSHMwckM0YU1XdVpoQWMxSEJQeEEwM21WcGpvRkIrYWJvZ09kTllMLzBxN0wrU3U1NUVoWGVXblQ0Q0FrbTFJOGhlTWFmVGdyeThGSkR3UVE9PQ=='),
  ]);

  res.json(out);
});

// ─── Landing Page ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(addonBaseUrlFrom(req), null, null, _serverStatus()));
});

  app.get('/dashboard', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const landingPath = path.join(__dirname, 'web/landing/index.html');
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
  res.send(buildPage(addonBaseUrlFrom(req), cfg, req.params.config, _serverStatus()));
});

// Stremio "Configure" button opens: transportUrl.replace('/manifest.json','') + '/configure'
// (some Stremio versions append /configure explicitly — handle both)
app.get([
  '/configure',
  '/:config/configure',
  '/install/:release',
  '/install/:release/configure',
  '/:config/install/:release',
  '/:config/install/:release/configure',
], (req, res, next) => {
  const raw = req.params.config;
  if (raw && !isValidConfig(raw)) return next();
  const cfg = raw ? decodeConfig(raw) : null;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(addonBaseUrlFrom(req), cfg, raw || null, _serverStatus()));
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

function buildPage(host, config) {
  const v = manifest.version;
  const f = config || {};
  const installReleaseTag = currentInstallReleaseTag();
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
      --primary: #f28c28; /* Arancione caldo */
      --secondary: #d4a373; /* Beige/sabbia */
      --bg: #2d2621; /* Marrone scuro/grigio caldo */
      --bg-card: rgba(255, 255, 255, 0.05); /* Leggermente più visibile sul bg scuro */
      --glass-border: rgba(255, 255, 255, 0.1);
      --text: #fefae0; /* Bianco caldo/avorio */
      --text-muted: #d4a373; /* Colore secondario per i testi meno evidenti */
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      background-image:
        radial-gradient(circle at 15% 50%, rgba(242, 140, 40, 0.12), transparent 25%),
        radial-gradient(circle at 85% 30%, rgba(212, 163, 115, 0.1), transparent 25%);
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
      background: rgba(242, 140, 40, 0.15); border: 1px solid rgba(242, 140, 40, 0.3);
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
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(242, 140, 40, 0.15); }
    .hint { font-size: 0.75rem; color: #a4968c; margin-top: 8px; line-height: 1.4; }
    .checks { display: flex; flex-direction: column; gap: 12px; margin-top: 5px; }
    .check-label {
      display: flex; align-items: center; gap: 12px; font-size: 0.9rem; color: #fefae0; cursor: pointer;
      background: #18191c; padding: 12px 16px; border-radius: 10px; border: 1px solid #3c3028; transition: 0.2s;
    }
    .check-label:hover { border-color: #d4a373; }
    .check-label input { width: 18px; height: 18px; accent-color: var(--primary); }
    .btn-submit {
      width: 100%; padding: 16px; margin-top: 10px;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: #000; border: none; border-radius: 12px; font-family: 'Poppins', sans-serif; font-size: 1.1rem;
      font-weight: 700; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 8px 20px rgba(242, 140, 40, 0.3);
    }
    .btn-submit:hover { transform: translateY(-2px); box-shadow: 0 12px 25px rgba(242, 140, 40, 0.4); }
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
    .btn-stremio { background: linear-gradient(135deg, var(--secondary), #f28c28); color: #000; }
    .btn-stremio:hover { opacity: 0.9; }
    .btn-copy { background: #3c3028; color: var(--text); border: 1px solid #d4a373; }
    .toast { display: none; text-align: center; color: var(--secondary); font-size: 0.85rem; margin-top: 12px; font-weight: 500; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Nello Stream <span class="badge">v${v}</span></h1>
      <p class="lead">Il motore di aggregazione definitivo ispirato a Nello 🐶 per contenuti in streaming su Stremio.</p>
    </div>

    <form id="cfgForm">
      <div class="card">
        <div class="card-title">⚡ Reti e Bypass</div>
        <div class="input-grp">
          <label>URL Proxy MediaFlow (Opzionale)</label>
          <input type="url" id="m_url" placeholder="https://nome-mediaflow.com" value="${esc(f.mfpUrl)}"/>
          <div class="hint">Opzionale: il proxy interno rende web-ready i flussi HLS/headered piu comuni; MediaFlow resta utile per i casi che richiedono un proxy esterno.</div>
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
            <input type="checkbox" id="h_cat" ${f.hideCatalogs ? 'checked' : ''}/> 
            Nascondi cloni delle sezioni (Mostra solo le principali Cinemeta)
          </label>
        </div>
        <div class="hint">La compatibilità con IMDb/Cinemeta è sempre attiva di default. Il link generato usa un path di release versionato (${installReleaseTag}) per forzare il refresh del manifest in Stremio.</div>
      </div>

      <button type="submit" class="btn-submit">Ottieni Addon Nello Stream</button>
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

        var c = {
            px: pUrl,
            mfp: mUrl,
            pv: 'a',
            hc: hCat ? 1 : 0,
            cm: 1
        };

        // Base64 configuration string
        var enc = b64e(JSON.stringify(c));
        var base = window.location.origin;
        var installPath = '/install/${installReleaseTag}/manifest.json';
        var finalUrl = enc ? (base + '/' + enc + installPath) : (base + installPath);
        
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
