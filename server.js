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
const { handleCatalog, handleMeta, handleStream } = require('./src/providers/index');
const { decodeConfig, isValidConfig, DEFAULT_CONFIG } = require('./src/utils/config');
const { createLogger } = require('./src/utils/logger');

const log = createLogger('server');

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

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

/** Stremio JSON response with optional Cache-Control */
function stremioJson(res, data, { maxAge = 0 } = {}) {
  if (maxAge > 0) {
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 3}`);
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
 * - cinemeta: adds "tt" idPrefix + "series"/"movie" types so Cinemeta IDs work
 */
function buildManifest(config) {
  const { hideCatalogs = false, providers = 'all', cinemeta = false } = config || {};

  // Filter catalogs by provider setting
  let catalogs = manifest.catalogs || [];
  if (providers === 'kisskh') catalogs = catalogs.filter(c => c.id.startsWith('kisskh'));
  else if (providers === 'rama') catalogs = catalogs.filter(c => c.id.startsWith('rama'));
  else if (providers === 'drammatica') catalogs = catalogs.filter(c => c.id.startsWith('drammatica'));
  else if (providers === 'guardaserie') catalogs = catalogs.filter(c => c.id.startsWith('guardaserie'));

  // Extra types / prefixes for Cinemeta support
  const extraTypes    = cinemeta ? ['movie'] : [];
  const extraPrefixes = cinemeta ? ['tt'] : [];

  return {
    ...manifest,
    catalogs: hideCatalogs ? [] : catalogs,
    types:      [...new Set([...(manifest.types || []), ...extraTypes])],
    idPrefixes: [...new Set([...(manifest.idPrefixes || []), ...extraPrefixes])],
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
  const config = cfgFrom(req.params.config);
  const extra  = parseExtra(req.params.extra);
  try {
    const result = await handleCatalog(req.params.type, req.params.id, extra, config);
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
  const config = cfgFrom(req.params.config);
  try {
    stremioJson(res, await handleMeta(req.params.type, req.params.id, config), { maxAge: 1800 });
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
  const config = cfgFrom(req.params.config);
  try {
    const result = await handleStream(req.params.type, req.params.id, config);
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

// ─── Landing Page ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(req.protocol + '://' + req.get('host'), null, null, _serverStatus()));
});

// Config-prefixed landing — shows pre-filled form with existing config
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

function buildPage(host, prefill, existingCfgStr, serverStatus) {
  const f = prefill || {};
  const { proxyOk = false, blOk = false, fsOk = false } = serverStatus || {};
  const v = manifest.version;
  const addonHost = host.replace(/^https?:\/\//, '');
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${manifest.name} v${v} — Configurazione</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--accent:#7c3aed;--accent-light:#a78bfa;--bg:#0f0f13;--card:#17171e;--border:#2a2a3a;--text:#e0e0e0;--muted:#6b7280;--sub:#9ca3af}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,Arial,sans-serif;min-height:100vh;padding:28px 16px}
.wrap{max-width:660px;margin:0 auto}
h1{font-size:1.85rem;color:var(--accent-light);margin-bottom:5px;letter-spacing:-.4px}
.vtag{background:#1e1b4b;color:var(--accent-light);border-radius:20px;padding:2px 10px;font-size:.73rem;display:inline-block;margin-bottom:16px}
.lead{color:var(--sub);line-height:1.6;margin-bottom:26px;font-size:.9rem}
.providers{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:22px}
.ptag{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:5px 14px;font-size:.82rem;color:var(--sub)}
.ptag b{color:var(--accent-light)}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:18px}
.card-title{font-size:.95rem;font-weight:600;color:#c4b5fd;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.badge{background:#3b0764;color:#d8b4fe;border-radius:10px;padding:1px 8px;font-size:.7rem;font-weight:400}
label{display:block;font-size:.81rem;color:var(--sub);margin:12px 0 4px}
label:first-of-type{margin-top:0}
input{width:100%;background:var(--bg);border:1px solid #374151;border-radius:7px;padding:9px 12px;color:#e5e7eb;font-size:.9rem;outline:none;transition:border .15s}
input:focus{border-color:var(--accent)}
input::placeholder{color:#4b5563}
.hint{font-size:.74rem;color:var(--muted);margin-top:4px;line-height:1.5}
.hint a,.hint code{color:var(--accent-light);text-decoration:none}
.hint a:hover{text-decoration:underline}
.hint code{background:#1c1c26;padding:1px 5px;border-radius:3px}
.gen-btn{width:100%;padding:13px;background:linear-gradient(135deg,var(--accent),#5b21b6);color:#fff;border:none;border-radius:9px;font-size:.975rem;font-weight:700;cursor:pointer;margin-bottom:8px;transition:opacity .15s,transform .1s}
.gen-btn:hover{opacity:.9}
.gen-btn:active{transform:scale(.98)}
.result{display:none;background:#0a0a10;border:1px solid #4c1d95;border-radius:10px;padding:16px;margin-top:16px}
.result.show{display:block}
.rlabel{font-size:.75rem;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.udisp{background:var(--bg);border:1px solid #312e81;border-radius:7px;padding:9px 12px;font-size:.79rem;color:var(--accent-light);word-break:break-all;font-family:monospace;line-height:1.4;margin-bottom:12px}
.acts{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:9px 18px;border-radius:7px;font-size:.85rem;font-weight:600;cursor:pointer;border:none;text-decoration:none;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn-cp{background:#1e1b4b;color:var(--accent-light);border:1px solid #4c1d95}
.btn-st{background:linear-gradient(135deg,#8b5cf6,var(--accent));color:#fff}
.btn-wb{background:#1f2937;color:#e5e7eb;border:1px solid #374151}
.ok-msg{color:#34d399;font-size:.79rem;margin-top:8px;display:none}
.def-link{text-align:center;margin-top:12px}
.def-link a{color:var(--muted);font-size:.78rem;text-decoration:underline}
.radio-group{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.ropt{display:flex;align-items:center;gap:6px;background:#1a1a25;border:1px solid #2d2d42;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:.84rem;color:var(--sub);transition:border-color .15s}
.ropt:has(input:checked){border-color:var(--accent);color:var(--accent-light);background:#1e1b4b}
.ropt input{accent-color:var(--accent);cursor:pointer}
.chk-row{display:flex;align-items:flex-start;gap:10px;margin-top:12px;cursor:pointer}
.chk-row input[type=checkbox]{accent-color:var(--accent);width:16px;height:16px;flex-shrink:0;margin-top:2px;cursor:pointer}
.chk-label{font-size:.84rem;color:var(--sub);line-height:1.5}
</style>
</head>
<body>
<div class="wrap">

<h1>🎬 ${manifest.name}</h1>
<span class="vtag">v${v}</span>
<p class="lead">${manifest.description}<br/>
Configura il proxy per sbloccare i contenuti da Vercel.</p>

<div class="providers">
  <div class="ptag">🇰🇷 <b>KissKH</b> Asian Drama</div>
  <div class="ptag">🎞 <b>Rama</b> Korean Fansub</div>
  <div class="ptag">🇰🇷 <b>Drammatica</b> Sub ITA</div>
  <div class="ptag">🇰🇷 <b>Guardaserie</b> Sub ITA</div>
</div>

<div class="card" style="border-color:${proxyOk?'#34d399':'#f87171'}">
  <div class="card-title">⚙️ Server Status</div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:.82rem">
    <span style="color:${proxyOk?'#34d399':'#f87171'}">${proxyOk?'✅':'❌'} HTTP Proxy ${proxyOk?'configurato':'non configurato'}</span>
    <span style="color:${blOk?'#34d399':'#f87171'}">${blOk?'✅':'❌'} Browserless ${blOk?'configurato':'non configurato'}</span>
    <span style="color:${fsOk?'#34d399':'#f59e0b'}">${fsOk?'✅':'⚠️'} FlareSolverr ${fsOk?'configurato':'non configurato'}</span>
  </div>
  ${!fsOk ? `<p style="font-size:.78rem;color:#f59e0b;margin-top:10px;line-height:1.5">
    ⚠️ <b>KissKH streams richiedono FlareSolverr per bypassare Cloudflare.</b><br/>
    Deploya <a href="https://github.com/FlareSolverr/FlareSolverr" target="_blank" style="color:var(--accent-light)">FlareSolverr</a>
    su Koyeb (free tier, immagine Docker <code style="background:#1c1c26;padding:2px 6px;border-radius:3px">ghcr.io/flaresolverr/flaresolverr:latest</code>, porta 8191),
    poi imposta su Vercel:<br/>
    <code style="background:#1c1c26;padding:2px 6px;border-radius:3px">FLARESOLVERR_URL=https://tuo-servizio.koyeb.app</code>
  </p>` : ''}
</div>

<div class="card">
  <div class="card-title">📡 MediaFlow Proxy <span class="badge">Per i flussi video</span></div>
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:14px">
    Bypassa blocchi IP sullo streaming. Self-hosted su
    <a href="https://github.com/mhdzumair/mediaflow-proxy" target="_blank" style="color:var(--accent-light)">mediaflow-proxy</a>.
    I flussi HLS/DASH vengono rerouted attraverso il tuo server MFP.
  </p>
  <label for="mfpUrl">URL del tuo MediaFlow Proxy</label>
  <input id="mfpUrl" type="url" placeholder="https://mfp.tuodominio.com" value="${esc(f.mfpUrl)}"/>
  <div class="hint">L'URL dove hai deployato MediaFlow Proxy. Lascia vuoto se non lo usi.</div>

  <label for="mfpKey">API Key <span style="font-weight:400;color:var(--muted)">(opzionale)</span></label>
  <input id="mfpKey" type="password" placeholder="API_PASSWORD di MFP" value="${esc(f.mfpKey)}"/>
  <div class="hint">Corrisponde alla variabile <code>API_PASSWORD</code> nella configurazione di MFP.</div>
</div>

<div class="card">
  <div class="card-title">🔒 HTTP Proxy <span class="badge">Per catalog e metadata</span></div>
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:14px">
    Vercel ha IP datacenter bloccati da Cloudflare. Un proxy con IP residenziale italiano
    permette di caricare i cataloghi e le schede dei drama.
  </p>
  <label for="proxyUrl">HTTP / SOCKS5 Proxy URL</label>
  <input id="proxyUrl" type="text" placeholder="http://user:pass@host:port" autocomplete="off" spellcheck="false" value="${esc(f.proxyUrl)}"/>
  <div class="hint">
    Formati: <code>http://user:pass@host:port</code> · <code>socks5://user:pass@host:port</code><br/>
    Piano free residenziale: <a href="https://proxy.webshare.io" target="_blank">WebShare.io</a>
    — scegli exit node Italia per sottotitoli italiani su KissKH.
  </div>
</div>

<div class="card">
  <div class="card-title">🎥 TMDB <span class="badge">Metadata arricchito</span></div>
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:14px">
    Arricchisce poster, background, cast, generi e valutazione dei drama di Rama, Drammatica e Guardaserie
    usando The Movie Database. Gratuito &mdash;
    <a href="https://www.themoviedb.org/settings/api" target="_blank" style="color:var(--accent-light)">genera la tua API key</a>.
  </p>
  <label for="tmdbKey">TMDB API Key (v3 auth)</label>
  <input id="tmdbKey" type="password" placeholder="Incolla qui la tua TMDB v3 API key" autocomplete="off" spellcheck="false" value="${esc(f.tmdbKey)}"/>
  <div class="hint">Lascia vuoto per disattivare. Con la chiave attiva, poster e schede dei drama avranno immagini HD e dati completi.</div>
</div>

<div class="card">
  <div class="card-title">⭐ RPDB <span class="badge">Poster con rating</span></div>
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:14px">
    Sostituisce i poster standard con versioni che mostrano il rating IMDb in sovrimpressione.
    Richiede TMDB attivo (per ricavare l&rsquo;IMDB ID). <a href="https://ratingposterdb.com" target="_blank" style="color:var(--accent-light)">ratingposterdb.com</a>
  </p>
  <label for="rpdbKey">RPDB API Key</label>
  <input id="rpdbKey" type="password" placeholder="Incolla qui la tua RPDB API key" autocomplete="off" spellcheck="false" value="${esc(f.rpdbKey)}"/>
  <div class="hint">Funziona solo se TMDB è configurato. Lascia vuoto per disattivare.</div>
</div>

<div class="card">

  <label style="margin-top:0">Provider attivi</label>
  <div class="radio-group" id="providerGroup">
    <label class="ropt"><input type="radio" name="pv" value="all" ${(!f.providers || f.providers === 'all') ? 'checked' : ''}/> 🌐 Tutti</label>
    <label class="ropt"><input type="radio" name="pv" value="kisskh" ${f.providers === 'kisskh' ? 'checked' : ''}/> <b>KissKH</b></label>
    <label class="ropt"><input type="radio" name="pv" value="rama" ${f.providers === 'rama' ? 'checked' : ''}/> <b>Rama</b></label>
    <label class="ropt"><input type="radio" name="pv" value="drammatica" ${f.providers === 'drammatica' ? 'checked' : ''}/> <b>Drammatica</b></label>
    <label class="ropt"><input type="radio" name="pv" value="guardaserie" ${f.providers === 'guardaserie' ? 'checked' : ''}/> <b>Guardaserie</b></label>
  </div>
  <div class="hint">Scegli da quale sorgente vuoi i flussi streaming.</div>

  <label class="chk-row" for="hideCatalogs">
    <input type="checkbox" id="hideCatalogs" ${f.hideCatalogs ? 'checked' : ''}/>
    <span class="chk-label"><b>Nascondi cataloghi dalla home di Stremio</b><br/>
      Rimuove le sezioni "Asian Drama" e "Korean Drama" dalla schermata principale.
      Utile se usi Cinemeta come catalogo principale.</span>
  </label>

  <label class="chk-row" for="cinemetaChk">
    <input type="checkbox" id="cinemetaChk" ${f.cinemeta ? 'checked' : ''}/>
    <span class="chk-label"><b>Abilita stream da Cinemeta / IMDB</b><br/>
      Il nostro addon risponderà anche ai titoli trovati tramite Cinemeta.
      Cerca il drama su Cinemeta → i flussi arriveranno da KissKH/Rama automaticamente.</span>
  </label>
</div>

<button class="gen-btn" onclick="generate()">✨ Genera URL personalizzato</button>

<div class="result" id="result">
  <div class="rlabel">📋 Il tuo URL di installazione</div>
  <div class="udisp" id="udisp"></div>
  <div class="acts" id="acts"></div>
  <div class="ok-msg" id="okMsg">✅ Copiato!</div>
</div>

<div class="def-link">
  <a href="stremio://${addonHost}/manifest.json">
    Installa senza configurazione (solo per uso locale/VPS)
  </a>
</div>

</div>
<script>
(function(){
  function b64url(s){
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  }
  function encCfg(c){
    var o={};
    if(c.mfpUrl)        o.mfp=c.mfpUrl;
    if(c.mfpKey)        o.mfpk=c.mfpKey;
    if(c.proxyUrl)      o.px=c.proxyUrl;
    if(c.hideCatalogs)  o.hc=1;
    var pvMap={kisskh:'k',rama:'r',drammatica:'d',guardaserie:'g'};
    if(c.providers && c.providers!=='all') o.pv=pvMap[c.providers]||c.providers;
    if(c.cinemeta)      o.cm=1;
    if(c.tmdbKey)       o.tm=c.tmdbKey;
    if(c.rpdbKey)       o.rp=c.rpdbKey;
    return b64url(JSON.stringify(o));
  }
  window.generate=function(){
    var pvEl=document.querySelector('input[name="pv"]:checked');
    var cfg={
      mfpUrl: document.getElementById('mfpUrl').value.trim(),
      mfpKey: document.getElementById('mfpKey').value.trim(),
      proxyUrl: document.getElementById('proxyUrl').value.trim(),
      hideCatalogs: document.getElementById('hideCatalogs').checked,
      providers: pvEl ? pvEl.value : 'all',
      cinemeta: document.getElementById('cinemetaChk').checked,
      tmdbKey: document.getElementById('tmdbKey').value.trim(),
      rpdbKey: document.getElementById('rpdbKey').value.trim()
    };
    if(!cfg.mfpUrl&&!cfg.proxyUrl&&!cfg.hideCatalogs&&cfg.providers==='all'&&!cfg.cinemeta&&!cfg.tmdbKey&&!cfg.rpdbKey){
      alert('Configura almeno una opzione (Proxy, Provider, o Nascondi cataloghi).');
      return;
    }
    var enc=encCfg(cfg);
    var base=location.origin;
    var url=base+'/'+enc+'/manifest.json';
    var stremio='stremio://${addonHost}/'+enc+'/manifest.json';
    document.getElementById('udisp').textContent=url;
    document.getElementById('acts').innerHTML=
      '<button id="_actCp" class="btn btn-cp">📋 Copia URL</button>'
      +'<a class="btn btn-st" href="'+stremio+'">▶ Installa su Stremio</a>'
      +'<a class="btn btn-wb" href="https://web.stremio.com/#/addons?addon='
        +encodeURIComponent(url)+'" target="_blank">🌐 Web</a>';
    document.getElementById('_actCp').onclick=function(){ cp(url); };
    var r=document.getElementById('result');
    r.classList.add('show');
    r.scrollIntoView({behavior:'smooth',block:'nearest'});
  };
  window.cp=function(url){
    navigator.clipboard.writeText(url).then(function(){
      var m=document.getElementById('okMsg');
      m.style.display='block';
      setTimeout(function(){m.style.display='none';},2000);
    });
  };
  ${existingCfgStr ? "document.addEventListener('DOMContentLoaded',function(){generate();});" : ''}
})();
</script>
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
