/**
 * cfworker.js — Cloudflare Worker proxy for kisskh.co API
 *
 * Bypasses Cloudflare Bot Management on kisskh.co by proxying requests
 * from inside Cloudflare's own network (Workers bypass CF protection on
 * co-hosted sites because the outbound request carries Cloudflare AS
 * headers and is trusted at the network layer).
 *
 * ── Deploy ─────────────────────────────────────────────────────────────────
 *   Option A — Cloudflare Dashboard:
 *     Workers & Pages → Create → "Hello World" → paste this file → Deploy
 *
 *   Option B — Wrangler CLI:
 *     npm i -g wrangler
 *     npx wrangler deploy cfworker.js --name kisskh-proxy --compatibility-date 2024-01-01
 *
 * ── Environment variables (set in Cloudflare Worker settings) ───────────────
 *   AUTH_TOKEN   optional secret; if set, callers must send the same value in
 *                the "x-worker-auth" request header (or ?auth= query param).
 *                Generate with: openssl rand -hex 32
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   GET https://<worker>.workers.dev/?url=<encoded_kisskh_api_url>
 *   GET https://<worker>.workers.dev/?url=<...>&xhr=1          (adds X-Requested-With)
 *   GET https://<worker>.workers.dev/?url=<...>&referer=<url>  (custom Referer)
 *
 * ── StreamFusion Mail config ────────────────────────────────────────────────
 *   Set the following Vercel environment variables:
 *     CF_WORKER_URL  = https://<your-worker>.workers.dev
 *     CF_WORKER_AUTH = <your AUTH_TOKEN value>  (optional, but recommended)
 */

export default {
  // ── Scheduled cron: auto-refresh Eurostreaming cache ──────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(_handleScheduledWarm(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'x-worker-auth, content-type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── Auth check (skip if AUTH_TOKEN not set) ─────────────────────────────
    const authToken = (env.AUTH_TOKEN || '').trim();
    if (authToken) {
      const provided = (
        request.headers.get('x-worker-auth') ||
        url.searchParams.get('auth') ||
        ''
      ).trim();
      if (provided !== authToken) {
        return _json({ error: 'Unauthorized' }, 401);
      }
    }

    // ── Parse target URL ────────────────────────────────────────────────────
    const targetUrl = url.searchParams.get('url');

    // ── KV test endpoint ────────────────────────────────────────────────────
    if (url.searchParams.get('kv_test') === '1') {
      try {
        if (!env?.ES_CACHE) return _json({ error: 'ES_CACHE binding not found' });
        await env.ES_CACHE.put('_test_key', JSON.stringify({ ok: true, ts: Date.now() }), { expirationTtl: 300 });
        const read = await env.ES_CACHE.get('_test_key', 'json');
        return _json({ written: true, read });
      } catch (e) {
        return _json({ error: e.message, stack: e.stack });
      }
    }

    // ── Eurostreaming KV index: return cached titles index ──────────────────
    if (url.searchParams.get('es_titles') === '1') {
      if (!env?.ES_CACHE) return _json({ error: 'ES_CACHE binding not found' });
      try {
        const idx = await env.ES_CACHE.get('es:titles', 'json');
        if (!idx) return _json({ error: 'No titles index — run warm_es first' }, 404);
        return _json(idx);
      } catch (e) { return _json({ error: e.message }, 500); }
    }

    // ── Eurostreaming KV post data: return post content from batch page ─────
    if (url.searchParams.get('es_post_data')) {
      const postId = url.searchParams.get('es_post_data');
      const pageNum = url.searchParams.get('es_page');
      if (!env?.ES_CACHE) return _json({ error: 'ES_CACHE binding not found' });
      if (!/^\d+$/.test(postId)) return _json({ error: 'Invalid post ID' }, 400);
      if (!pageNum || !/^\d+$/.test(pageNum)) return _json({ error: 'Missing or invalid es_page param' }, 400);
      try {
        const batch = await env.ES_CACHE.get(`es:page:${pageNum}`, 'json');
        if (!batch || !Array.isArray(batch)) return _json({ error: 'Page not cached' }, 404);
        const post = batch.find(p => p.id === parseInt(postId, 10));
        if (!post) return _json({ error: 'Post not found in page' }, 404);
        return _json(post);
      } catch (e) { return _json({ error: e.message }, 500); }
    }

    // ── Eurostreaming KV warm-up: fetch all posts and cache in KV ───────────
    if (url.searchParams.get('warm_es') === '1') {
      if (!env?.ES_CACHE) return _json({ error: 'ES_CACHE binding not found' });

      // POST with JSON body = store titles index
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          if (body && typeof body === 'object') {
            await env.ES_CACHE.put('es:titles', JSON.stringify(body), { expirationTtl: _ES_KV_TTL });
            return _json({ ok: true, action: 'index_stored', entries: Object.keys(body).length });
          }
          return _json({ error: 'Invalid body' }, 400);
        } catch (e) { return _json({ error: `Index store failed: ${e.message}` }, 500); }
      }

      return _handleWarmEs(url, env);
    }

    if (!targetUrl) {
      return _json({ error: 'Missing required ?url= parameter' }, 400);
    }

    // ── Security: only proxy allowed hosts ──────────────────────────────────
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return _json({ error: 'Invalid url parameter' }, 400);
    }

    const ALLOWED_HOSTS = new Set([
      'kisskh.do', 'www.kisskh.do', 'kisskh.co', 'www.kisskh.co',
      'eurostream.ing', 'www.eurostream.ing',
      'eurostreamings.life', 'www.eurostreamings.life',
      'clicka.cc', 'www.clicka.cc',
      'safego.cc', 'www.safego.cc',
      'deltabit.co', 'www.deltabit.co',
      'turbovid.me', 'www.turbovid.me',
      'uprot.net', 'www.uprot.net',
      'maxstream.video', 'www.maxstream.video',
      'guardoserie.digital', 'www.guardoserie.digital',
      'guardoserie.best', 'www.guardoserie.best',
    ]);
    if (!ALLOWED_HOSTS.has(parsedTarget.hostname)) {
      return _json({ error: `Host ${parsedTarget.hostname} is not proxied by this Worker` }, 403);
    }

    // ── ES Stream: full clicka→safego→captcha→deltabit→video extraction ────
    // Stremio calls this URL directly; Worker runs at player's edge (not Vercel's).
    // Returns 302 redirect to the final video MP4/M3U8 URL.
    // Usage: ?es_stream=1&url=https://clicka.cc/delta/xxx
    if (url.searchParams.get('es_stream') === '1') {
      return _handleEsStream(targetUrl, url, env);
    }

    // ── ES Resolve: full clicka→safego→captcha→deltabit chain in one shot ──
    // Usage: ?es_resolve=1&url=https://clicka.cc/delta/xxx
    // Returns: { url: 'https://deltabit.co/xxx', cached: bool }
    if (url.searchParams.get('es_resolve') === '1' && parsedTarget.hostname.includes('clicka')) {
      return _handleEsResolve(targetUrl, url, env);
    }

    // ── Safego captcha solver mode ──────────────────────────────────────────
    // All requests happen in one Worker invocation (same outbound IP).
    if (url.searchParams.get('safego') === '1' && parsedTarget.hostname.includes('safego')) {
      return _handleSafego(targetUrl, url, env);
    }

    // ── Safego diagnostic: fetch captcha and return OCR analysis ─────────────
    if (url.searchParams.get('safego_diag') === '1' && parsedTarget.hostname.includes('safego')) {
      return _handleSafegoDiag(targetUrl);
    }

    // ── nofollow mode: return redirect info without following ────────────────
    const nofollow = url.searchParams.get('nofollow') === '1';

    // ── Build outbound headers ──────────────────────────────────────────────
    const isXhr    = url.searchParams.get('xhr') === '1';
    const isKissKH = parsedTarget.hostname.includes('kisskh');
    const isEurostream = parsedTarget.hostname.includes('eurostream');
    const isClicka = parsedTarget.hostname.includes('clicka');
    const isSafego = parsedTarget.hostname.includes('safego');
    const isDeltabit = parsedTarget.hostname.includes('deltabit');
    const isTurbovid = parsedTarget.hostname.includes('turbovid');

    const referer  = url.searchParams.get('referer') ||
      (isKissKH ? 'https://kisskh.co/' :
       isEurostream ? 'https://eurostream.ing/' :
       isClicka ? 'https://eurostream.ing/' :
       isSafego ? 'https://safego.cc/' :
       isDeltabit ? 'https://safego.cc/' :
       isTurbovid ? 'https://safego.cc/' : '/');

    const origin  = isKissKH ? 'https://kisskh.co' :
                    isEurostream ? 'https://eurostream.ing' :
                    isClicka ? 'https://clicka.cc' :
                    isSafego ? 'https://safego.cc' :
                    isDeltabit ? parsedTarget.origin :
                    isTurbovid ? parsedTarget.origin : parsedTarget.origin;

    const isEpisodeApi = parsedTarget.pathname.includes('/DramaList/Episode/');
    const isGuardoserie = parsedTarget.hostname.includes('guardoserie');
    const cookie = url.searchParams.get('cookie') || '';

    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          isEurostream ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8' : isGuardoserie ? 'text/html, */*' : 'application/json, text/plain, */*',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer':         referer,
      'Origin':          origin,
    };
    // Full browser headers for Cloudflare-protected sites (eurostream + clicka)
    if (isEurostream || isClicka) {
      headers['Accept-Encoding'] = 'gzip, deflate, br';
      headers['Cache-Control'] = 'no-cache';
      headers['Pragma'] = 'no-cache';
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = 'none';
      headers['Sec-Fetch-User'] = '?1';
      headers['Upgrade-Insecure-Requests'] = '1';
      headers['sec-ch-ua'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
      delete headers['Origin']; // Browsers don't send Origin on navigation
    }
    if (cookie) headers['Cookie'] = cookie;
    // Custom Content-Type for POST requests (e.g. guardoserie WP AJAX)
    const contentType = url.searchParams.get('contentType');
    if (contentType) headers['Content-Type'] = contentType;

    // Episode API and XHR-mode requests need X-Requested-With
    if (isXhr || isEpisodeApi) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    // ── KV cache: domains where responses are cached globally ──────────────
    const _KV_CACHEABLES = { 'eurostream.ing': 86400, 'eurostreamings.life': 86400, 'clicka.cc': 86400, 'deltabit.co': 3600 };
    const hostNorm = parsedTarget.hostname.replace(/^www\./, '');
    const kvTtl = _KV_CACHEABLES[hostNorm] || 0;
    const isPost = url.searchParams.get('method') === 'POST';
    // Only cache GET requests (POST = captcha submissions, form posts)
    const kvKey = kvTtl && !isPost ? `p:${targetUrl}` : null;

    // ── Proxy request ───────────────────────────────────────────────────────
    try {
      const resp = await fetch(targetUrl, {
        method: isPost ? 'POST' : 'GET',
        headers,
        body: isPost ? (url.searchParams.get('body') || '') : undefined,
        redirect: nofollow ? 'manual' : 'follow',
        cf: { cacheEverything: false },
      });

      // Read response once
      const bodyBuf = await resp.arrayBuffer();
      const bodyText = new TextDecoder().decode(bodyBuf);
      const status = resp.status;
      const location = resp.headers.get('Location') || resp.headers.get('location') || '';
      const setCk = resp.headers.get('Set-Cookie') || '';
      const ct = resp.headers.get('Content-Type') || 'application/json; charset=utf-8';

      // Detect Cloudflare block
      const isCfBlock = status === 403 && (bodyText.includes('Just a moment') || bodyText.includes('Checking your browser'));

      // If blocked and cacheable → fall back to KV
      if (isCfBlock && kvKey && env?.ES_CACHE) {
        try {
          const cached = await env.ES_CACHE.get(kvKey, 'json');
          if (cached && cached.b) {
            return _proxyResponse(cached.b, cached.s || 200, cached.l || '', cached.ck || '', cached.ct || ct, nofollow, url.searchParams.get('wantCookie') === '1', true);
          }
        } catch { /* KV read error */ }
      }

      // If success and cacheable → store in KV
      if (!isCfBlock && status >= 200 && status < 400 && kvKey && env?.ES_CACHE) {
        try {
          const kvVal = JSON.stringify({ b: bodyText, s: status, l: location, ck: setCk, ct, t: Date.now() });
          await env.ES_CACHE.put(kvKey, kvVal, { expirationTtl: Math.max(kvTtl, 60) });
        } catch (kvErr) { /* KV write error — silently ignore */ }
      }

      return _proxyResponse(bodyText, status, location, setCk, ct, nofollow, url.searchParams.get('wantCookie') === '1', false);
    } catch (err) {
      // Fetch error → try KV as last resort
      if (kvKey && env?.ES_CACHE) {
        try {
          const cached = await env.ES_CACHE.get(kvKey, 'json');
          if (cached && cached.b) {
            return _proxyResponse(cached.b, cached.s || 200, cached.l || '', cached.ck || '', cached.ct || 'text/html', nofollow, url.searchParams.get('wantCookie') === '1', true);
          }
        } catch { /* KV read error */ }
      }
      return _json({ error: `Proxy fetch failed: ${err.message}` }, 502);
    }
  },
};

// ─── Eurostreaming KV warm-up ──────────────────────────────────────────────────

const _ES_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const _ES_KV_TTL = 172800; // 48h — warm-up data is long-lived

async function _esWarmFetch(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': _ES_UA,
      'Accept': 'application/json,text/html,*/*',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const body = await resp.text();
  if (!resp.ok || body.includes('Just a moment')) return null;
  return body;
}

async function _handleWarmEs(url, env) {
  const baseUrl = (url.searchParams.get('base') || 'https://eurostream.ing').replace(/\/+$/, '');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const perPage = 100;

  // Fetch one page of posts and cache the WHOLE page as one KV entry
  const errors = [];
  let totalPosts = 0;
  const pageTitles = {}; // title → [{id, page}]

  try {
    const listUrl = `${baseUrl}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,title,content`;
    const body = await _esWarmFetch(listUrl);
    if (!body) return _json({ ok: false, error: 'blocked or failed', page });

    let posts;
    try { posts = JSON.parse(body); } catch { return _json({ ok: false, error: 'invalid JSON', page }); }
    if (!Array.isArray(posts)) return _json({ ok: false, error: 'not an array', page });

    // Build batch array and titles index
    const batch = [];
    for (const post of posts) {
      totalPosts++;
      const postId = post.id;
      const title = post.title?.rendered || '';
      const content = post.content?.rendered || '';
      if (!postId || !content) continue;

      batch.push({ id: postId, title: { rendered: title }, content: { rendered: content } });

      // Build page-level titles
      const cleanTitle = (title || '').replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1), 10)))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      if (cleanTitle) {
        const key = cleanTitle.toLowerCase();
        if (!pageTitles[key]) pageTitles[key] = [];
        pageTitles[key].push({ id: postId, page });
      }
    }

    // Store entire page as ONE KV entry (instead of 100 individual writes)
    try {
      await env.ES_CACHE.put(`es:page:${page}`, JSON.stringify(batch), { expirationTtl: _ES_KV_TTL });
    } catch (e) { errors.push(`Batch write: ${e.message}`); }

  } catch (e) {
    errors.push(`Fetch: ${e.message}`);
  }

  return _json({
    ok: true, page, totalPosts, totalCached: totalPosts,
    titles: pageTitles,
    hasMore: totalPosts >= perPage,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// ─── Scheduled auto-refresh for Eurostreaming ──────────────────────────────────

const _WARM_PAGES_PER_RUN = 10;
const _WARM_COOLDOWN_MS = 24 * 3600 * 1000; // 24h between full refreshes

async function _handleScheduledWarm(env) {
  if (!env?.ES_CACHE) return;

  const state = await env.ES_CACHE.get('es:warm:state', 'json') || { nextPage: 1, titles: {}, lastComplete: 0 };

  // Don't refresh more often than every 24h
  if (state.lastComplete && Date.now() - state.lastComplete < _WARM_COOLDOWN_MS) return;

  const baseUrl = 'https://eurostream.ing';
  let { nextPage, titles } = state;
  if (!titles || typeof titles !== 'object') titles = {};

  for (let i = 0; i < _WARM_PAGES_PER_RUN; i++) {
    let posts;
    try {
      const listUrl = `${baseUrl}/wp-json/wp/v2/posts?per_page=100&page=${nextPage}&_fields=id,title,content`;
      const body = await _esWarmFetch(listUrl);
      if (!body) { /* blocked — save progress and retry next cron */
        await env.ES_CACHE.put('es:warm:state', JSON.stringify({ nextPage, titles, lastComplete: 0 }), { expirationTtl: _ES_KV_TTL });
        return;
      }
      posts = JSON.parse(body);
    } catch { break; }
    if (!Array.isArray(posts) || posts.length === 0) { posts = []; }

    // Store batch in KV
    if (posts.length > 0) {
      const batch = posts.map(p => ({
        id: p.id,
        title: { rendered: p.title?.rendered || '' },
        content: { rendered: p.content?.rendered || '' },
      }));
      try {
        await env.ES_CACHE.put(`es:page:${nextPage}`, JSON.stringify(batch), { expirationTtl: _ES_KV_TTL });
      } catch { /* KV write failed — continue */ }

      // Accumulate titles
      for (const post of posts) {
        const raw = (post.title?.rendered || '')
          .replace(/&#\d+;/g, m => String.fromCharCode(parseInt(m.slice(2, -1), 10)))
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (raw) {
          const key = raw.toLowerCase();
          if (!titles[key]) titles[key] = [];
          titles[key].push({ id: post.id, page: nextPage });
        }
      }
    }

    // Last page reached
    if (posts.length < 100) {
      try { await env.ES_CACHE.put('es:titles', JSON.stringify(titles), { expirationTtl: _ES_KV_TTL }); } catch {}
      await env.ES_CACHE.put('es:warm:state', JSON.stringify({ nextPage: 1, titles: {}, lastComplete: Date.now() }), { expirationTtl: _ES_KV_TTL });
      return;
    }
    nextPage++;
  }

  // More pages remain — save progress
  await env.ES_CACHE.put('es:warm:state', JSON.stringify({ nextPage, titles, lastComplete: 0 }), { expirationTtl: _ES_KV_TTL });
}

/** Format proxy response for all modes (nofollow, wantCookie, passthrough). */
function _proxyResponse(bodyText, status, location, setCookie, contentType, nofollow, wantCookie, fromCache) {
  const cacheHdr = fromCache ? { 'X-KV-Cache': 'hit' } : {};
  if (nofollow) {
    const json = { status, location, setCookie };
    if (wantCookie) json.body = bodyText;
    if (fromCache) json.kvCache = true;
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...cacheHdr } });
  }
  if (wantCookie) {
    const json = { status, setCookie, location, body: bodyText };
    if (fromCache) json.kvCache = true;
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...cacheHdr } });
  }
  return new Response(bodyText, {
    status,
    headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'X-Worker-Upstream-Status': String(status), ...cacheHdr },
  });
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Safego captcha solver — runs GET → OCR → POST → redirect in one Worker
 * invocation so all outbound requests share the same IP.
 */
// ─── Pixel OCR engine (no external API dependencies) ─────────────────────────

/** Decompress zlib-wrapped data using Web Streams API (CF Workers). */
async function _inflate(data) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

/** Decode a PNG from Uint8Array into { width, height, pixels[] } (grayscale 0-255). */
async function _decodePngGrayscale(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 8; // skip PNG magic
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const chunkLen = view.getUint32(offset); offset += 4;
    const type = String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3]); offset += 4;
    const data = buf.slice(offset, offset + chunkLen); offset += chunkLen + 4; // +4 for CRC
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0); height = dv.getUint32(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
  }
  // Concat IDAT chunks
  let idatTotal = 0;
  for (const c of idatChunks) idatTotal += c.length;
  const idat = new Uint8Array(idatTotal);
  let io = 0;
  for (const c of idatChunks) { idat.set(c, io); io += c.length; }

  const raw = await _inflate(idat);
  const channels = [0, 0, 3, 0, 2, 0, 4][colorType] || 1;
  const bpp = Math.ceil((bitDepth * channels) / 8);
  const stride = 1 + width * bpp;
  const pixels = new Uint8Array(width * height);
  let prev = new Uint8Array(width * bpp);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * stride];
    const cur = new Uint8Array(width * bpp);
    for (let i = 0; i < width * bpp; i++) {
      const b = raw[y * stride + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const c = (i >= bpp && y > 0) ? prev[i - bpp] : 0;
      const p = prev[i];
      let v;
      if (ft === 0) v = b;
      else if (ft === 1) v = b + a;
      else if (ft === 2) v = b + p;
      else if (ft === 3) v = b + Math.floor((a + p) / 2);
      else { const pa = Math.abs(p - c), pb = Math.abs(a - c), pc = Math.abs(a + p - 2 * c); v = b + (pa <= pb && pa <= pc ? a : pb <= pc ? p : c); }
      cur[i] = v & 0xFF;
    }
    prev = cur;
    for (let x = 0; x < width; x++) {
      const r = cur[x * bpp], g = channels >= 3 ? cur[x * bpp + 1] : r, bv = channels >= 3 ? cur[x * bpp + 2] : r;
      pixels[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * bv);
    }
  }
  return { width, height, pixels };
}

// ─── Bitmap-based digit templates (calibrated from real safego captchas) ──────
const _BITMAP_TEMPLATES = {
  '0': '...##...|..####..|.##..##.|##....##|##....##|##....##|##....##|.##..##.|..####..|...##...',
  '1': '..##|.###|####|..##|..##|..##|..##|..##|..##|####',
  '2': '..####..|.##..##.|##....##|......##|.....##.|....##..|...##...|..##....|.##.....|########',
  '3': '.#####..|##...##.|......##|.....##.|...###..|.....##.|......##|......##|##...##.|.#####..',
  '4': '.....##|....###|...####|..##.##|.##..##|##...##|#######|.....##|.....##|.....##',
  '5': '#######.|##......|##......|##.###..|###..##.|......##|......##|##....##|.##..##.|..####..',
  '6': '..####..|.##..##.|##....#.|##......|##.###..|###..##.|##....##|##....##|.##..##.|..####..',
  '7': '########|......##|......##|.....##.|....##..|...##...|..##....|.##.....|##......|##......',
  '8': '..####..|.##..##.|##....##|.##..##.|..####..|.##..##.|##....##|##....##|.##..##.|..####..',
  '9': '..####..|.##..##.|##....##|##....##|.##..###|..###.##|......##|.#....##|.##..##.|..####..',
};

function _ocrDigitsFromPixels(width, height, pixels, threshold = 128) {
  // 1. Column darkness → segment digits
  const colDark = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < height; y++) { if (pixels[y * width + x] < threshold) dark++; }
    colDark[x] = dark / height;
  }
  const inDigit = Array.from(colDark, v => v > 0.05);
  const segments = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    if (inDigit[x] && start < 0) start = x;
    else if (!inDigit[x] && start >= 0) { segments.push([start, x - 1]); start = -1; }
  }
  const merged = [];
  for (const seg of segments) {
    if (merged.length && seg[0] - merged[merged.length - 1][1] <= 1) {
      merged[merged.length - 1][1] = seg[1];
    } else merged.push([...seg]);
  }
  const digits = merged.filter(([s, e]) => e - s >= 2);
  if (!digits.length) return null;

  // 2. Extract each digit bitmap and match against templates
  let result = '';
  for (const [s, e] of digits) {
    // Find vertical bounds
    let top = -1, bot = -1;
    for (let y = 0; y < height; y++) {
      let d = 0; for (let x = s; x <= e; x++) if (pixels[y * width + x] < threshold) d++;
      if (d > 0) { if (top < 0) top = y; bot = y; }
    }
    if (top < 0) continue;
    // Build bitmap rows
    const rows = [];
    for (let y = top; y <= bot; y++) {
      let row = '';
      for (let x = s; x <= e; x++) row += pixels[y * width + x] < threshold ? '#' : '.';
      rows.push(row);
    }
    const key = rows.join('|');
    // Exact match first
    let matched = null;
    for (const [ch, tmpl] of Object.entries(_BITMAP_TEMPLATES)) {
      if (tmpl === key) { matched = ch; break; }
    }
    // Hamming distance fallback (same-width templates only)
    if (!matched) {
      let best = '?', bestDist = Infinity;
      for (const [ch, tmpl] of Object.entries(_BITMAP_TEMPLATES)) {
        const t = tmpl.replace(/\|/g, '');
        const k = key.replace(/\|/g, '');
        if (t.length !== k.length) continue;
        let dist = 0;
        for (let i = 0; i < t.length; i++) if (t[i] !== k[i]) dist++;
        if (dist < bestDist) { bestDist = dist; best = ch; }
      }
      matched = bestDist <= 12 ? best : '?';
    }
    result += matched;
  }
  return result || null;
}

// ─── Safego diagnostic (returns OCR analysis without POSTing) ────────────────
async function _handleSafegoDiag(safegoUrl) {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0';
  try {
    const r1 = await fetch(safegoUrl, { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const html1 = await r1.text();
    const imgMatch = html1.match(/data:image\/png;base64,([^"]+)"/i);
    if (!imgMatch) return _json({ error: 'no captcha' });
    const b64 = imgMatch[1].replace(/\s/g, '');
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const { width, height, pixels } = await _decodePngGrayscale(raw);
    // Build ASCII art
    const ascii = [];
    for (let y = 0; y < height; y++) {
      let line = '';
      for (let x = 0; x < width; x++) line += pixels[y * width + x] < 128 ? '#' : '.';
      ascii.push(line);
    }
    const answer = _ocrDigitsFromPixels(width, height, pixels);
    return _json({ width, height, answer, b64len: b64.length, ascii });
  } catch (err) {
    return _json({ error: err.message });
  }
}

// ─── Safego captcha solver ───────────────────────────────────────────────────

async function _handleSafego(safegoUrl, reqUrl, env) {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0';
  const hdrs = (extra = {}) => ({
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://safego.cc/',
    ...extra,
  });

  try {
    const MAX_ATTEMPTS = 3;
    const attempts = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 1. GET safego page → PHPSESSID + captcha image
      const r1 = await fetch(safegoUrl, { headers: hdrs(), redirect: 'manual' });
      const sessid = ((r1.headers.get('Set-Cookie') || '').match(/PHPSESSID=([^;,\s]+)/) || [])[1];
      if (!sessid) { attempts.push({ attempt, error: 'no PHPSESSID' }); continue; }
      const html1 = await r1.text();
      const cField = (html1.match(/name="(captch[45])"/) || [])[1] || 'captch5';
      const imgMatch = html1.match(/data:image\/png;base64,([^"]+)"/i);
      if (!imgMatch) { attempts.push({ attempt, error: 'no captcha image' }); continue; }
      const b64 = imgMatch[1].replace(/\s/g, '');

      // 2. Decode PNG
      let width, height, pixels;
      try {
        const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        ({ width, height, pixels } = await _decodePngGrayscale(raw));
      } catch (ocrErr) {
        attempts.push({ attempt, error: `decode: ${ocrErr.message}` });
        continue;
      }

      // 3. OCR — bitmap template matching (primary), AI fallback
      let answer = null;
      let ocrMethod = '';

      // 3a. Pixel OCR with bitmap templates (very accurate for this captcha font)
      const pxAnswer = _ocrDigitsFromPixels(width, height, pixels);
      if (pxAnswer && !pxAnswer.includes('?') && pxAnswer.length >= 2 && pxAnswer.length <= 5) {
        answer = pxAnswer; ocrMethod = 'pixel';
      }

      // 3b. AI vision fallback (only if pixel OCR failed)
      if (!answer && env?.AI) {
        try {
          const b64img = btoa(String.fromCharCode(...Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
          const aiResp = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
            image: [...Uint8Array.from(atob(b64), c => c.charCodeAt(0))],
            prompt: 'This CAPTCHA shows exactly 3 digits. What are the digits? Reply with ONLY the 3 digits, nothing else.',
            max_tokens: 10,
          });
          const aiText = (aiResp?.description || aiResp?.response || '').replace(/\D/g, '');
          if (aiText && aiText.length >= 2 && aiText.length <= 5) { answer = aiText; ocrMethod = 'ai'; }
        } catch (aiErr) { /* AI failed */ }
      }

      if (!answer) {
        attempts.push({ attempt, error: 'ocr failed' });
        continue;
      }

      // 4. POST the answer
      const rPost = await fetch(safegoUrl, {
        method: 'POST',
        headers: hdrs({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `PHPSESSID=${sessid}`,
          'Origin': 'https://safego.cc',
          'Referer': safegoUrl,
        }),
        body: `${cField}=${answer}`,
        redirect: 'manual',
      });

      // Safego returns 200 + <a href="URL"> on success (NOT a 302 redirect)
      const postBody = await rPost.text();
      const linkMatch = /<a\b[^>]+href="(https?:\/\/[^"]+)"/.exec(postBody);
      let resultUrl = linkMatch ? linkMatch[1] : null;

      // Fallback: 302 redirect (some versions may use this)
      if (!resultUrl) {
        const postLoc = rPost.headers.get('Location');
        if (postLoc) resultUrl = new URL(postLoc, safegoUrl).href;
      }

      if (resultUrl) {
        // followAll: follow redirect chain to final destination (deltabit/turbovid/mixdrop)
        // This solves the problem of clicka.cc/adelta being blocked from some edges
        const followAll = reqUrl.searchParams.get('followAll') === '1';
        let finalUrl = resultUrl;
        if (followAll) {
          for (let hop = 0; hop < 8; hop++) {
            if (/deltabit|turbovid|mixdrop|m1xdrop|maxstream/i.test(finalUrl)) break;
            try {
              const redir = await fetch(finalUrl, {
                headers: { 'User-Agent': UA, 'Accept': '*/*' },
                redirect: 'manual',
              });
              const loc = redir.headers.get('Location') || redir.headers.get('location');
              if (!loc) break;
              finalUrl = new URL(loc, finalUrl).href;
            } catch { break; }
          }
          // Cache the delta→final mapping in KV for future use
          if (env?.ES_CACHE && /deltabit|turbovid|mixdrop|m1xdrop/i.test(finalUrl)) {
            // Extract original delta slug from the safego URL's referrer chain
            const deltaUrl = reqUrl.searchParams.get('deltaUrl');
            if (deltaUrl) {
              try {
                await env.ES_CACHE.put(`resolve:${deltaUrl}`, JSON.stringify({ url: finalUrl, t: Date.now() }), { expirationTtl: 86400 });
              } catch { /* ignore */ }
            }
          }
        }
        return _json({ url: followAll ? finalUrl : resultUrl, attempt, answer, ocrMethod, ...(followAll && finalUrl !== resultUrl ? { intermediateUrl: resultUrl } : {}) });
      }

      const errSnippet = postBody.substring(0, 200);
      attempts.push({ attempt, answer, ocrMethod, postStatus: rPost.status, errSnippet });
    }

    return _json({ error: `Captcha unsolved after ${MAX_ATTEMPTS} attempts`, attempts }, 502);
  } catch (err) {
    return _json({ error: `Safego solver error: ${err.message}` }, 502);
  }
}

// ─── ES Resolve: clicka.cc/delta → safego → captcha → deltabit in one shot ──

async function _handleEsResolve(deltaUrl, reqUrl, env) {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0';

  // 1. Check KV cache for resolved URL
  if (env?.ES_CACHE) {
    try {
      const cached = await env.ES_CACHE.get(`resolve:${deltaUrl}`, 'json');
      if (cached && cached.url && Date.now() - cached.t < 86400000) {
        return _json({ url: cached.url, cached: true });
      }
    } catch { /* ignore */ }
  }

  try {
    let current = deltaUrl;

    // 2. Follow redirects until we hit safego or a final host
    for (let hop = 0; hop < 8; hop++) {
      if (/deltabit|turbovid|mixdrop|m1xdrop|maxstream/i.test(current)) {
        // Cache the successful resolution
        if (env?.ES_CACHE) {
          try { await env.ES_CACHE.put(`resolve:${deltaUrl}`, JSON.stringify({ url: current, t: Date.now() }), { expirationTtl: 86400 }); } catch {}
        }
        return _json({ url: current, cached: false });
      }

      if (current.includes('safego')) {
        // Solve captcha with followAll to get the final URL
        const fakeReqUrl = new URL('https://dummy/?followAll=1&deltaUrl=' + encodeURIComponent(deltaUrl));
        const safegoResp = await _handleSafego(current, fakeReqUrl, env);
        const safegoResult = await safegoResp.json();
        if (safegoResult.url) {
          return _json({ url: safegoResult.url, cached: false, captchaSolved: true, attempt: safegoResult.attempt });
        }
        return _json({ error: 'Captcha solve failed', details: safegoResult }, 502);
      }

      // Follow redirect
      const resp = await fetch(current, {
        headers: { 'User-Agent': UA, 'Accept': '*/*' },
        redirect: 'manual',
      });
      const loc = resp.headers.get('Location') || resp.headers.get('location');
      if (!loc) {
        // Check KV for redirect location
        if (env?.ES_CACHE) {
          try {
            const cachedRedir = await env.ES_CACHE.get(`p:${current}`, 'json');
            if (cachedRedir && cachedRedir.l) {
              current = new URL(cachedRedir.l, current).href;
              continue;
            }
          } catch {}
        }
        return _json({ error: 'No redirect location', url: current, status: resp.status }, 502);
      }
      current = new URL(loc, current).href;
    }

    return _json({ error: 'Max hops reached', url: current }, 502);
  } catch (err) {
    return _json({ error: `ES resolve error: ${err.message}` }, 502);
  }
}

// ─── ES Stream: full video extraction from clicka.cc/delta → MP4 URL ────────

// p.a.c.k.e.r unpacker (ported from extractors/common.js)
const _PACKER_RE = [
  /}\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'(.*)'\.split\('\|'\),\s*(\d+),\s*(.*)\)\)/s,
  /}\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'(.*)'\.split\('\|'\)/s,
];
function _unPack(p, a, c, k) {
  const e = (c2) => (c2 < a ? '' : e(Math.floor(c2 / a))) + ((c2 = c2 % a) > 35 ? String.fromCharCode(c2 + 29) : c2.toString(36));
  const d = {};
  while (c--) { d[e(c)] = k[c] || e(c); }
  return p.replace(/\b\w+\b/g, (m) => d[m] || m);
}
function _replaceLookupStrings(src) {
  const m = /var\s*(_\w+)\s*=\s*\["(.*?)"\];/s.exec(src);
  if (!m) return src;
  const vals = m[2].split('","');
  let out = src;
  for (let i = 0; i < vals.length; i++) out = out.replaceAll(`${m[1]}[${i}]`, `"${vals[i]}"`);
  return out.slice(m.index + m[0].length);
}
function _unpackPacker(html) {
  if (!html.includes('eval(function(p,a,c,k,e,d)')) return null;
  for (const re of _PACKER_RE) {
    const m = re.exec(html);
    if (!m) continue;
    const payload = String(m[1]).replace(/\\\\/g, '\\').replace(/\\'/g, "'");
    const radix = m[2] === '[]' ? 62 : parseInt(m[2], 10);
    const count = parseInt(m[3], 10);
    const symtab = String(m[4]).split('|');
    if (!Number.isInteger(radix) || !Number.isInteger(count) || symtab.length < count) continue;
    try { return _replaceLookupStrings(_unPack(payload, radix, count, symtab)); } catch { continue; }
  }
  return null;
}

async function _handleEsStream(deltaUrl, reqUrl, env) {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0';

  // Check KV for cached video URL (short TTL — tokens may expire)
  if (env?.ES_CACHE) {
    try {
      const cached = await env.ES_CACHE.get(`video:${deltaUrl}`, 'json');
      if (cached && cached.url && Date.now() - cached.t < 1800000) { // 30 min
        return new Response(null, { status: 302, headers: { 'Location': cached.url, 'Access-Control-Allow-Origin': '*' } });
      }
    } catch {}
  }

  try {
    // Phase 1: Resolve delta → deltabit URL
    let deltabitUrl = null;

    // Check KV for cached resolution
    if (env?.ES_CACHE) {
      try {
        const cached = await env.ES_CACHE.get(`resolve:${deltaUrl}`, 'json');
        if (cached && cached.url) deltabitUrl = cached.url;
      } catch {}
    }

    if (!deltabitUrl) {
      // Resolve live: clicka → safego → captcha → deltabit
      const resolveResp = await _handleEsResolve(deltaUrl, reqUrl, env);
      const resolved = await resolveResp.json();
      if (!resolved.url || resolved.error) {
        return _json({ error: 'Failed to resolve delta URL', details: resolved }, 502);
      }
      deltabitUrl = resolved.url;
    }

    // Phase 2: Follow redirects to final deltabit page
    let pageUrl = deltabitUrl;
    for (let i = 0; i < 5; i++) {
      const rr = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Referer': 'https://safego.cc/' },
        redirect: 'manual',
      });
      const loc = rr.headers.get('Location');
      if (!loc) break;
      pageUrl = new URL(loc, pageUrl).href;
    }

    // Phase 3: GET deltabit page
    const pageResp = await fetch(pageUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://safego.cc/',
        'Accept': 'text/html,*/*',
      },
    });
    if (!pageResp.ok) return _json({ error: 'Deltabit page fetch failed', status: pageResp.status }, 502);
    const pageHtml = await pageResp.text();

    // Phase 4: Parse form
    const formData = {};
    for (const m of pageHtml.matchAll(/<input\b([^>]*)>/gi)) {
      const nameM = /\bname="([^"]+)"/.exec(m[1]);
      const valM = /\bvalue="([^"]*)"/.exec(m[1]);
      if (nameM) formData[nameM[1]] = valM ? valM[1] : '';
    }
    formData['imhuman'] = '';
    formData['referer'] = pageUrl;

    // Phase 5: Wait (deltabit enforces a JS timer)
    await new Promise(r => setTimeout(r, 4500));

    // Phase 6: POST the form
    const postResp = await fetch(pageUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': pageUrl,
        'Origin': new URL(pageUrl).origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(formData).toString(),
    });
    if (!postResp.ok) return _json({ error: 'Deltabit POST failed', status: postResp.status }, 502);
    const postHtml = await postResp.text();

    // Phase 7: Unpack p.a.c.k.e.r → extract video URL
    const unpacked = _unpackPacker(postHtml) || postHtml;
    const urlMatch = /sources\s*:\s*\[\s*["']([^"']+)["']\s*\]/.exec(unpacked)
      || /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/.exec(unpacked)
      || /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/.exec(unpacked);

    if (urlMatch && urlMatch[1] && urlMatch[1].startsWith('http')) {
      const videoUrl = urlMatch[1];
      // Cache video URL (short TTL)
      if (env?.ES_CACHE) {
        try { await env.ES_CACHE.put(`video:${deltaUrl}`, JSON.stringify({ url: videoUrl, t: Date.now() }), { expirationTtl: 1800 }); } catch {}
      }
      return new Response(null, { status: 302, headers: { 'Location': videoUrl, 'Access-Control-Allow-Origin': '*' } });
    }

    return _json({ error: 'Video URL not found in response', htmlPreview: postHtml.substring(0, 500) }, 502);
  } catch (err) {
    return _json({ error: `ES stream error: ${err.message}` }, 502);
  }
}
