'use strict';

/**
 * Guardaserie provider
 * Source: https://guardaserie.re  (mirrors: guardaserie.fm, guardaserie.cloud)
 *
 * Italian streaming aggregator — large catalog of K-drama and Asian series
 * with Italian audio / Italian subs hosted on external hosters
 * (DropLoad, SuperVideo, Streamtape, Vixcloud, MaxStream, etc.)
 *
 * Site is Cloudflare-protected — bypass via cloudscraper (same as Rama).
 *
 * Provides:
 *   - getCatalog(skip, search)  → [{id, type, name, poster, ...}]
 *   - getMeta(id)               → {meta}
 *   - getStreams(id)             → [{name, description, url, behaviorHints}]
 */

// Removed: Guardaserie legacy provider is no longer used.
const { fetchWithCloudscraper } = require('../utils/fetcher');
const { TTLCache } = require('../utils/cache');
const { wrapStreamUrl } = require('../utils/mediaflow');
const { enrichFromTmdb, rpdbPosterUrl } = require('../utils/tmdb');
const { createLogger } = require('../utils/logger');

const log = createLogger('guardaserie');

// Mirror list — the addon tries each in order until one works
const BASE_URLS = [
  'https://guardaserie.re',
  'https://guardaserie.fm',
  'https://guardaserie.cloud',
  'https://guardaserie.cx',
];

// Korean-drama / Asian-drama category paths to try
const CATALOG_PATHS = [
  '/serie-tv/',
  '/drama/',
  '/k-drama/',
  '/asian-drama/',
  '/streaming/',
  '/',
];

const ITEMS_PER_PAGE = 20;
const MAX_PAGES = 30;

const catalogCache = new TTLCache({ ttl: 10 * 60_000, maxSize: 200 });
const metaCache    = new TTLCache({ ttl: 30 * 60_000, maxSize: 500 });
const streamCache  = new TTLCache({ ttl: 60 * 60_000, maxSize: 1000 });

// Runtime-detected base URL and catalog path (persisted in module scope)
let _baseUrl = null;
let _catalogPath = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _fetch(url, config = {}) {
  return fetchWithCloudscraper(url, { referer: _baseUrl || BASE_URLS[0], proxyUrl: config.proxyUrl });
}

/**
 * Detect an accessible mirror URL by trying all BASE_URLS.
 */
async function _detectBaseUrl(config) {
  if (_baseUrl) return _baseUrl;
  for (const base of BASE_URLS) {
    log.info(`trying mirror: ${base}`);
    const html = await fetchWithCloudscraper(base + '/', { referer: base, proxyUrl: config.proxyUrl }).catch(() => null);
    if (html && html.length > 200) {
      log.info(`mirror OK: ${base}`);
      _baseUrl = base;
      return base;
    }
  }
  return null;
}

/**
 * Detect which catalog path has drama cards.
 */
async function _detectCatalogPath(base, config) {
  if (_catalogPath) return _catalogPath;
  for (const path of CATALOG_PATHS) {
    const url = `${base}${path}`;
    const html = await fetchWithCloudscraper(url, { referer: base, proxyUrl: config.proxyUrl }).catch(() => null);
    if (!html) continue;
    const $ = cheerio.load(html);
    const cards = _extractCards($, base);
    if (cards.length > 3) {
      log.info(`catalog path detected: ${path} (${cards.length} cards)`);
      _catalogPath = path;
      return path;
    }
  }
  return CATALOG_PATHS[0];
}

/**
 * Extract series cards from a Guardaserie page.
 * Handles the most common Italian aggregator card layouts.
 */
function _extractCards($, base) {
  const items = [];
  const seen  = new Set();

  // Strategy 1: standard series/drama article cards
  const articleSelectors = [
    'article.tvshow',
    'article.serie',
    'article.drama',
    'article.post',
    '.tvshow-card',
    '.serie-card',
    '.drama-card',
    '.film-card',
    '.entry-item',
  ];

  for (const sel of articleSelectors) {
    $(sel).each((_, el) => {
      const $el  = $(el);
      const $a   = $el.find('a[href]').first();
      const href = $a.attr('href') || '';
      if (!href) return;

      const slug = href.replace(/\/$/, '').split('/').pop();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const $img   = $el.find('img').first();
      const poster = $img.attr('data-src') || $img.attr('src') || '';
      const title  = ($el.find('.title, h2, h3, .film-name, .tvshow-name').first().text().trim()
        || $a.attr('title')
        || $img.attr('alt')
        || slug.replace(/-/g, ' ')).replace(/\s*\(\d{4}\)\s*$/, '').trim();

      if (!title) return;
      items.push({
        id: `guardaserie_${slug}`,
        type: 'kdrama',
        name: title,
        poster,
        posterShape: 'poster',
      });
    });
    if (items.length >= 5) break;
  }

  // Strategy 2: any link with Italian drama patterns in href
  if (items.length < 3) {
    $('a[href*="/tvshow/"], a[href*="/serie/"], a[href*="/drama/"], a[href*="/streaming/"]').each((_, el) => {
      const $el  = $(el);
      const href = $el.attr('href') || '';
      const slug = href.replace(/\/$/, '').split('/').pop();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const $img   = $el.find('img').first();
      const poster = $img.attr('data-src') || $img.attr('src') || '';
      const title  = ($el.attr('title') || $img.attr('alt') || $el.text().trim() || slug.replace(/-/g, ' '))
        .replace(/\s*\(\d{4}\)\s*$/, '').trim();

      if (!title || title.length > 120) return;
      items.push({
        id: `guardaserie_${slug}`,
        type: 'kdrama',
        name: title,
        poster,
        posterShape: 'poster',
      });
    });
  }

  return items;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

/**
 * @param {number} [skip=0]
 * @param {string} [search='']
 * @param {object} [config={}]
 * @returns {Promise<Array>}
 */
async function getCatalog(skip = 0, search = '', config = {}) {
  const cacheKey = `catalog:${skip}:${search}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) return cached;

  const base = await _detectBaseUrl(config);
  if (!base) {
    log.warn('no accessible Guardaserie mirror found');
    return [];
  }

  if (search && search.trim()) {
    return _searchCatalog(base, search.trim(), config);
  }

  const path = await _detectCatalogPath(base, config);
  const items = [];
  const startPage = Math.floor(skip / ITEMS_PER_PAGE) + 1;
  let page = startPage;

  while (items.length < ITEMS_PER_PAGE && page <= MAX_PAGES) {
    // Common pagination patterns
    const pageUrls = [
      `${base}${path}page/${page}/`,
      `${base}${path}?page=${page}`,
      `${base}${path}`,
    ];
    const url = pageUrls[page === 1 ? 2 : 0];
    log.info(`fetching catalog page ${page}`, { url });
    const html = await _fetch(url, config);
    if (!html) break;

    const $ = cheerio.load(html);
    const pageItems = _extractCards($, base);
    if (!pageItems.length) break;
    items.push(...pageItems);
    if (page === 1 && pageItems.length < 5) break; // single-page catalog
    page++;
  }

  const result = items.slice(0, ITEMS_PER_PAGE);
  catalogCache.set(cacheKey, result);
  log.info(`catalog: ${result.length} items`, { skip, search });
  return result;
}

/**
 * Use the site's own search (WordPress /?s= query).
 */
async function _searchCatalog(base, search, config) {
  const url = `${base}/?s=${encodeURIComponent(search)}`;
  log.info('searching', { url });
  const html = await _fetch(url, config);
  if (!html) return [];
  const $ = cheerio.load(html);
  return _extractCards($, base);
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} id  e.g. "guardaserie_my-show-2024"
 * @param {object} [config={}]
 * @returns {Promise<{meta: object}>}
 */
async function getMeta(id, config = {}) {
  const seriesId = id.includes(':') ? id.split(':')[0] : id;

  const cached = metaCache.get(seriesId);
  if (cached) return { meta: cached };

  const base = await _detectBaseUrl(config);
  if (!base) return { meta: await _tmdbFallbackMeta(seriesId, seriesId.replace(/^guardaserie_/, ''), config) };

  const slug = seriesId.replace(/^guardaserie_/, '');
  const seriesUrl = await _findSeriesUrl(base, slug, config);
  if (!seriesUrl) return { meta: await _tmdbFallbackMeta(seriesId, slug, config) };

  log.info('fetching meta', { id, seriesUrl });
  const html = await _fetch(seriesUrl, config);
  if (!html) return { meta: await _tmdbFallbackMeta(seriesId, slug, config) };

  const $ = cheerio.load(html);

  const name = $('h1.entry-title, h1.tvshow-title, h1, .film-name').first().text().trim()
    || $('meta[property="og:title"]').attr('content')?.replace(/\s*[-|].*$/, '').trim()
    || slug.replace(/-/g, ' ');

  const poster = $('meta[property="og:image"]').attr('content')
    || $('.poster img, .film-poster img, .tvshow-poster img').first().attr('src')
    || '';

  const background = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || poster;

  const description = $('meta[property="og:description"]').attr('content')
    || $('.overview, .synopsis, .entry-content p').first().text().trim()
    || '';

  let year = null;
  const yearMatch = ($('title').text() + description + name).match(/\b(20\d{2}|19\d{2})\b/);
  if (yearMatch) year = yearMatch[1];

  const genres = [];
  $('a[href*="/genere/"], a[href*="/genre/"], a[href*="/categoria/"], a[href*="/category/"], a[rel="category tag"], .genres a').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length < 40 && !genres.includes(g)) genres.push(g);
  });

  const cast = [];
  $('a[href*="/attori/"], a[href*="/actor/"], a[href*="/cast/"], .cast a').each((_, el) => {
    const c = $(el).text().trim();
    if (c && c.length > 1 && c.length < 60 && !cast.includes(c)) cast.push(c);
  });
  if (!cast.length) {
    $('li, td, p').each((_, el) => {
      const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (/\b(Attori|Cast|Interpreti|Star)\s*:/i.test(text)) {
        text.replace(/^[^:]+:\s*/, '').split(/[,;]/).forEach(n => {
          n = n.trim();
          if (n && n.length > 1 && n.length < 60 && !cast.includes(n)) cast.push(n);
        });
      }
    });
  }

  const episodes = _extractEpisodes(html, $, seriesId, seriesUrl, base);

  const meta = {
    id: seriesId,
    type: 'kdrama',
    name,
    poster,
    background: background || undefined,
    description,
    releaseInfo: year || '',
    genres: genres.length ? genres : undefined,
    cast: cast.length ? cast : undefined,
    seriesUrl,
    slug,
    year,
    episodes,
    videos: episodes.map((ep, idx) => ({
      id: `${seriesId}:${ep.id}`,
      title: ep.title,
      season: 1,
      episode: idx + 1,
      overview: '',
      thumbnail: ep.thumbnail || poster || '',
      released: year ? new Date(`${year}-01-01`).toISOString() : '',
    })),
  };

  // ── TMDB enrichment ────────────────────────────────────────────────
  if (config.tmdbKey) {
    const tmdb = await enrichFromTmdb(name, year, config.tmdbKey).catch(() => null);
    if (tmdb) {
      if (tmdb.poster)       meta.poster      = tmdb.poster;
      if (tmdb.background)   meta.background  = tmdb.background;
      if (!meta.description && tmdb.description) meta.description = tmdb.description;
      if (!meta.genres?.length && tmdb.genres?.length)   meta.genres  = tmdb.genres;
      if (!meta.cast?.length  && tmdb.cast?.length)      meta.cast    = tmdb.cast;
      if (!meta.imdbRating   && tmdb.imdbRating)         meta.imdbRating = tmdb.imdbRating;
      if (!meta.releaseInfo  && tmdb.releaseInfo)        meta.releaseInfo = tmdb.releaseInfo;
      if (tmdb.imdbId) meta.imdb_id = tmdb.imdbId;
      if (config.rpdbKey && tmdb.imdbId) {
        const rpdb = rpdbPosterUrl(config.rpdbKey, tmdb.imdbId);
        if (rpdb) meta.poster = rpdb;
      }
    }
  }

  metaCache.set(seriesId, meta);
  return { meta };
}

async function _findSeriesUrl(base, slug, config) {
  const candidates = [
    `${base}/tvshow/${slug}/`,
    `${base}/serie/${slug}/`,
    `${base}/drama/${slug}/`,
    `${base}/${slug}/`,
    `${base}/streaming/${slug}/`,
  ];
  for (const url of candidates) {
    const html = await fetchWithCloudscraper(url, { referer: base, proxyUrl: config.proxyUrl }).catch(() => null);
    if (html && html.length > 500 && !html.includes('404') && !html.includes('Pagina non trovata')) {
      return url;
    }
  }
  return null;
}

/**
 * Extract episode list. Guardaserie often lists episodes in tabs or an accordion.
 */
function _extractEpisodes(html, $, seriesId, seriesUrl, base) {
  const episodes = [];
  const seen = new Set();

  // ── Pattern A (Streamvix legacy): data-episode="N" data-url="embed_url" ──────
  $('[data-episode][data-url]').each((_, el) => {
    const n = parseInt($(el).attr('data-episode'), 10);
    let u = $(el).attr('data-url') || '';
    if (isNaN(n) || !u || seen.has(n)) return;
    seen.add(n);
    if (u.startsWith('//')) u = 'https:' + u;
    episodes.push({ epNum: n, id: `episodio-${n}`, title: `Episodio ${n}`, thumbnail: '', link: u, embeds: [u] });
  });
  if (episodes.length) {
    log.info(`episodes via data-episode: ${episodes.length}`);
    return episodes.sort((a, b) => a.epNum - b.epNum);
  }

  // ── Pattern B (Streamvix new): id="serie-S_E" + data-link inside <li> blocks ──
  $('a[id^="serie-"]').each((_, el) => {
    const idAttr = $(el).attr('id') || '';
    const m = idAttr.match(/^serie-(\d+)_(\d+)$/);
    if (!m) return;
    const epNum = parseInt(m[2], 10);
    if (isNaN(epNum) || seen.has(epNum)) return;
    seen.add(epNum);

    // Collect all data-link values from within the enclosing <li>
    const $li = $(el).closest('li');
    const embeds = [];
    const addEmbed = (u) => {
      if (!u) return;
      if (u.startsWith('//')) u = 'https:' + u;
      if (/supervideo|dropload|mixdrop|doodstream|vixcloud/i.test(u) && !embeds.includes(u)) embeds.push(u);
    };
    // Main anchor data-link
    addEmbed($(el).attr('data-link'));
    // All mirrors in the li
    $li.find('[data-link]').each((_, dl) => addEmbed($(dl).attr('data-link')));

    episodes.push({
      epNum,
      id: `episodio-${epNum}`,
      title: `Episodio ${epNum}`,
      thumbnail: '',
      link: seriesUrl,
      embeds: embeds.length ? embeds : undefined,
    });
  });
  if (episodes.length) {
    log.info(`episodes via data-link: ${episodes.length}`);
    return episodes.sort((a, b) => a.epNum - b.epNum);
  }

  // ── Pattern C (raw regex fallback for data-link in HTML): ────────────────────
  const dataLinkRe = /id="serie-(\d+)_(\d+)"[^>]*data-link="([^"]+)"/g;
  const rawEmbedMap = new Map();
  let rm;
  while ((rm = dataLinkRe.exec(html)) !== null) {
    const epNum = parseInt(rm[2], 10);
    if (isNaN(epNum)) continue;
    let u = rm[3];
    if (u.startsWith('//')) u = 'https:' + u;
    if (!rawEmbedMap.has(epNum)) rawEmbedMap.set(epNum, []);
    if (/supervideo|dropload|mixdrop|doodstream|vixcloud/i.test(u)) rawEmbedMap.get(epNum).push(u);
  }
  if (rawEmbedMap.size) {
    for (const [epNum, embeds] of rawEmbedMap) {
      if (seen.has(epNum)) continue;
      seen.add(epNum);
      episodes.push({ epNum, id: `episodio-${epNum}`, title: `Episodio ${epNum}`, thumbnail: '', link: seriesUrl, embeds: embeds.length ? embeds : undefined });
    }
    log.info(`episodes via raw data-link regex: ${episodes.length}`);
    return episodes.sort((a, b) => a.epNum - b.epNum);
  }

  // ── Strategy 1 (legacy): episode links with numeric pattern ──────────────────
  // Strategy 1: episode links with numeric pattern
  $('a[href]').each((_, el) => {
    const $el  = $(el);
    const href = $el.attr('href') || '';
    if (!href.startsWith(base) && !href.startsWith('/')) return;
    if (href === seriesUrl) return;

    const epMatch = href.match(/episodio[-_]?(\d+)|s\d+e(\d+)|\/(\d+)\/?$/i)
      || $el.text().match(/episodio\s*(\d+)|ep\.?\s*(\d+)/i);
    if (!epMatch) return;
    const epNum = parseInt(epMatch[1] || epMatch[2] || epMatch[3], 10);
    if (!epNum || seen.has(epNum)) return;
    seen.add(epNum);

    const $img     = $el.find('img').first();
    const thumbnail = $img.attr('data-src') || $img.attr('src') || '';
    const fullHref = href.startsWith('http') ? href : base + href;
    episodes.push({ epNum, id: `episodio-${epNum}`, title: `Episodio ${epNum}`, thumbnail, link: fullHref });
  });

  // Strategy 2: numbered list items or accordion rows
  if (!episodes.length) {
    $('li.episode, .episode-item, .accordion-item, .tabs-content a').each((_, el) => {
      const $el  = $(el);
      const text = $el.text().trim();
      const href = $el.find('a').attr('href') || $el.attr('href') || '';
      const epMatch = text.match(/(\d+)/) || href.match(/(\d+)/);
      if (!epMatch) return;
      const epNum = parseInt(epMatch[1], 10);
      if (!epNum || seen.has(epNum)) return;
      seen.add(epNum);
      const fullHref = href.startsWith('http') ? href : href ? base + href : '';
      if (!fullHref) return;
      episodes.push({ epNum, id: `episodio-${epNum}`, title: `Episodio ${epNum}`, thumbnail: '', link: fullHref });
    });
  }

  episodes.sort((a, b) => a.epNum - b.epNum);
  return episodes;
}

function _emptyMeta(id) {
  return { id, type: 'kdrama', name: id.replace(/^guardaserie_/, '').replace(/-/g, ' '), videos: [] };
}

async function _tmdbFallbackMeta(seriesId, slug, config) {
  const base = _emptyMeta(seriesId);
  if (!config.tmdbKey) return base;
  try {
    const title = slug.replace(/-/g, ' ');
    const tmdb = await enrichFromTmdb(title, null, config.tmdbKey);
    if (!tmdb) return base;
    if (tmdb.poster)         base.poster      = tmdb.poster;
    if (tmdb.background)     base.background  = tmdb.background;
    if (tmdb.description)    base.description = tmdb.description;
    if (tmdb.genres?.length) base.genres      = tmdb.genres;
    if (tmdb.cast?.length)   base.cast        = tmdb.cast;
    if (tmdb.imdbRating)     base.imdbRating  = tmdb.imdbRating;
    if (tmdb.releaseInfo)    base.releaseInfo = tmdb.releaseInfo;
    if (tmdb.imdbId)         base.imdb_id     = tmdb.imdbId;
    if (config.rpdbKey && tmdb.imdbId) {
      const rpdb = rpdbPosterUrl(config.rpdbKey, tmdb.imdbId);
      if (rpdb) base.poster = rpdb;
    }
    metaCache.set(seriesId, base);
  } catch (e) { /* TMDB unavailable */ }
  return base;
}

// ─── Streams ──────────────────────────────────────────────────────────────────

/**
 * @param {string} id  e.g. "guardaserie_my-show" or "guardaserie_my-show:episodio-3"
 * @param {object} [config={}]
 * @returns {Promise<Array>}
 */
async function getStreams(id, config = {}) {
  const colonIdx = id.indexOf(':');
  const seriesId  = colonIdx !== -1 ? id.slice(0, colonIdx) : id;
  const episodeId = colonIdx !== -1 ? id.slice(colonIdx + 1) : null;

  const cacheKey = episodeId ? `${seriesId}:${episodeId}` : seriesId;
  const cached = streamCache.get(cacheKey);
  if (cached) return cached.map(s => ({ ...s, url: wrapStreamUrl(s.url, config) }));

  const { meta } = await getMeta(seriesId, config);
  if (!meta || !meta.episodes || !meta.episodes.length) {
    log.warn('no episodes found', { id });
    return [];
  }

  const episodes = episodeId
    ? meta.episodes.filter(ep => ep.id === episodeId)
    : meta.episodes;

  if (!episodes.length) {
    log.warn('episode not found', { episodeId });
    return [];
  }

  const displayName = (meta.name || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();

  const results = await Promise.all(
    episodes.map(ep => {
      // If embeds are pre-parsed from the series page (Streamvix pattern), use them directly
      if (ep.embeds && ep.embeds.length) {
        return _getStreamsFromEmbeds(ep.embeds, config)
          .then(streams => ({ ep, streams }))
          .catch(err => { log.warn(`embed stream error for ${ep.id}: ${err.message}`); return { ep, streams: [] }; });
      }
      return _getStreamFromEpisodePage(ep.link, config)
        .then(streams => ({ ep, streams }))
        .catch(err => { log.warn(`stream fetch error for ${ep.id}: ${err.message}`); return { ep, streams: [] }; });
    })
  );

  const rawStreams = [];
  for (const { ep, streams } of results) {
    for (const { url: streamUrl, label } of streams) {
      if (!streamUrl || !streamUrl.startsWith('http')) continue;
      rawStreams.push({
        name: `🚀 Guardaserie${label ? ` [${label}]` : ''}`,
        description: `📁 ${displayName} - ${ep.title}\n👤 Guardaserie\n🇰🇷 Sub ITA`,
        url: streamUrl,
        behaviorHints: { bingeGroup: `streamfusion-guardaserie-${seriesId}` },
      });
    }
  }

  if (!rawStreams.length) {
    log.warn('no streams found', { id });
    return [];
  }

  streamCache.set(cacheKey, rawStreams);
  return rawStreams.map(s => ({ ...s, url: wrapStreamUrl(s.url, config) }));
}

/**
 * Fetch an episode page and extract ALL available stream URLs
 * (Guardaserie often provides multiple hosters per episode).
 *
 * Returns: Array of { url, label }
 */
async function _getStreamFromEpisodePage(episodeLink, config = {}) {
  const cacheKey = `streams:${episodeLink}`;
  const cached = streamCache.get(cacheKey);
  if (cached) return cached;

  log.debug('fetching episode page', { episodeLink });
  const base = _baseUrl || BASE_URLS[0];
  const html = await fetchWithCloudscraper(episodeLink, {
    referer: base,
    timeout: 20_000,
    proxyUrl: config.proxyUrl,
  });
  if (!html) return [];

  const $ = cheerio.load(html);
  const streams = [];
  const seenUrls = new Set();

  const addStream = (url, label = '') => {
    if (!url || seenUrls.has(url)) return;
    try { new URL(url); } catch { return; } // validate URL
    seenUrls.add(url);
    streams.push({ url, label });
  };

  // 1 — collect all iframes (Guardaserie shows multiple hosters as tabs)
  const iframeSelectors = [
    'iframe[src^="http"]',
    'iframe[data-src^="http"]',
    // Common hoster iframes
    'iframe[src*="dropload"]', 'iframe[src*="streamtape"]',
    'iframe[src*="supervideo"]', 'iframe[src*="vixcloud"]',
    'iframe[src*="maxstream"]', 'iframe[src*="vixede"]',
    'iframe[src*="doodstream"]',
  ];
  for (const sel of iframeSelectors) {
    $(sel).each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) addStream(src.trim(), _hosterLabel(src));
    });
  }

  // 2 — direct video source
  $('video source, video').each((_, el) => {
    const src = $(el).attr('src');
    if (src) addStream(src, 'Direct');
  });

  // 3 — scan tabs/buttons for hoster URLs set as data attributes
  $('[data-url], [data-src], [data-stream]').each((_, el) => {
    const src = $(el).attr('data-url') || $(el).attr('data-src') || $(el).attr('data-stream');
    if (src && src.startsWith('http')) addStream(src, _hosterLabel(src));
  });

  // 4 — scan inline scripts for stream URLs
  if (!streams.length) {
    const scripts = $('script').map((_, el) => $(el).html()).get().join('\n');
    const combined = scripts + html;
    const urlPatterns = [
      /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/g,
      /(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/g,
      /(https?:\/\/(?:www\.)?dropload\.io\/[^"'\s]+)/g,
      /(https?:\/\/(?:www\.)?streamtape\.(?:com|to|net)\/[^"'\s]+)/g,
      /(https?:\/\/supervideo\.[^/\s"']+\/[^"'\s]+)/g,
      /(https?:\/\/vixcloud\.[^/\s"']+\/[^"'\s]+)/g,
      /(https?:\/\/(?:www\.)?doodstream\.com\/[^"'\s]+)/g,
    ];
    for (const pat of urlPatterns) {
      let match;
      while ((match = pat.exec(combined)) !== null) {
        addStream(match[1], _hosterLabel(match[1]));
      }
    }
  }

  log.info(`found ${streams.length} stream(s) for episode`, { episodeLink });
  if (!streams.length) return [];

  // Resolve embed page URLs to direct .m3u8/.mp4 streams (parallel, best-effort)
  const resolved = await Promise.all(
    streams.map(async ({ url: embedUrl, label }) => {
      if (/\.(?:m3u8|mp4)(\?|$)/i.test(embedUrl)) return { url: embedUrl, label };
      const directUrl = await _resolveEmbedUrl(embedUrl, config);
      return { url: directUrl || embedUrl, label };
    })
  );
  const finalStreams = resolved.filter(s => s.url);

  if (finalStreams.length) {
    streamCache.set(cacheKey, finalStreams, 2 * 60 * 60_000);
  }
  return finalStreams;
}

/**
 * SuperVideo P,A,C,K deobfuscation — ported from Streamvix.
 * Reconstructs the HLS master playlist URL from the packed JS on the embed page.
 */
async function _resolveSupervideo(url, config = {}) {
  try {
    // Normalize: /e/<id> or /d/<id> → /<id>
    const normalized = url.replace(/\/e\//, '/').replace(/\/d\//, '/');
    const html = await fetchWithCloudscraper(normalized, { referer: normalized, timeout: 12_000, proxyUrl: config.proxyUrl });
    if (!html) return null;

    const m = html.match(/}\('(.+?)',.+,'(.+?)'\.split/s);
    if (!m) return null;

    const terms = m[2].split('|');
    const fileIndex = terms.indexOf('file');
    if (fileIndex === -1) return null;

    let hfs = '';
    for (let i = fileIndex; i < terms.length; i++) {
      if (terms[i].includes('hfs')) { hfs = terms[i]; break; }
    }
    if (!hfs) return null;

    const urlsetIndex = terms.indexOf('urlset');
    const hlsIndex    = terms.indexOf('hls');
    if (urlsetIndex === -1 || hlsIndex === -1 || hlsIndex <= urlsetIndex) return null;

    const slice    = terms.slice(urlsetIndex + 1, hlsIndex);
    const reversed = slice.reverse();
    let base = `https://${hfs}.serversicuro.cc/hls/`;
    if (reversed.length === 1) return base + ',' + reversed[0] + '.urlset/master.m3u8';
    const len = reversed.length;
    reversed.forEach((el, idx) => {
      base += el + ',' + (idx === len - 1 ? '.urlset/master.m3u8' : '');
    });
    return base;
  } catch (e) {
    log.warn('supervideo resolve failed', { err: e.message });
    return null;
  }
}

/**
 * Fetch streams directly from a list of embed URLs (Streamvix approach).
 * Used when episode data-link embeds are pre-parsed from the series page.
 */
async function _getStreamsFromEmbeds(embeds, config = {}) {
  const seenUrls = new Set();
  const streams  = [];
  for (const embedUrl of embeds.slice(0, 8)) {
    let resolvedUrl = embedUrl;
    if (!/\.(?:m3u8|mp4)(\?|$)/i.test(embedUrl)) {
      const direct = await _resolveEmbedUrl(embedUrl, config);
      if (direct) resolvedUrl = direct;
    }
    if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;
    try { new URL(resolvedUrl); } catch { continue; }
    seenUrls.add(resolvedUrl);
    streams.push({ url: resolvedUrl, label: _hosterLabel(embedUrl) });
  }
  return streams;
}

/**
 * Fetch an embed player page and extract the direct .m3u8 / .mp4 stream URL.
 * Handles Vixcloud, SuperVideo, Streamtape, DropLoad and generic JWPlayer/VideoJS patterns.
 */
async function _resolveEmbedUrl(embedUrl, config = {}) {
  // SuperVideo: use dedicated P,A,C,K deobfuscator first
  if (/supervideo/i.test(embedUrl)) {
    const sv = await _resolveSupervideo(embedUrl, config);
    if (sv) return sv;
  }

  try {
    const html = await fetchWithCloudscraper(embedUrl, {
      referer: embedUrl,
      timeout: 10_000,
      proxyUrl: config.proxyUrl,
    });
    if (!html) return null;
    const patterns = [
      /"file"\s*:\s*"(https?:[^"]+\.m3u8[^"]*)"/,
      /"file"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/,
      /"src"\s*:\s*"(https?:[^"]+\.m3u8[^"]*)"/,
      /sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["'](https?:[^"']+)"/,
      /<source[^>]+src=["'](https?:[^"']+\.m3u8[^"']*)/i,
      /(https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/,
      /(https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?)/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m && m[1]) return decodeURIComponent(m[1].trim());
    }
  } catch (err) {
    log.warn('embed resolve failed', { embedUrl: embedUrl.slice(0, 70), err: err.message });
  }
  return null;
}

function _hosterLabel(url = '') {
  if (url.includes('dropload'))    return 'DropLoad';
  if (url.includes('streamtape'))  return 'Streamtape';
  if (url.includes('supervideo'))  return 'SuperVideo';
  if (url.includes('vixcloud'))    return 'Vixcloud';
  if (url.includes('maxstream'))   return 'MaxStream';
  if (url.includes('doodstream'))  return 'DoodStream';
  if (url.includes('vixede'))      return 'Vixede';
  if (/\.m3u8/.test(url))          return 'HLS';
  if (/\.mp4/.test(url))           return 'MP4';
  return '';
}

module.exports = { getCatalog, getMeta, getStreams };
