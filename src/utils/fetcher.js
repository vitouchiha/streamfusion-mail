'use strict';

/**
 * Shared HTTP fetcher utilities
 * Provides:
 *   - fetchWithCloudscraper(): for sites behind Cloudflare (ramaorientalfansub.live)
 *   - fetchWithAxios():        for plain HTTPS endpoints (kisskh.co API)
 *   - withTimeout():           generic promise timeout wrapper
 *   - getProxyAgent():         returns HttpsProxyAgent if PROXY_URL env is set
 *
 * Proxy support:
 *   Set PROXY_URL env variable to a proxy URL, e.g.:
 *   - http://user:pass@host:port
 *   - socks5://user:pass@host:port
 *   This is required when deploying on Vercel/AWS (IPs blocked by Cloudflare on target sites).
 */

const cloudscraper = require('cloudscraper');
const axios = require('axios');
const { createLogger } = require('./logger');

const log = createLogger('fetcher');

// ─── Proxy support ────────────────────────────────────────────────────────────

let _proxyAgent = null;
let _proxyUrl = null;

function getProxyAgent() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) return null;
  if (_proxyAgent && _proxyUrl === proxyUrl) return _proxyAgent;

  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    _proxyAgent = new HttpsProxyAgent(proxyUrl);
    _proxyUrl = proxyUrl;
    log.info('Proxy configured', { url: proxyUrl.replace(/:[^:@]+@/, ':***@') });
    return _proxyAgent;
  } catch (e) {
    log.warn('https-proxy-agent not available, proxy disabled');
    return null;
  }
}

// ─── User agents ─────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Fetch HTML via cloudscraper (bypasses basic Cloudflare JS challenges).
 * @param {string} url
 * @param {object}  [opts]
 * @param {number}  [opts.retries=3]
 * @param {number}  [opts.timeout=12000]   Per-attempt timeout ms
 * @param {number}  [opts.retryDelay=2000]
 * @param {string}  [opts.referer]
 * @returns {Promise<string|null>}
 */
async function fetchWithCloudscraper(url, { retries = 3, timeout = 12_000, retryDelay = 2_000, referer } = {}) {
  const proxyUrl = process.env.PROXY_URL || null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log.debug(`Attempt ${attempt}/${retries} — ${url}`);
      const reqOpts = {
        uri: url,
        headers: {
          'User-Agent': randomUA(),
          'Referer': referer || url,
          'Accept-Language': 'en-US,en;q=0.9',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Connection': 'keep-alive',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        followAllRedirects: true,
        maxRedirects: 3,
        timeout,
        resolveWithFullResponse: true,
      };
      if (proxyUrl) reqOpts.proxy = proxyUrl;

      const response = await cloudscraper.get(reqOpts);

      if (response.statusCode === 404) {
        log.warn(`404 not found — ${url}`);
        return null;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        log.debug(`OK ${response.statusCode} — ${url}`);
        return response.body;
      }
      log.warn(`HTTP ${response.statusCode} — ${url}, retrying`);
      await _sleep(retryDelay);
    } catch (err) {
      log.warn(`Error attempt ${attempt}/${retries}: ${err.message}`, { url });
      const delay = err.message.toLowerCase().includes('cloudflare') ? 10_000 : retryDelay;
      if (attempt < retries) await _sleep(delay);
    }
  }
  log.error(`All ${retries} attempts failed — ${url}`);
  return null;
}

/**
 * Fetch JSON / text via axios (proxy-aware).
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeout=10000]
 * @param {'json'|'text'|'arraybuffer'} [opts.responseType='json']
 * @param {number} [opts.retries=2]
 * @returns {Promise<any|null>}
 */
async function fetchWithAxios(url, { headers = {}, timeout = 10_000, responseType = 'json', retries = 2 } = {}) {
  const mergedHeaders = {
    'User-Agent': randomUA(),
    'Accept': 'application/json, text/plain, */*',
    ...headers,
  };
  const proxyAgent = getProxyAgent();
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(url, {
        headers: mergedHeaders,
        timeout,
        responseType,
        ...(proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {}),
      });
      return data;
    } catch (err) {
      log.warn(`axios attempt ${attempt}/${retries}: ${err.message}`, { url });
      if (attempt < retries) await _sleep(2_000);
    }
  }
  log.error(`axios failed after ${retries} attempts — ${url}`);
  return null;
}

/**
 * Wrap a promise with a timeout.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms — ${label}`)), ms);
    promise
      .then(v => { clearTimeout(timer); resolve(v); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { fetchWithCloudscraper, fetchWithAxios, withTimeout, randomUA, getProxyAgent };
