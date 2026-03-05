'use strict';

/**
 * FlareSolverr client — bypasses Cloudflare Bot Management via a real Chromium session.
 *
 * Deploy FlareSolverr on Railway:
 *   Docker image: ghcr.io/flaresolverr/flaresolverr:latest
 *   Then set FLARESOLVERR_URL=https://your-app.up.railway.app on Vercel
 *
 * IMPORTANT: KissKH uses Cloudflare Managed Challenge which blocks datacenter IPs.
 * Pass a residential proxy (e.g. Webshare) to bypass it:
 *   flareSolverrGetJSON(url, timeout, 'http://user:pass@p.webshare.io:80')
 * This makes FlareSolverr route through the residential IP → CF accepts it.
 *
 * API:
 *   POST /v1  { cmd: "request.get", url, maxTimeout, proxy: {url:...} }
 *   → { status:"ok", solution:{ status, response, cookies, userAgent } }
 */

const axios = require('axios');
const { createLogger } = require('./logger');

const log = createLogger('flaresolverr');

const MAX_TIMEOUT = Number(process.env.FLARESOLVERR_MAX_TIMEOUT) || 55_000;

/**
 * Check whether a FlareSolverr URL is configured.
 * @returns {string|null}
 */
function getFlareSolverrUrl() {
  return (process.env.FLARESOLVERR_URL || '').trim() || null;
}

/**
 * Build the FlareSolverr proxy object from a proxy URL string.
 * Webshare rotating: http://user-rotate:pass@p.webshare.io:80
 * Webshare sticky:   http://user-rotate-session-FIXED:pass@p.webshare.io:80
 * @param {string} proxyUrl
 * @returns {{url: string}|undefined}
 */
function _buildProxyObj(proxyUrl) {
  if (!proxyUrl) return undefined;
  return { url: proxyUrl };
}

/**
 * Make a GET request through FlareSolverr, optionally routing through a proxy.
 * Returns the response body string, or null on failure.
 *
 * @param {string}  url
 * @param {number}  [timeout]
 * @param {string}  [proxyUrl]  — e.g. Webshare residential proxy URL
 * @returns {Promise<string|null>}
 */
async function flareSolverrGet(url, timeout = MAX_TIMEOUT, proxyUrl = null) {
  const baseUrl = getFlareSolverrUrl();
  if (!baseUrl) {
    log.debug('FlareSolverr not configured (FLARESOLVERR_URL not set)');
    return null;
  }

  const endpoint = baseUrl.replace(/\/$/, '') + '/v1';
  const proxyObj = _buildProxyObj(proxyUrl);
  log.info(`FlareSolverr GET ${url.slice(0, 100)}${proxyObj ? ' [+proxy]' : ''}`);

  try {
    const body = {
      cmd: 'request.get',
      url,
      maxTimeout: timeout,
    };
    if (proxyObj) body.proxy = proxyObj;

    const { data } = await axios.post(endpoint, body, {
      timeout: timeout + 5_000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (data?.status !== 'ok') {
      log.warn(`FlareSolverr status not ok: ${data?.status} — ${data?.message}`);
      return null;
    }

    const httpStatus = data?.solution?.status;
    const respBody   = data?.solution?.response || '';
    log.info(`FlareSolverr solved (http=${httpStatus}, bodyLen=${respBody.length})`);

    if (httpStatus && httpStatus >= 400) {
      log.warn(`FlareSolverr: HTTP ${httpStatus} for ${url}`);
      return null;
    }

    return respBody;
  } catch (err) {
    log.error(`FlareSolverr request failed: ${err.message}`);
    return null;
  }
}

/**
 * Convenience helper: fetch URL through FlareSolverr (+optional proxy), parse as JSON.
 *
 * @param {string}  url
 * @param {number}  [timeout]
 * @param {string}  [proxyUrl]  — residential proxy URL to bypass CF datacenter block
 * @returns {Promise<object|null>}
 */
async function flareSolverrGetJSON(url, timeout = MAX_TIMEOUT, proxyUrl = null) {
  const body = await flareSolverrGet(url, timeout, proxyUrl);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    if (body.includes('<html') || body.includes('Just a moment')) {
      log.warn('FlareSolverr returned HTML (CF challenge still active)');
      return null;
    }
    log.warn('FlareSolverr body is not valid JSON');
    return null;
  }
}

/**
 * Fetch a URL via FlareSolverr and return the cookies from the solved session.
 * Useful for extracting the cf_clearance cookie from a residential IP session.
 *
 * @param {string}  url       — page to load (e.g. 'https://kisskh.co/')
 * @param {string}  [proxyUrl]
 * @returns {Promise<Array<{name,value,domain,...}>|null>}
 */
async function flareSolverrGetCookies(url, timeout = MAX_TIMEOUT, proxyUrl = null) {
  const baseUrl = getFlareSolverrUrl();
  if (!baseUrl) return null;

  const endpoint = baseUrl.replace(/\/$/, '') + '/v1';
  const proxyObj = _buildProxyObj(proxyUrl);
  log.info(`FlareSolverr getCookies ${url.slice(0, 80)}${proxyObj ? ' [+proxy]' : ''}`);

  try {
    const body = { cmd: 'request.get', url, maxTimeout: timeout };
    if (proxyObj) body.proxy = proxyObj;

    const { data } = await axios.post(endpoint, body, {
      timeout: timeout + 5_000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (data?.status !== 'ok') {
      log.warn(`flareSolverrGetCookies not ok: ${data?.status}`);
      return null;
    }
    const cookies = data?.solution?.cookies || [];
    log.info(`FlareSolverr cookies: [${cookies.map(c => c.name).join(', ')}]`);
    return cookies;
  } catch (err) {
    log.error(`flareSolverrGetCookies failed: ${err.message}`);
    return null;
  }
}

module.exports = { getFlareSolverrUrl, flareSolverrGet, flareSolverrGetJSON, flareSolverrGetCookies };
