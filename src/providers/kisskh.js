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
const { withTimeout, makeProxyAgent, getProxyAgent } = require('../utils/fetcher');
const { wrapStreamUrl } = require('../utils/mediaflow');
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
async function _apiGet(url, timeout = 8_000, proxyUrl) {
  const proxyAgent = proxyUrl ? makeProxyAgent(proxyUrl) : getProxyAgent();
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
async function getCatalog(skip = 0, search = '', config = {}) {
  const cacheKey = `catalog:${skip}:${search}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) {
    log.debug('catalog from cache');
    return cached;
  }

  const page = Math.floor(skip / 20) + 1;
  const items = search.trim()
    ? await _searchCatalog(search.trim(), 20, config.proxyUrl)
    : await _listCatalog(page, 20, config.proxyUrl);

  catalogCache.set(cacheKey, items);
  return items;
}

async function _listCatalog(page, limit, proxyUrl) {
  const url = `${API_BASE}/DramaList/List?page=${page}&type=1&sub=0&country=2&status=2&order=3&pageSize=${limit}`;
  log.info('list catalog', { url });
  const data = await _apiGet(url, 8_000, proxyUrl);
  if (!data || !data.data) return [];
  return data.data.map(_mapItem);
}

async function _searchCatalog(query, limit = 20, proxyUrl) {
  const cleanQuery = cleanTitleForSearch(query);
  const allResults = [];
  let currentPage = 1;
  const maxPages = 10;
  let emptyPages = 0;

  while (allResults.length < limit && currentPage <= maxPages && emptyPages < 3) {
    const url = `${API_BASE}/DramaList/List?page=${currentPage}&type=1&sub=0&country=2&status=2&order=3&pageSize=30&search=${encodeURIComponent(query)}`;
    try {
      const data = await _apiGet(url, 8_000, proxyUrl);
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
async function getMeta(id, config = {}) {
  const cached = metaCache.get(id);
  if (cached) {
    log.debug('meta from cache', { id });
    return { meta: cached };
  }

  const serieId = id.replace(/^kisskh_/, '');
  const url = `${API_BASE}/DramaList/Drama/${serieId}?isq=false`;
  log.info('fetching meta', { id, url });

  try {
    const data = await _apiGet(url, 8_000, config.proxyUrl);
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
async function getStreams(stremioId, config = {}) {
  const [seriesPart, episodePart] = stremioId.split(':');
  const serieId = seriesPart.replace(/^kisskh_/, '');
  const episodeId = episodePart ? extractEpisodeNumericId(episodePart) : null;

  if (!episodeId) {
    log.warn('no episodeId in stremioId', { stremioId });
    return [];
  }

  const cacheKey = `stream:${serieId}:${episodeId}`;
  const cached = streamCache.get(cacheKey);

  // Cache stores { url, subtitles } (raw, unwrapped) so MFP wrapping is per-request
  let rawUrl, subtitles;
  if (cached) {
    log.debug('stream from cache', { cacheKey });
    rawUrl = cached.url;
    subtitles = cached.subtitles;
  } else {
    log.info('extracting stream+subs via browser', { serieId, episodeId });
    const { streamUrl: extractedUrl, subApiUrl } = await _extractStreamAndSubs(serieId, episodeId);
    rawUrl = extractedUrl;
    if (!rawUrl) {
      log.warn('no stream found', { serieId, episodeId });
      return [];
    }
    // Get subtitles from sub API URL (no second browser needed)
    subtitles = await _getSubtitlesFromApiUrl(subApiUrl, serieId, episodeId);
    streamCache.set(cacheKey, { url: rawUrl, subtitles });
  }

  // Wrap stream URL through MediaFlow Proxy if configured
  const finalUrl = wrapStreamUrl(rawUrl, config, {
    'Referer': SITE_BASE + '/',
    'Origin': SITE_BASE,
  });

  return [
    {
      name: 'KissKH',
      title: `Episode ${episodeId}`,
      url: finalUrl,
      subtitles,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `streamfusion-kisskh-${seriesPart}`,
      },
    },
  ];
}

// ─── Combined stream + subtitle extraction (single browser session) ───────────

/**
 * Opens ONE browser session on the episode page and intercepts BOTH the HLS
 * stream URL (*.m3u8?v=…) and the subtitle API endpoint (/api/Sub/…).
 * Returns as soon as both are found or after STREAM_MAX_WAIT ms.
 *
 * @param {string} serieId
 * @param {string|number} episodeId
 * @returns {Promise<{streamUrl:string|null, subApiUrl:string|null}>}
 */
async function _extractStreamAndSubs(serieId, episodeId) {
  const MAX_WAIT = Number(process.env.STREAM_MAX_WAIT) || 40_000; // ms
  const browser = await launchBrowser();
  let streamUrl = null;
  let subApiUrl = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Authenticate with proxy if PROXY_URL is set (credential from URL like http://user:pass@host:port)
    const proxyUrl = (process.env.PROXY_URL || '').trim();
    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        if (u.username && u.password) {
          await page.authenticate({ username: u.username, password: u.password });
          log.debug('proxy authentication set for page');
        }
      } catch (_) { /* ignore parse errors */ }
    }

    // Inject CF clearance cookie
    const cfCookieStr = await getCloudflareCookie().catch(() => '');
    if (cfCookieStr) {
      const cfVal = cfCookieStr.replace(/^cf_clearance=/, '');
      await page.setCookie({ name: 'cf_clearance', value: cfVal, domain: 'kisskh.co', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    }

    // Block heavy resources; intercept m3u8 + sub API
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(rt)) {
        req.abort().catch(() => {});
        return;
      }
      const u = req.url();
      const rt2 = req.resourceType();
      // Log XHR/fetch to debug what endpoints are called
      if (!streamUrl && (rt2 === 'xhr' || rt2 === 'fetch' || u.includes('.m3u8') || u.includes('stream') || u.includes('video'))) {
        log.debug(`[intercept] ${rt2} ${u.slice(0, 120)}`);
      }
      // Intercept ANY HLS stream URL (not just ?v= format — format may have changed)
      if (!streamUrl && /\.m3u8/i.test(u)) {
        streamUrl = u;
        log.info(`intercepted stream: ${u.slice(0, 120)}`);
      }
      // Intercept subtitle API endpoint
      if (!subApiUrl && u.includes('/api/Sub/')) {
        subApiUrl = u;
        log.debug(`intercepted sub API: ${u.slice(0, 120)}`);
      }
      req.continue().catch(() => {});
    });

    const targetUrl = `${SITE_BASE}/Drama/Any/Episode-Any?id=${serieId}&ep=${episodeId}`;
    log.info('navigating to episode page', { targetUrl });

    // Use 'load' + manual wait so we can exit early once both URLs found
    await page.goto(targetUrl, { waitUntil: 'load', timeout: MAX_WAIT }).catch((e) => {
      log.warn(`page.goto warning: ${e.message.slice(0, 80)}`);
    });

    // Log actual URL + title to verify we're on the right page (not a CF challenge)
    try {
      const finalUrl = page.url();
      const title = await page.title().catch(() => '');
      log.info('page loaded', { finalUrl: finalUrl.slice(0, 100), title: title.slice(0, 60) });
    } catch (_) {}

    // Poll until both found or timeout
    const deadline = Date.now() + MAX_WAIT;
    while (Date.now() < deadline && !(streamUrl && subApiUrl)) {
      await _sleep(500);
    }

    log.info('extraction done', { streamFound: !!streamUrl, subFound: !!subApiUrl });
  } catch (err) {
    log.error(`browser extraction error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  return { streamUrl, subApiUrl };
}

async function _extractStream(serieId, episodeId) {
  const { streamUrl } = await _extractStreamAndSubs(serieId, episodeId);
  return streamUrl;
}

// ─── Subtitle extraction ───────────────────────────────────────────────────────

/**
 * Fetch & decrypt subtitles given an already-intercepted sub API URL.
 * No browser is launched here.
 */
async function _getSubtitlesFromApiUrl(subApiUrl, serieId, episodeId) {
  const cacheKey = `sub:${serieId}:${episodeId}`;
  const cached = subCache.get(cacheKey);
  if (cached) return cached;

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

/** Backward-compat wrapper: opens browser to get subApiUrl, then extracts subs */
async function _getSubtitles(serieId, episodeId) {
  const { subApiUrl } = await _extractStreamAndSubs(serieId, episodeId);
  return _getSubtitlesFromApiUrl(subApiUrl, serieId, episodeId);
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
