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

/** Stremio JSON response */
function stremioJson(res, data) {
  res.setHeader('Content-Type', 'application/json');
  res.json(data);
}

// ─── Stremio Protocol Routes ─────────────────────────────────────────────────
// Both default (no config prefix) and /:config prefixed variants.

// Manifest
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  stremioJson(res, manifest);
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
    stremioJson(res, await handleCatalog(req.params.type, req.params.id, extra, config));
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
    stremioJson(res, await handleMeta(req.params.type, req.params.id, config));
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
    stremioJson(res, await handleStream(req.params.type, req.params.id, config));
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

app.get('/debug/providers', async (req, res) => {
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

// ─── Landing Page ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(req.protocol + '://' + req.get('host')));
});

// Config-prefixed landing — shows pre-filled form with existing config
app.get('/:config', (req, res, next) => {
  if (!isValidConfig(req.params.config)) return next();
  const cfg = decodeConfig(req.params.config);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPage(req.protocol + '://' + req.get('host'), cfg, req.params.config));
});

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

function buildPage(host, prefill, existingCfgStr) {
  const f = prefill || {};
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
    if(c.mfpUrl) o.mfp=c.mfpUrl;
    if(c.mfpKey) o.mfpk=c.mfpKey;
    if(c.proxyUrl) o.px=c.proxyUrl;
    return b64url(JSON.stringify(o));
  }
  window.generate=function(){
    var cfg={
      mfpUrl: document.getElementById('mfpUrl').value.trim(),
      mfpKey: document.getElementById('mfpKey').value.trim(),
      proxyUrl: document.getElementById('proxyUrl').value.trim()
    };
    if(!cfg.mfpUrl&&!cfg.proxyUrl){
      alert('Inserisci almeno MediaFlow Proxy URL oppure HTTP Proxy URL.');
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
