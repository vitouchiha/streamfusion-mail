'use strict';

/**
 * FlareSolverr client — bypasses Cloudflare Bot Management via a real Chromium session.
 *
 * Session approach (recommended for sites that require a prior visit to get cf_clearance):
 *   1. createSession()  → sessionId
 *   2. sessionGet(mainPageUrl, sessionId)  → visit main page, CF challenge solved, cookie stored in session
 *   3. sessionGet(apiUrl, sessionId)       → API call reuses same Chrome instance + cookie → works
 *   4. destroySession(sessionId)
 *
 * Convenience: flareSolverrGetWithPrimer(apiUrl, primerUrl) handles all steps automatically.
 *
 * API reference:
 *   POST /v1  { cmd: "sessions.create" }                          → { session: ID }
 *   POST /v1  { cmd: "request.get", url, session: ID }            → standard response
 *   POST /v1  { cmd: "sessions.destroy", session: ID }            → { status: "ok" }
 */

const axios = require('axios');
const { createLogger } = require('./logger');

const log = createLogger('flaresolverr');

const MAX_TIMEOUT = Number(process.env.FLARESOLVERR_MAX_TIMEOUT) || 55_000;
const KISSKH_PRIMER = 'https://kisskh.co/';

/**
 * Check whether a FlareSolverr URL is configured.
 * @returns {string|null}
 */
function getFlareSolverrUrl() {
  return (process.env.FLARESOLVERR_URL || '').trim() || null;
}

/** Internal POST to FlareSolverr /v1 */
async function _post(payload, extraTimeoutMs = 0) {
  const baseUrl = getFlareSolverrUrl();
  if (!baseUrl) return null;
  const endpoint = baseUrl.replace(/\/$/, '') + '/v1';
  try {
    const { data } = await axios.post(endpoint, payload, {
      timeout: MAX_TIMEOUT + extraTimeoutMs + 5_000,
      headers: { 'Content-Type': 'application/json' },
    });
    return data;
  } catch (err) {
    log.error(`FlareSolverr _post error: ${err.message}`, { cmd: payload.cmd });
    return null;
  }
}

// ─── Session management ───────────────────────────────────────────────────────

/**
 * Create a persistent browser session in FlareSolverr.
 * Returns session ID string, or null on failure.
 */
async function createSession() {
  const data = await _post({ cmd: 'sessions.create' });
  if (data?.status !== 'ok' || !data?.session) {
    log.warn('createSession failed', { status: data?.status, msg: data?.message });
    return null;
  }
  log.debug(`session created: ${data.session}`);
  return data.session;
}

/**
 * Destroy a browser session. Fire-and-forget.
 */
async function destroySession(sessionId) {
  if (!sessionId) return;
  await _post({ cmd: 'sessions.destroy', session: sessionId }).catch(() => {});
  log.debug(`session destroyed: ${sessionId}`);
}

/**
 * Make a GET request within an existing session.
 * Returns the response body string, or null.
 * @param {string} url
 * @param {string} sessionId
 * @param {object} [headers]  — optional custom headers (e.g. { Accept: 'application/json' })
 */
async function sessionGet(url, sessionId, headers) {
  log.info(`sessionGet [${sessionId?.slice(0, 8)}] ${url.slice(0, 100)}`);
  const payload = { cmd: 'request.get', url, session: sessionId, maxTimeout: MAX_TIMEOUT };
  if (headers && Object.keys(headers).length) payload.headers = headers;
  const data = await _post(payload);
  if (data?.status !== 'ok') {
    log.warn(`sessionGet not ok: ${data?.status} — ${data?.message}`);
    return null;
  }
  const httpStatus = data?.solution?.status;
  const body       = data?.solution?.response || '';
  log.info(`sessionGet solved (http=${httpStatus}, bodyLen=${body.length})`);
  if (httpStatus && httpStatus >= 400) {
    log.warn(`sessionGet HTTP ${httpStatus}`);
    return null;
  }
  return body;
}

// ─── High-level helpers ───────────────────────────────────────────────────────

/**
 * Fetch `apiUrl` as JSON after first visiting `primerUrl` to obtain cf_clearance.
 * Uses a FlareSolverr session so both requests share the same Chrome instance + cookies.
 *
 * @param {string} apiUrl
 * @param {string} [primerUrl]  — defaults to kisskh.co homepage
 * @returns {Promise<object|null>}
 */
async function flareSolverrGetJSONWithPrimer(apiUrl, primerUrl = KISSKH_PRIMER) {
  if (!getFlareSolverrUrl()) {
    log.debug('FlareSolverr not configured');
    return null;
  }

  const sessionId = await createSession();
  if (!sessionId) return null;

  try {
    // Step 1: visit the main page — CF challenge is solved here and cookie stored in session
    log.info(`primer visit: ${primerUrl}`);
    const primerBody = await sessionGet(primerUrl, sessionId);
    if (!primerBody) {
      log.warn('primer visit returned null — CF may have hard-blocked Railway IP');
      return null;
    }
    // Detect actual CF challenge page (narrow patterns to avoid false positives on Angular pages)
    const isCFBlock =
      primerBody.includes('Just a moment') ||
      primerBody.includes('Checking your browser') ||
      primerBody.includes('cf-browser-verification') ||
      primerBody.includes('data-cf-challenge') ||
      (primerBody.includes('www.cloudflare.com') && primerBody.length < 50_000);
    if (isCFBlock) {
      log.warn(`primer: CF challenge NOT resolved (bodyLen=${primerBody.length})`);
      return null;
    }
    log.info(`primer: CF challenge resolved ✓ (bodyLen=${primerBody.length})`);

    // Step 2: fetch the API endpoint within the same session
    // Pass JSON Accept headers so the server returns JSON instead of the Angular app HTML
    const JSON_HEADERS = {
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://kisskh.co/',
      'Origin': 'https://kisskh.co',
      'X-Requested-With': 'XMLHttpRequest',
    };
    const body = await sessionGet(apiUrl, sessionId, JSON_HEADERS);
    if (!body) return null;

    return _parseBody(body);
  } finally {
    destroySession(sessionId); // fire-and-forget cleanup
  }
}

/**
 * Parse a response body from FlareSolverr/Chrome into a JS object.
 * Chrome wraps JSON API responses in an HTML document with a <pre> tag:
 *   <html><body><pre>{"data":[...]}</pre></body></html>
 * We try raw JSON first, then strip HTML.
 */
function _parseBody(body) {
  if (!body) return null;

  // 1. Raw JSON (ideal)
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch {}
  }

  // 2. Chrome JSON viewer: content is inside the first <pre> tag
  const preMatch = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch) {
    try { return JSON.parse(preMatch[1]); } catch {}
  }

  // 3. Strip ALL tags
  const stripped = trimmed.replace(/<[^>]+>/g, '').trim();
  try { return JSON.parse(stripped); } catch {}

  // 4. Still CF challenge?
  if (trimmed.includes('Just a moment') || trimmed.includes('Checking your browser')) {
    log.warn('Body is still a CF challenge after primer');
  } else {
    log.warn(`Body is not JSON (length=${body.length}, preview=${body.slice(0,100)})`);
  }
  return null;
}

/**
 * Legacy single-request helper (no session, no primer).
 * Use flareSolverrGetJSONWithPrimer for kisskh.co instead.
 */
async function flareSolverrGet(url, timeout = MAX_TIMEOUT) {
  const baseUrl = getFlareSolverrUrl();
  if (!baseUrl) return null;
  const endpoint = baseUrl.replace(/\/$/, '') + '/v1';
  log.info(`flareSolverrGet ${url.slice(0, 100)}`);
  try {
    const { data } = await axios.post(endpoint, {
      cmd: 'request.get', url, maxTimeout: timeout,
    }, { timeout: timeout + 5_000, headers: { 'Content-Type': 'application/json' } });
    if (data?.status !== 'ok') return null;
    const httpStatus = data?.solution?.status;
    const body       = data?.solution?.response || '';
    if (httpStatus && httpStatus >= 400) return null;
    return body;
  } catch (err) {
    log.error(`flareSolverrGet failed: ${err.message}`);
    return null;
  }
}

async function flareSolverrGetJSON(url) {
  const body = await flareSolverrGet(url);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

module.exports = {
  getFlareSolverrUrl,
  // Session API
  createSession, destroySession, sessionGet,
  // High-level
  flareSolverrGetJSONWithPrimer,
  // Legacy
  flareSolverrGet, flareSolverrGetJSON,
};
