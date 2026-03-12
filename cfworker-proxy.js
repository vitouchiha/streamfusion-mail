/**
 * cfworker-proxy.js — Generic Cloudflare Worker proxy
 *
 * Proxies requests to allowed domains so they bypass Cloudflare Bot Management.
 * Cloudflare Workers are trusted by other CF-protected sites because the outbound
 * request carries Cloudflare AS headers.
 *
 * ── Deploy ───────────────────────────────────────────────────────────────────
 *   wrangler deploy cfworker-proxy.js --name streamfusion-proxy --config wrangler-proxy.toml
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   GET https://<worker>.workers.dev/?url=<encoded_target_url>
 *
 * ── Vercel env vars ──────────────────────────────────────────────────────────
 *   CF_PROXY_URL = https://<your-worker>.workers.dev
 */

// Domains allowed to be proxied (add more as needed)
const ALLOWED_HOSTS = new Set([
  'supervideo.tv',
  'supervideo.cc',
  'www.supervideo.tv',
  'www.supervideo.cc',
  'vixcloud.co',
  'www.vixcloud.co',
  'guardaserietv.bond',
  'www.guardaserietv.bond',
  'guardaserie.bond',
  'streamingcommunity.computer',
  'streamingcommunity.show',
]);

// Domains matched by suffix (for wildcard subdomains like hfs309.serversicuro.cc)
const ALLOWED_SUFFIXES = ['.serversicuro.cc', '.serversicuro.com'];

function isHostAllowed(hostname) {
  if (ALLOWED_HOSTS.has(hostname)) return true;
  return ALLOWED_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

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

    // ── Parse target URL ────────────────────────────────────────────────────
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return _json({ error: 'Missing required ?url= parameter' }, 400);
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return _json({ error: 'Invalid url parameter' }, 400);
    }

    // ── Security: only proxy allowed hosts ──────────────────────────────────
    if (!isHostAllowed(parsedTarget.hostname)) {
      return _json({ error: `Host not allowed: ${parsedTarget.hostname}` }, 403);
    }

    // ── Get optional Referer from query param ───────────────────────────────
    const referer = url.searchParams.get('referer') || `https://${parsedTarget.hostname}/`;
    // Detect if this is a cross-origin embed request (e.g. VixCloud loaded from AnimeUnity)
    const isCrossOrigin = !referer.includes(parsedTarget.hostname);

    // ── Build outbound request ──────────────────────────────────────────────
    // For HLS/media requests, use lighter headers
    const isMedia = /\.(m3u8|ts|mp4|aac|vtt)([?#]|$)/i.test(parsedTarget.pathname);

    const outboundHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': referer,
      ...(isMedia ? {} : { 'Origin': referer.replace(/\/$/, '').replace(/(\/[^/]+)+$/, '') }),
      'Accept': isMedia ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      ...(isMedia ? {} : {
        'Sec-Fetch-Dest': isCrossOrigin ? 'iframe' : 'document',
        'Sec-Fetch-Mode': isCrossOrigin ? 'navigate' : 'navigate',
        'Sec-Fetch-Site': isCrossOrigin ? 'cross-site' : 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      }),
    };

    try {
      const upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: outboundHeaders,
        redirect: 'follow',
      });

      // Forward the body as-is with CORS headers added
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      // Remove CSP headers that could block usage
      responseHeaders.delete('Content-Security-Policy');
      responseHeaders.delete('X-Frame-Options');

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return _json({ error: `Upstream fetch failed: ${err.message}` }, 502);
    }
  },
};
