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
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'x-worker-auth',
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
      'clicka.cc', 'www.clicka.cc',
      'safego.cc', 'www.safego.cc',
      'guardoserie.digital', 'www.guardoserie.digital',
    ]);
    if (!ALLOWED_HOSTS.has(parsedTarget.hostname)) {
      return _json({ error: `Host ${parsedTarget.hostname} is not proxied by this Worker` }, 403);
    }

    // ── nofollow mode: return redirect info without following ────────────────
    const nofollow = url.searchParams.get('nofollow') === '1';

    // ── Build outbound headers ──────────────────────────────────────────────
    const isXhr    = url.searchParams.get('xhr') === '1';
    const isKissKH = parsedTarget.hostname.includes('kisskh');
    const isEurostream = parsedTarget.hostname.includes('eurostream');
    const isClicka = parsedTarget.hostname.includes('clicka');
    const isSafego = parsedTarget.hostname.includes('safego');

    const referer  = url.searchParams.get('referer') ||
      (isKissKH ? 'https://kisskh.co/' :
       isEurostream ? 'https://eurostream.ing/' :
       isClicka ? 'https://eurostream.ing/' :
       isSafego ? 'https://safego.cc/' : '/');

    const origin  = isKissKH ? 'https://kisskh.co' :
                    isEurostream ? 'https://eurostream.ing' :
                    isClicka ? 'https://clicka.cc' :
                    isSafego ? 'https://safego.cc' : parsedTarget.origin;

    const isEpisodeApi = parsedTarget.pathname.includes('/DramaList/Episode/');
    const isGuardoserie = parsedTarget.hostname.includes('guardoserie');
    const cookie = url.searchParams.get('cookie') || '';

    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          isEurostream ? 'application/json, text/html, */*' : isGuardoserie ? 'text/html, */*' : 'application/json, text/plain, */*',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer':         referer,
      'Origin':          origin,
    };
    if (cookie) headers['Cookie'] = cookie;
    // Custom Content-Type for POST requests (e.g. guardoserie WP AJAX)
    const contentType = url.searchParams.get('contentType');
    if (contentType) headers['Content-Type'] = contentType;

    // Episode API and XHR-mode requests need X-Requested-With
    if (isXhr || isEpisodeApi) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    // ── Proxy request ───────────────────────────────────────────────────────
    try {
      const resp = await fetch(targetUrl, {
        method: url.searchParams.get('method') === 'POST' ? 'POST' : 'GET',
        headers,
        body: url.searchParams.get('method') === 'POST' ? (url.searchParams.get('body') || '') : undefined,
        redirect: nofollow ? 'manual' : 'follow',
        cf: { cacheEverything: false },
      });

      // nofollow mode: return redirect metadata as JSON
      if (nofollow) {
        const location = resp.headers.get('Location') || resp.headers.get('location') || '';
        const setCookie = resp.headers.get('Set-Cookie') || '';
        return _json({
          status: resp.status,
          location,
          setCookie,
        });
      }

      const body = await resp.arrayBuffer();

      // For POST responses: include Set-Cookie in JSON wrapper if requested
      if (url.searchParams.get('method') === 'POST' && url.searchParams.get('wantCookie') === '1') {
        const setCookie = resp.headers.get('Set-Cookie') || '';
        const location = resp.headers.get('Location') || resp.headers.get('location') || '';
        const bodyText = new TextDecoder().decode(body);
        return _json({ status: resp.status, setCookie, location, body: bodyText.substring(0, 500) });
      }

      // Pass through the content-type from upstream; default to JSON
      const ct = resp.headers.get('Content-Type') || 'application/json; charset=utf-8';

      return new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type':                ct,
          'Access-Control-Allow-Origin': '*',
          'X-Worker-Upstream-Status':    String(resp.status),
        },
      });
    } catch (err) {
      return _json({ error: `Proxy fetch failed: ${err.message}` }, 502);
    }
  },
};

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
