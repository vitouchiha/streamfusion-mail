'use strict';

/**
 * KissKH provider
 * Source: https://kisskh.co
 *
 * Provides:
 *   - getCatalog(skip, search)   → [{id, type, name, poster, ...}]
 *   - getMeta(id)                → {meta}
 *   - getStreams(id, episodeId)  → [{title, url, subtitles, behaviorHints}]
 *
 * Stream extraction uses Puppeteer + stealth to intercept .m3u8 requests
 * that include the 'v' parameter required by kisskh's CDN.
 */

const axios = require('axios');
const { launchBrowser } = require('../utils/browser');
const { getCloudflareCookie } = require('../utils/cloudflare');
const { decryptKisskhSubtitleFull, decryptKisskhSubtitleStatic } = require('../utils/subDecrypter');
const { TTLCache } = require('../utils/cache');
const { cleanTitleForSearch, titleSimilarity, extractEpisodeNumericId } = require('../utils/titleHelper');
const { withTimeout, getProxyAgent } = require('../utils/fetcher');
const { createLogger } = require('../utils/logger');

const log = createLogger('kisskh');

const API_BASE = 'https://kisskh.co/api';
const SITE_BASE = 'https://kisskh.co';

const catalogCache = new TTLCache({ ttl: 10 * 60_000, maxSize: 200 });
const metaCache    = new TTLCache({ ttl: 30 * 60_000, maxSize: 500 });
const streamCache  = new TTLCache({ ttl: 2 * 60 * 60_000, maxSize: 1000 });
const subCache     = new TTLCache({ ttl: 24 * 60 * 60_000, maxSize: 500 });

// ─── Shared axios headers ─────────────────────────────────────────────────────

/** Base headers without CF cookie — fast, no Puppeteer */
function _baseHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': SITE_BASE + '/',
    'Origin': SITE_BASE,
  };
}

/** Full headers with CF cookie — slow, used only when base headers get 403 */
async function _headers() {
  const cookie = await withTimeout(getCloudflareCookie(), 3_500, 'cf-cookie').catch(() => '');
  return { ..._baseHeaders(), ...(cookie ? { 'Cookie': cookie } : {}) };
}

/**
 * GET helper: tries without CF cookie first, retries with CF cookie on any failure.
 * @param {string} url
 * @param {number} [timeout=8000]
 * @returns {Promise<any|null>}
 */
async function _apiGet(url, timeout = 8_000) {
  const proxyAgent = getProxyAgent();
  const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent, proxy: false } : {};
  try {
    const { data } = await axios.get(url, { headers: _baseHeaders(), timeout, ...proxyConfig });
    return data;
  } catch (err) {
    const status = err?.response?.status;
    log.warn(`API call failed (status=${status ?? 'network'}) without CF cookie, retrying with cookie`, { url });
    // Always retry with CF cookie on any failure
    try {
      const headers = await _headers();
      const { data } = await axios.get(url, { headers, timeout, ...proxyConfig });
      return data;
    } catch (err2) {
      log.error(`API call failed even with CF cookie: ${err2.message}`, { url });
      return null;
    }
  }
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

/**
 * @param {number} [skip=0]
 * @param {string} [search='']
 * @returns {Promise<Array>}
 */
async function getCatalog(skip = 0, search = '') {
  const cacheKey = `catalog:${skip}:${search}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) {
    log.debug('catalog from cache');
    return cached;
  }

  const page = Math.floor(skip / 20) + 1;
  const items = search.trim()
    ? await _searchCatalog(search.trim(), 20)
    : await _listCatalog(page, 20);

  catalogCache.set(cacheKey, items);
  return items;
}

async function _listCatalog(page, limit) {
  const url = `${API_BASE}/DramaList/List?page=${page}&type=1&sub=0&country=2&status=2&order=3&pageSize=${limit}`;
  log.info('list catalog', { url });
  const data = await _apiGet(url);
  if (!data || !data.data) return [];
  return data.data.map(_mapItem);
}

async function _searchCatalog(query, limit = 20) {
  const cleanQuery = cleanTitleForSearch(query);
  const allResults = [];
  let currentPage = 1;
  const maxPages = 10;
  let emptyPages = 0;

  while (allResults.length < limit && currentPage <= maxPages && emptyPages < 3) {
    const url = `${API_BASE}/DramaList/List?page=${currentPage}&type=1&sub=0&country=2&status=2&order=3&pageSize=30&search=${encodeURIComponent(query)}`;
    try {
      const data = await _apiGet(url);
      if (!data || !data.data || !data.data.length) { emptyPages++; currentPage++; continue; }

      const pageItems = data.data
        .map(_mapItem)
        .filter(item => titleSimilarity(item.name, cleanQuery) > 0.3
          || cleanTitleForSearch(item.name).includes(cleanQuery));

      if (pageItems.length === 0) emptyPages++;
      else emptyPages = 0;

      allResults.push(...pageItems);
    } catch (err) {
      log.warn(`search page ${currentPage} failed: ${err.message}`);
      break;
    }
    currentPage++;
  }

  // Deduplicate
  const seen = new Set();
  return allResults.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; }).slice(0, limit);
}

function _mapItem(item) {
  return {
    id: `kisskh_${item.id}`,
    type: 'series',
    name: item.title,
    poster: item.thumbnail,
    posterShape: 'poster',
    releaseInfo: item.releaseDate ? item.releaseDate.slice(0, 4) : '',
  };
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} id  e.g. "kisskh_1234"
 * @returns {Promise<{meta: object}>}
 */
async function getMeta(id) {
  const cached = metaCache.get(id);
  if (cached) {
    log.debug('meta from cache', { id });
    return { meta: cached };
  }

  const serieId = id.replace(/^kisskh_/, '');
  const url = `${API_BASE}/DramaList/Drama/${serieId}?isq=false`;
  log.info('fetching meta', { id, url });

  try {
    const data = await _apiGet(url);
    if (!data) return { meta: null };

    const meta = {
      id,
      type: 'series',
      name: data.title,
      poster: data.thumbnail,
      description: data.description || '',
      releaseInfo: data.releaseDate ? data.releaseDate.slice(0, 4) : '',
      serieId,
      videos: (data.episodes || []).map((ep, idx) => ({
        id: `${id}:${ep.id}`,
        title: ep.title || `Episode ${ep.number || idx + 1}`,
        season: Number(ep.season) || 1,
        episode: Number(ep.episode || ep.number || idx + 1),
        thumbnail: data.thumbnail,
        released: ep.releaseDate || '',
      })),
    };

    metaCache.set(id, meta);
    return { meta };
  } catch (err) {
    log.error(`getMeta failed: ${err.message}`, { id });
    return { meta: null };
  }
}

// ─── Stream ───────────────────────────────────────────────────────────────────

/**
 * Returns streams for a series:episode combination.
 * @param {string} stremioId  e.g. "kisskh_1234:5678"
 * @returns {Promise<Array>}
 */
async function getStreams(stremioId) {
  const [seriesPart, episodePart] = stremioId.split(':');
  const serieId = seriesPart.replace(/^kisskh_/, '');
  const episodeId = episodePart ? extractEpisodeNumericId(episodePart) : null;

  if (!episodeId) {
    log.warn('no episodeId in stremioId', { stremioId });
    return [];
  }

  const cacheKey = `stream:${serieId}:${episodeId}`;
  const cached = streamCache.get(cacheKey);
  if (cached) {
    log.debug('stream from cache', { cacheKey });
    return cached;
  }

  log.info('extracting stream via puppeteer', { serieId, episodeId });
  const streamUrl = await _extractStream(serieId, episodeId);

  if (!streamUrl) {
    log.warn('no stream found', { serieId, episodeId });
    return [];
  }

  // Attempt to get Italian subtitles
  const subtitles = await _getSubtitles(serieId, episodeId);

  const streams = [
    {
      name: 'KissKH',
      title: `Episode ${episodeId}`,
      url: streamUrl,
      subtitles,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `streamfusion-kisskh-${seriesPart}`,
      },
    },
  ];

  streamCache.set(cacheKey, streams);
  return streams;
}

// ─── Puppeteer stream extraction ──────────────────────────────────────────────

async function _extractStream(serieId, episodeId) {
  const browser = await launchBrowser();
  let streamUrl = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Inject CF clearance cookie
    const cfCookieStr = await getCloudflareCookie().catch(() => '');
    if (cfCookieStr) {
      const cfVal = cfCookieStr.replace(/^cf_clearance=/, '');
      await page.setCookie({ name: 'cf_clearance', value: cfVal, domain: 'kisskh.co', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    }

    // Block heavy resources to speed up navigation
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image', 'font', 'stylesheet'].includes(rt)) {
        req.abort();
      } else {
        // Intercept .m3u8 with v param
        const u = req.url();
        if (/^https:\/\/.*\.m3u8/.test(u) && /[?&]v=[a-zA-Z0-9]+/.test(u)) {
          streamUrl = u;
          log.info(`intercepted stream: ${u.slice(0, 80)}`);
        }
        req.continue();
      }
    });

    const targetUrl = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
    log.debug('navigating to', { targetUrl });
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    await _sleep(6_000);
  } catch (err) {
    log.error(`puppeteer stream extraction error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  return streamUrl;
}

// ─── Subtitle extraction ───────────────────────────────────────────────────────

async function _getSubtitles(serieId, episodeId) {
  const cacheKey = `sub:${serieId}:${episodeId}`;
  const cached = subCache.get(cacheKey);
  if (cached) return cached;

  const browser = await launchBrowser();
  let subApiUrl = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    page.on('request', req => {
      const u = req.url();
      if (!subApiUrl && u.includes('/api/Sub/')) {
        subApiUrl = u;
        log.debug('intercepted subtitle API', { subApiUrl });
      }
      req.continue().catch(() => {});
    });

    await page.setRequestInterception(true);

    const cfCookieStr = await getCloudflareCookie().catch(() => '');
    if (cfCookieStr) {
      const cfVal = cfCookieStr.replace(/^cf_clearance=/, '');
      await page.setCookie({ name: 'cf_clearance', value: cfVal, domain: 'kisskh.co', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    }

    await page.goto(`${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`, { waitUntil: 'networkidle2', timeout: 60_000 });

    // Wait for subtitle endpoint intercept
    for (let i = 0; i < 20 && !subApiUrl; i++) await _sleep(500);
  } catch (err) {
    log.warn(`subtitle intercept error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  if (!subApiUrl) {
    log.warn('no subtitle API endpoint found', { serieId, episodeId });
    return [];
  }

  const headers = await _headers();
  let subtitleList;
  try {
    const resp = await axios.get(subApiUrl, { headers, timeout: 10_000, responseType: 'json' });
    subtitleList = Array.isArray(resp.data) ? resp.data : [resp.data];
  } catch (err) {
    log.warn(`subtitle API request failed: ${err.message}`);
    return [];
  }

  // Filter Italian
  const ITALIAN_PATTERN = /^https?:\/\/.*\.it\.(srt|txt1|txt)$/i;
  const itSubs = subtitleList.filter(s => {
    const lang = (s.land || s.label || '').toLowerCase();
    const src = _resolveSubUrl(s);
    return lang === 'it' || lang === 'italian' || (src && ITALIAN_PATTERN.test(src));
  });

  const decoded = [];
  const H = await _headers();
  const STATIC_KEY = Buffer.from('AmSmZVcH93UQUezi');
  const STATIC_IV  = Buffer.from('ReBKWW8cqdjPEnF6');

  for (const sub of itSubs) {
    const subUrl = _resolveSubUrl(sub);
    if (!subUrl) continue;
    try {
      const sresp = await axios.get(subUrl, { responseType: 'arraybuffer', headers: H, timeout: 10_000 });
      const buf = Buffer.from(sresp.data);
      const isEncrypted = /\.(txt1|txt)$/i.test(subUrl);
      let content;

      if (isEncrypted) {
        const asText = buf.toString('utf8').trim();
        content = asText.startsWith('1') || asText.startsWith('WEBVTT')
          ? decryptKisskhSubtitleFull(asText)
          : decryptKisskhSubtitleStatic(buf, STATIC_KEY, STATIC_IV);
      } else {
        content = buf.toString('utf8');
      }

      if (content && /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}/.test(content)) {
        decoded.push({ lang: 'it', content });
        log.info('Italian subtitle decoded', { subUrl: subUrl.slice(0, 60) });
        break; // First valid subtitle is enough
      }
    } catch (err) {
      log.warn(`subtitle fetch/decrypt error: ${err.message}`);
    }
  }

  subCache.set(cacheKey, decoded);
  return decoded;
}

function _resolveSubUrl(s) {
  if (s.src) return s.src;
  if (s.GET && s.GET.host && s.GET.filename) {
    let u = `${s.GET.scheme || 'https'}://${s.GET.host}${s.GET.filename}`;
    if (s.GET.query && s.GET.query.v) u += `?v=${s.GET.query.v}`;
    return u;
  }
  return null;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { getCatalog, getMeta, getStreams };
