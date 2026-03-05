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
 */
async function sessionGet(url, sessionId) {
  log.info(`sessionGet [${sessionId?.slice(0, 8)}] ${url.slice(0, 100)}`);
  const data = await _post({ cmd: 'request.get', url, session: sessionId, maxTimeout: MAX_TIMEOUT });
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

    // Step 2: fetch the API endpoint within the same session (cookies already present)
    const body = await sessionGet(apiUrl, sessionId);
    if (!body) return null;

    try {
      return JSON.parse(body);
    } catch {
      if (body.includes('<html') || body.includes('Just a moment')) {
        log.warn('API response is CF HTML, not JSON');
        return null;
      }
      log.warn('API response is not valid JSON');
      return null;
    }
  } finally {
    destroySession(sessionId); // fire-and-forget cleanup
  }
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
