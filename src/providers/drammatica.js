'use strict';

/**
 * Drammatica.it provider
 * Source: https://www.drammatica.it
 *
 * Italian K-Drama fansub site (WordPress-based, Cloudflare protected).
 * Bypass via cloudscraper (same approach as Rama).
 *
 * Provides:
 *   - getCatalog(skip, search)  → [{id, type, name, poster, ...}]
 *   - getMeta(id)               → {meta}
 *   - getStreams(id)             → [{name, description, url, behaviorHints}]
 */

// Removed: Drammatica provider is no longer used.
const { fetchWithCloudscraper } = require('../utils/fetcher');
const { TTLCache } = require('../utils/cache');
const { wrapStreamUrl } = require('../utils/mediaflow');
const { enrichFromTmdb, rpdbPosterUrl } = require('../utils/tmdb');
const { createLogger } = require('../utils/logger');

const log = createLogger('drammatica');

const BASE_URL = 'https://www.drammatica.it';
// Drammatica uses a WordPress-based layout — dramas listed under /drama/ category
const CATALOG_PATHS = ['/drama/', '/k-drama/', '/serie/', '/'];
const ITEMS_PER_PAGE = 20;
const MAX_PAGES = 20;

const catalogCache = new TTLCache({ ttl: 10 * 60_000, maxSize: 200 });
const metaCache    = new TTLCache({ ttl: 30 * 60_000, maxSize: 500 });
const streamCache  = new TTLCache({ ttl: 60 * 60_000, maxSize: 1000 });

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
  if (cached) {
    log.debug('catalog from cache', { skip, search });
    return cached;
  }

  // If search is provided, use the WP search endpoint
  if (search && search.trim()) {
    return _searchCatalog(search.trim(), config);
  }

  const items = [];
  const startPage = Math.floor(skip / ITEMS_PER_PAGE) + 1;
  let catalogPath = null;

  // Detect which catalog path works
  if (!catalogPath) {
    catalogPath = await _detectCatalogPath(config);
  }
  if (!catalogPath) {
    log.warn('could not detect catalog path');
    return [];
  }

  let pageNumber = startPage;
  while (items.length < ITEMS_PER_PAGE && pageNumber <= MAX_PAGES) {
    const url = `${BASE_URL}${catalogPath}page/${pageNumber}/`;
    log.info(`fetching catalog page ${pageNumber}`, { url });
    const html = await fetchWithCloudscraper(url, { referer: BASE_URL + catalogPath, proxyUrl: config.proxyUrl });
    if (!html) break;

    const $ = cheerio.load(html);
    const pageItems = _extractCards($);

    if (!pageItems.length) break;
    items.push(...pageItems);
    pageNumber++;
  }

  const result = items.slice(0, ITEMS_PER_PAGE);
  catalogCache.set(cacheKey, result);
  log.info(`catalog: found ${result.length} items`, { skip, search });
  return result;
}

/**
 * Detect which catalog URL path the site uses by trying known patterns.
 * Result is cached in the module scope.
 */
let _detectedPath = null;
async function _detectCatalogPath(config) {
  if (_detectedPath) return _detectedPath;
  for (const path of CATALOG_PATHS) {
    const url = `${BASE_URL}${path}`;
    log.info(`trying catalog path: ${url}`);
    const html = await fetchWithCloudscraper(url, { referer: BASE_URL, proxyUrl: config.proxyUrl }).catch(() => null);
    if (!html) continue;
    const $ = cheerio.load(html);
    const cards = _extractCards($);
    if (cards.length > 0) {
      log.info(`catalog path detected: ${path} (${cards.length} cards)`);
      _detectedPath = path;
      return path;
    }
  }
  return null;
}

/**
 * WordPress search endpoint: /?s=query
 */
async function _searchCatalog(search, config) {
  const url = `${BASE_URL}/?s=${encodeURIComponent(search)}`;
  log.info('searching catalog', { url });
  const html = await fetchWithCloudscraper(url, { referer: BASE_URL, proxyUrl: config.proxyUrl });
  if (!html) return [];

  const $ = cheerio.load(html);
  const items = _extractCards($);
  log.info(`search found ${items.length} items`, { search });
  return items;
}

/**
 * Extract drama cards from a cheerio-loaded page.
 * Tries multiple common WordPress drama-site selectors.
 */
function _extractCards($) {
  const items = [];
  const seen  = new Set();

  // Strategy 1: article posts with class post or drama
  const selectors = [
    'article.post a[href*="/drama/"]',
    'article.drama a[href]',
    '.drama-card a[href]',
    '.post-thumbnail a[href*="/drama/"]',
    'article a[rel="bookmark"]',
    // Fallback: any article with a plausible internal link
    'article h2 a[href]',
    'article h3 a[href]',
    '.entry-title a[href]',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      if (!href.startsWith(BASE_URL) && !href.startsWith('/')) return;
      if (href.includes('?') && !href.includes('/drama/')) return; // skip pagination/tag links

      // Try to find title
      let title = $el.attr('title')
        || $el.text().trim()
        || $el.find('img').attr('alt')
        || '';
      title = title.replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > 100) return;

      // Slug-based ID
      const slug = href.replace(/\/$/, '').split('/').pop();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      // Try to get poster from nearby image
      const $parent = $el.parent();
      const posterEl = $parent.find('img').first()
        || $el.closest('article, .drama-card, .post').find('img').first();
      const poster = (posterEl.length ? posterEl.attr('src') || posterEl.attr('data-src') : '') || '';

      items.push({
        id: `drammatica_${slug}`,
        type: 'kdrama',
        name: title,
        poster,
        posterShape: 'poster',
      });
    });
    if (items.length > 3) break; // Found something with this selector, stop trying others
  }

  return items;
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} id  e.g. "drammatica_serie-coreana-2024"
 * @param {object} [config={}]
 * @returns {Promise<{meta: object}>}
 */
async function getMeta(id, config = {}) {
  const seriesId = id.includes(':') ? id.split(':')[0] : id;

  const cached = metaCache.get(seriesId);
  if (cached) {
    log.debug('meta from cache', { id: seriesId });
    return { meta: cached };
  }

  const slug = seriesId.replace(/^drammatica_/, '');

  // Try multiple URL patterns for the drama page
  const seriesUrl = await _findDramaUrl(slug, config);
  if (!seriesUrl) {
    log.warn('series page not found', { id, slug });
    return { meta: await _tmdbFallbackMeta(seriesId, slug, config) };
  }

  log.info('fetching meta', { id, seriesUrl });
  const html = await fetchWithCloudscraper(seriesUrl, { referer: BASE_URL, proxyUrl: config.proxyUrl });
  if (!html) {
    log.warn('meta fetch returned null', { id });
    return { meta: await _tmdbFallbackMeta(seriesId, slug, config) };
  }

  const $ = cheerio.load(html);

  // Series title
  const name = $('h1.entry-title, h1.drama-title, h1.post-title, h1').first().text().trim()
    || $('meta[property="og:title"]').attr('content')?.replace(/\s*[-|].*$/, '').trim()
    || slug.replace(/-/g, ' ');

  // Poster
  const poster = $('meta[property="og:image"]').attr('content')
    || $('.post-thumbnail img, .drama-poster img, .serie-image img').first().attr('src')
    || '';

  // Background (wider banner, fallback to poster)
  const background = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || poster;

  // Description / synopsis
  const description = $('.entry-content p, .drama-description, .serie-description, .synopsis')
    .first().text().trim()
    || $('meta[property="og:description"]').attr('content') || '';

  // Year
  let year = null;
  const yearMatch = ($('title').text() + description).match(/\b(20\d{2}|19\d{2})\b/);
  if (yearMatch) year = yearMatch[1];

  // Genres
  const genres = [];
  $('a[href*="/genere/"], a[href*="/genre/"], a[href*="/categoria/"], a[href*="/category/"], a[rel="category tag"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length < 40 && !genres.includes(g)) genres.push(g);
  });

  // Cast — multiple strategies
  const cast = [];
  $('a[href*="/attori/"], a[href*="/actor/"], a[href*="/cast/"]').each((_, el) => {
    const c = $(el).text().trim();
    if (c && c.length > 1 && c.length < 60 && !cast.includes(c)) cast.push(c);
  });
  if (!cast.length) {
    $('li, p, td').each((_, el) => {
      const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (/\b(Attori|Cast|Interpreti|Star|Protagonisti)\s*:/i.test(text)) {
        text.replace(/^[^:]+:\s*/, '').split(/[,;]/).forEach(n => {
          n = n.trim();
          if (n && n.length > 1 && n.length < 60 && !cast.includes(n)) cast.push(n);
        });
      }
    });
  }

  // Episode list
  const episodes = _extractEpisodes($, slug, year);

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

/**
 * Try multiple URL patterns to locate the drama page.
 */
async function _findDramaUrl(slug, config) {
  const candidates = [
    `${BASE_URL}/drama/${slug}/`,
    `${BASE_URL}/${slug}/`,
    `${BASE_URL}/serie/${slug}/`,
    `${BASE_URL}/k-drama/${slug}/`,
    `${BASE_URL}/drama-streaming/${slug}/`,
  ];
  for (const url of candidates) {
    const html = await fetchWithCloudscraper(url, { referer: BASE_URL, proxyUrl: config.proxyUrl }).catch(() => null);
    if (html && html.length > 500 && !html.includes('404') && !html.includes('Pagina non trovata')) {
      return url;
    }
  }
  return null;
}

/**
 * Extract episode list from the drama page.
 */
function _extractEpisodes($, seriesSlug, year) {
  const episodes = [];
  const seen = new Set();

  // Strategy 1: links containing the series slug + episode number
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    if (!href.startsWith(BASE_URL) && !href.startsWith('/')) return;

    // Match patterns like:
    // /series-slug-episodio-1/ or /episodio-1-series-slug/ or /watch/series-slug/1/
    const epMatch = href.match(/episodio[-_]?(\d+)|episode[-_]?(\d+)|ep[-_]?(\d+)|\/(\d+)\//i);
    if (!epMatch) return;
    const epNum = parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4], 10);
    if (!epNum || seen.has(epNum)) return;
    seen.add(epNum);

    const img = $el.find('img').first();
    const thumbnail = img.attr('src') || img.attr('data-src') || '';
    episodes.push({ epNum, id: `episodio-${epNum}`, title: `Episodio ${epNum}`, thumbnail, link: href.startsWith('http') ? href : BASE_URL + href });
  });

  // Strategy 2: ordered list of links marked as episodes
  if (!episodes.length) {
    $('ol li a, ul.episodi li a, .episode-list a, .episodes a').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const text = $el.text().trim();
      if (!href) return;

      const epMatch = text.match(/\d+/) || href.match(/(\d+)/);
      if (!epMatch) return;
      const epNum = parseInt(epMatch[0], 10);
      if (!epNum || seen.has(epNum)) return;
      seen.add(epNum);
      episodes.push({ epNum, id: `episodio-${epNum}`, title: `Episodio ${epNum}`, thumbnail: '', link: href.startsWith('http') ? href : BASE_URL + href });
    });
  }

  episodes.sort((a, b) => a.epNum - b.epNum);
  return episodes;
}

function _emptyMeta(id) {
  return { id, type: 'kdrama', name: id.replace(/^drammatica_/, '').replace(/-/g, ' '), videos: [] };
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
 * @param {string} id  e.g. "drammatica_my-drama" or "drammatica_my-drama:episodio-3"
 * @param {object} [config={}]
 * @returns {Promise<Array>}
 */
async function getStreams(id, config = {}) {
  const colonIdx = id.indexOf(':');
  const seriesId  = colonIdx !== -1 ? id.slice(0, colonIdx) : id;
  const episodeId = colonIdx !== -1 ? id.slice(colonIdx + 1) : null;

  const cacheKey = episodeId ? `${seriesId}:${episodeId}` : seriesId;
  const cached = streamCache.get(cacheKey);
  if (cached) {
    log.debug('streams from cache', { cacheKey });
    return cached.map(s => ({ ...s, url: wrapStreamUrl(s.url, config) }));
  }

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
    episodes.map(ep => _getStreamFromEpisodePage(ep.link, config)
      .then(streams => ({ ep, streams }))
      .catch(err => { log.warn(`stream fetch error for ${ep.id}: ${err.message}`); return { ep, streams: [] }; })
    )
  );

  const rawStreams = [];
  for (const { ep, streams } of results) {
    for (const { url: streamUrl, label } of streams) {
      if (!streamUrl || !streamUrl.startsWith('http')) continue;
      rawStreams.push({
        name: `🚀 Drammatica${label ? ` [${label}]` : ''}`,
        description: `📁 ${displayName} - ${ep.title}\n👤 Drammatica.it\n🇰🇷 Sub ITA`,
        url: streamUrl,
        behaviorHints: { bingeGroup: `streamfusion-drammatica-${seriesId}` },
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
 * Fetch an episode page and extract ALL available stream URLs.
 * Returns Array of { url, label }
 */
async function _getStreamFromEpisodePage(episodeLink, config = {}) {
  const cacheKey = `stream:${episodeLink}`;
  const cached = streamCache.get(cacheKey);
  if (cached) return cached;

  log.debug('fetching episode page', { episodeLink });
  const html = await fetchWithCloudscraper(episodeLink, {
    referer: BASE_URL,
    timeout: 20_000,
    proxyUrl: config.proxyUrl,
  });
  if (!html) return [];

  const $ = cheerio.load(html);
  const streams = [];
  const seenEmbeds = new Set();

  const addEmbed = (src, label = '') => {
    if (!src || seenEmbeds.has(src)) return;
    try { new URL(src.startsWith('//') ? 'https:' + src : src); } catch { return; }
    seenEmbeds.add(src);
    streams.push({ embedUrl: src.startsWith('//') ? 'https:' + src : src, label: label || _hosterLabel(src) });
  };

  // 1 — iframes (multiple hosters as tabs)
  const iframeSelectors = [
    'iframe#video-player', 'iframe.video-player',
    '.wp-block-embed iframe', '.player-box iframe', '.video-container iframe',
    'div[class*="player"] iframe', 'div[class*="embed"] iframe',
    'iframe[src*="dropload"]', 'iframe[src*="streamtape"]', 'iframe[src*="supervideo"]',
    'iframe[src*="vixcloud"]', 'iframe[src*="maxstream"]', 'iframe[src*="vixede"]',
    'iframe[src^="http"]',
  ];
  for (const sel of iframeSelectors) {
    $(sel).each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) addEmbed(src.trim());
    });
  }

  // 2 — data-url / data-link attributes
  $('[data-url], [data-link], [data-src]').each((_, el) => {
    const src = $(el).attr('data-url') || $(el).attr('data-link') || $(el).attr('data-src');
    if (src && src.startsWith('http')) addEmbed(src);
  });

  // 3 — <video> direct
  $('video source, video').each((_, el) => {
    const src = $(el).attr('src');
    if (src) streams.push({ embedUrl: src, label: 'Direct' });
  });

  // 4 — scripts fallback
  if (!streams.length) {
    const combined = $('script').map((_, el) => $(el).html()).get().join('\n') + html;
    const urlPatterns = [
      /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/g,
      /(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/g,
      /(https?:\/\/(?:www\.)?dropload\.io\/[^"'\s]+)/g,
      /(https?:\/\/(?:www\.)?streamtape\.(?:com|to|net)\/[^"'\s]+)/g,
      /(https?:\/\/supervideo\.[^/\s"']+\/[^"'\s]+)/g,
      /(https?:\/\/vixcloud\.[^/\s"']+\/[^"'\s]+)/g,
    ];
    for (const pat of urlPatterns) {
      let match;
      while ((match = pat.exec(combined)) !== null) addEmbed(match[1]);
    }
  }

  log.info(`found ${streams.length} embed(s) for episode`, { episodeLink });
  if (!streams.length) return [];

  // Resolve each embed to a direct playable URL
  const resolved = await Promise.all(
    streams.map(async ({ embedUrl, label }) => {
      if (/\.(?:m3u8|mp4)(\?|$)/i.test(embedUrl)) return { url: embedUrl, label };
      const direct = await _resolveEmbedUrl(embedUrl, config);
      return { url: direct || embedUrl, label };
    })
  );
  const finalStreams = resolved.filter(s => s.url && s.url.startsWith('http'));

  if (finalStreams.length) streamCache.set(cacheKey, finalStreams, 2 * 60 * 60_000);
  return finalStreams;
}

/**
 * SuperVideo P,A,C,K deobfuscation — ported from Streamvix.
 */
async function _resolveSupervideo(url, config = {}) {
  try {
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

module.exports = { getCatalog, getMeta, getStreams };
