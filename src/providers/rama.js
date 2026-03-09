'use strict';

/**
 * Rama Oriental Fansub provider
 * Source: https://ramaorientalfansub.live
 *
 * Provides:
 *   - getCatalog(skip, search)   → [{id, type, name, poster, ...}]
 *   - getMeta(id)                → {meta}
 *   - getStreams(id)              → [{title, url, behaviorHints}]
 */

const cheerio = require('cheerio');
const { fetchWithCloudscraper } = require('../utils/fetcher');
const { TTLCache } = require('../utils/cache');
const { extractBaseSlug } = require('../utils/titleHelper');
const { enrichFromTmdb, rpdbPosterUrl, topPosterUrl } = require('../utils/tmdb');
const { wrapStreamUrl } = require('../utils/mediaflow');
const { createLogger } = require('../utils/logger');

const log = createLogger('rama');

const BASE_URL = 'https://ramaorientalfansub.live';
const CATALOG_PATH = '/paese/corea-del-sud/';
const ITEMS_PER_PAGE = 20;
const MAX_PAGES = 35;

const catalogCache = new TTLCache({ ttl: 10 * 60_000, maxSize: 200 });
const metaCache    = new TTLCache({ ttl: 30 * 60_000, maxSize: 500 });
const streamCache  = new TTLCache({ ttl: 60 * 60_000, maxSize: 1000 });

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
    log.debug('catalog from cache', { skip, search });
    return cached;
  }

  const items = [];
  const searchQuery = search.trim().toLowerCase();
  const startPage = Math.floor(skip / ITEMS_PER_PAGE) + 1;

  let pageNumber = startPage;
  while (items.length < ITEMS_PER_PAGE && pageNumber <= MAX_PAGES) {
    const url = `${BASE_URL}${CATALOG_PATH}page/${pageNumber}/`;
    log.info(`fetching catalog page ${pageNumber}`, { url });
    const html = await fetchWithCloudscraper(url, { referer: BASE_URL + CATALOG_PATH, proxyUrl: config.proxyUrl, clientIp: config.clientIp });
    if (!html) break;

    const $ = cheerio.load(html);
    const pageItems = [];

    // Cards use class "kira-anime" — title comes from img alt attribute
    $('div.kira-anime').each((_, el) => {
      const $el = $(el);
      // Href is on the parent container's first <a>
      const $card = $el.parent();
      const href = $card.find('a[href*="/drama/"]').first().attr('href')
        || $card.parent().find('a[href*="/drama/"]').first().attr('href')
        || $el.find('a[href*="/drama/"]').first().attr('href')
        || '';

      const img = $el.find('img').first();
      const poster = img.attr('src') || img.attr('data-src') || '';
      // Title from img alt, cleanup " thumbnail" and "(year)"
      const rawTitle = img.attr('alt') || '';
      const title = _cleanTitle(
        rawTitle.replace(/\s*thumbnail\s*$/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim()
      );

      if (!href || !title) return;

      const slug = href.replace(/\/$/, '').split('/').pop() || '';
      const id = `rama_${slug}`;

      if (searchQuery && !title.toLowerCase().includes(searchQuery) && !slug.includes(searchQuery)) return;

      pageItems.push({
        id,
        type: 'series',
        name: title,
        poster,
        posterShape: 'poster',
      });
    });

    items.push(...pageItems);
    if (pageItems.length < 5) break; // No more results
    pageNumber++;
  }

  const result = items.slice(0, ITEMS_PER_PAGE);
  catalogCache.set(cacheKey, result);
  log.info(`catalog: found ${result.length} items`, { skip, search });
  return result;
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} id  e.g. "rama_my-drama-2023"
 * @returns {Promise<{meta: object}>}
 */
async function getMeta(id, config = {}) {
  // Strip episode part from composite IDs like "rama_my-drama:episodio-1"
  const seriesId = id.includes(':') ? id.split(':')[0] : id;

  const cached = metaCache.get(seriesId);
  if (cached) {
    log.debug('meta from cache', { id: seriesId });
    return { meta: cached };
  }

  const baseId = extractBaseSlug(seriesId.replace(/^rama_/, ''));
  const seriesUrl = `${BASE_URL}/drama/${baseId}/`;
  log.info('fetching meta', { id, seriesUrl });

  const html = await fetchWithCloudscraper(seriesUrl, { referer: BASE_URL, proxyUrl: config.proxyUrl, clientIp: config.clientIp });
  if (!html) {
    log.warn('meta fetch returned null', { id });
    return { meta: await _tmdbFallbackMeta(seriesId, baseId, config) };
  }

  const $ = cheerio.load(html);

  // Series title
  const name = $('a.text-accent, h1.entry-title, h1.series-title').first().text().trim()
    || $('.anime-title, .drama-title').first().text().trim()
    || baseId.replace(/-/g, ' ');

  const poster = $('.anime-image > img, .series-poster img, .entry-image img').first().attr('src') || '';

  // Background: prefer og:image (usually wider banner), fallback to poster
  const background = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || poster;

  // ── Parse all li.list-none info items in one pass ─────────────────────────
  let adultFlag = '';
  let imdbRating = '';
  let runtime = '';
  let director = [];
  let country = '';
  let status = '';

  $('li.list-none').each((_, el) => {
    const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^Valutazione:/i.test(text) && /18\+|Restricted/i.test(text)) adultFlag = ' 🔞';
    if (/^Punteggio:/i.test(text)) {
      const m = text.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m) imdbRating = m[1];
    }
    if (/^Durata:/i.test(text)) {
      const m = text.match(/(\d+)/);
      if (m) runtime = `${m[1]} min`;
    }
    if (/^Stato:/i.test(text)) {
      status = text.replace(/^Stato:\s*/i, '').trim();
    }
    if (/^Paese:/i.test(text)) {
      country = text.replace(/^Paese:\s*/i, '').trim();
    }
    if (/^Regia:/i.test(text)) {
      $(el).find('a').each((_, a) => {
        const n = $(a).text().trim();
        if (n && !director.includes(n)) director.push(n);
      });
    }
  });

  // ── Genres — scoped to the "Genere:" li only (avoids grabbing nav sidebar) ─
  const genres = [];
  $('li.list-none').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!/^Genere:/i.test(text)) return;
    $(el).find('a[href*="/genere/"]').each((_, a) => {
      const g = $(a).text().trim();
      if (g && g.length < 40 && !genres.includes(g)) genres.push(g);
    });
  });

  // ── Cast — Rama renders actors in grid cards with [data-character] ──────────
  const cast = [];
  $('[data-character]').each((_, el) => {
    $(el).find('h4').each((_, h4) => {
      const actorName = $(h4).text().trim();
      if (actorName && actorName.length > 1 && actorName.length < 80 && !cast.includes(actorName)) {
        cast.push(actorName);
      }
    });
  });
  // Fallback: parse "Attori:" line from li.list-none text
  if (!cast.length) {
    $('li.list-none').each((_, el) => {
      const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (/^(Attori|Cast|Interpreti|Stars?)\s*:/i.test(text)) {
        text.replace(/^[^:]+:\s*/, '').split(/[,;]/).forEach(n => {
          n = n.trim();
          if (n && n.length > 1 && n.length < 80 && !cast.includes(n)) cast.push(n);
        });
      }
    });
  }

  // ── Synopsis — the description text is directly in div.font-light.text-spec ─
  // (NOT in a child div — the old selector `div.font-light > div:nth-child(1)` was wrong)
  const synopsis = $('div.font-light.text-spec').first().text().trim()
    || $('div[class*="font-light"]').first().text().trim()
    || $('.serie-description, .entry-content').first().text().trim();

  const descParts = [];
  if (synopsis) descParts.push(synopsis);
  if (status) descParts.push(`📺 ${status}${adultFlag}`);
  const description = descParts.join('\n\n');

  // Year from title tag
  let year = null;
  const titleText = $('title').text();
  const yearMatch = titleText.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) year = yearMatch[0];

  const meta = {
    id: seriesId,
    type: 'series',
    name,
    poster,
    background: background || undefined,
    description,
    releaseInfo: year || '',
    imdbRating: imdbRating || undefined,
    genres: genres.length ? genres : undefined,
    cast: cast.length ? cast : undefined,
    director: director.length ? director : undefined,
    runtime: runtime || undefined,
    country: country || undefined,
    seriesUrl,
    baseId,
    year,
  };

  // Fetch episodes and embed in meta for stream handler
  meta.episodes = await _getEpisodes(seriesUrl, $, baseId, year);

  // Map to Stremio videos format
  meta.videos = meta.episodes.map((ep, idx) => ({
    id: `${seriesId}:${ep.id}`,
    title: ep.title,
    season: 1,
    episode: idx + 1,
    overview: ep.overview || '',
    thumbnail: ep.thumbnail || poster || '',
    released: year ? new Date(`${year}-01-01`).toISOString() : '',
  }));

  // ── TMDB enrichment (fills gaps: poster, background, cast, genres, rating) ─
  if (config.tmdbKey) {
    // Hard 10s cap so the total getMeta time stays well under META_TIMEOUT (30s)
    const tmdb = await Promise.race([
      enrichFromTmdb(name, year, config.tmdbKey).catch(() => null),
      new Promise(r => setTimeout(() => r(null), 10_000)),
    ]);
    if (tmdb) {
      if (tmdb.poster)       meta.poster      = tmdb.poster;
      if (tmdb.background)   meta.background  = tmdb.background;
      if (!meta.description && tmdb.description) meta.description = tmdb.description;
      if (!meta.genres?.length && tmdb.genres?.length)   meta.genres  = tmdb.genres;
      if (!meta.cast?.length  && tmdb.cast?.length)      meta.cast    = tmdb.cast;
      if (!meta.imdbRating   && tmdb.imdbRating)         meta.imdbRating = tmdb.imdbRating;
      if (!meta.director     && tmdb.director)           meta.director   = tmdb.director;
      if (!meta.releaseInfo  && tmdb.releaseInfo)        meta.releaseInfo = tmdb.releaseInfo;
      if (tmdb.imdbId) meta.imdb_id = tmdb.imdbId;
      // Poster priority: TopPoster > RPDB > TMDB
      const tp = topPosterUrl(config.topPosterKey, tmdb.imdbId);
      if (tp) {
        meta.poster = tp;
      } else if (config.rpdbKey && tmdb.imdbId) {
        const rpdb = rpdbPosterUrl(config.rpdbKey, tmdb.imdbId);
        if (rpdb) meta.poster = rpdb;
      }
    }
  }

  metaCache.set(seriesId, meta);
  return { meta };
}

// ─── Stream ───────────────────────────────────────────────────────────────────

/**
 * @param {string} id  e.g. "rama_my-drama-2023"
 * @returns {Promise<Array>}
 */
async function getStreams(id, config = {}) {
  // id can be 'rama_my-drama' (series) or 'rama_my-drama:episodio-3' (specific episode)
  const colonIdx = id.indexOf(':');
  const seriesId  = colonIdx !== -1 ? id.slice(0, colonIdx) : id;
  const episodeId = colonIdx !== -1 ? id.slice(colonIdx + 1) : null;

  // Cache key includes episode so different episodes don't collide
  const cacheKey = episodeId ? `${seriesId}:${episodeId}` : seriesId;
  const cached = streamCache.get(cacheKey);
  if (cached) {
    log.debug('streams from cache', { cacheKey });
    return cached.map(s => ({ ...s, url: wrapStreamUrl(s.url, config) }));
  }

  const { meta } = await getMeta(seriesId, config);
  if (!meta || !meta.episodes || !meta.episodes.length) {
    log.warn('no episodes found for streams', { id });
    return [];
  }

  // Find the specific episode requested (if episodeId given)
  const episodes = episodeId
    ? meta.episodes.filter(ep => ep.id === episodeId)
    : meta.episodes;

  if (!episodes.length) {
    log.warn('episode not found in meta', { episodeId, available: meta.episodes.map(e => e.id) });
    return [];
  }

  // Fetch stream URLs in parallel — significantly faster for multi-episode requests
  const displayName = (meta.name || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const results = await Promise.all(
    episodes.map(ep => _getStreamFromEpisodePage(ep.link)
      .then(url => ({ ep, url }))
      .catch(err => { log.warn(`stream fetch error for ${ep.id}: ${err.message}`); return { ep, url: null }; })
    )
  );

  const rawStreams = [];
  for (const { ep, url: streamUrl } of results) {
    if (!streamUrl) {
      log.warn('no stream found for episode', { epId: ep.id, link: ep.link });
      continue;
    }
    if (!streamUrl.startsWith('http')) {
      log.warn('invalid stream URL format', { epId: ep.id, url: streamUrl.slice(0, 80) });
      continue;
    }
    rawStreams.push({
      name: _qualityLabel(streamUrl),
      description: `� Rama · 📁 ${displayName} - ${ep.title}\n🇰🇷 Sub ITA`,
      url: streamUrl,
      behaviorHints: { bingeGroup: `streamfusion-rama-${seriesId}` },
    });
  }

  if (!rawStreams.length) {
    log.warn('no stream URLs found', { id });
    return [];
  }

  streamCache.set(cacheKey, rawStreams);
  return rawStreams.map(s => ({ ...s, url: wrapStreamUrl(s.url, config) }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _getEpisodes(seriesUrl, $, seriesId, year) {
  // Extract episode links directly from swiper — MUCH more reliable than constructing URLs.
  // Slides are in reverse order (newest first), so we reverse to get ep1 first.
  const slides = [];

  $('.swiper-slide').each((_, el) => {
    const $slide = $(el);
    const anchor = $slide.find('a[href*="/watch/"]').first();
    const link = anchor.attr('href') || '';
    if (!link) return;
    const img = $slide.find('img').first();
    const thumbnail = img.attr('src') || img.attr('data-src') || '';
    // Extract episode number from URL like /watch/.../episodio-16/
    const epMatch = link.match(/episodio-(\d+)/i);
    const epNum = epMatch ? parseInt(epMatch[1], 10) : slides.length + 1;
    slides.push({ epNum, link, thumbnail });
  });

  // Sort by episode number ascending and deduplicate
  slides.sort((a, b) => a.epNum - b.epNum);

  const episodes = slides.map(s => ({
    id: `episodio-${s.epNum}`,
    title: `Episodio ${s.epNum}`,
    thumbnail: s.thumbnail,
    link: s.link,
  }));

  log.info(`fetched ${episodes.length} episodes`, { seriesId });
  return episodes;
}

async function _getStreamFromEpisodePage(episodeLink) {
  const cacheKey = `stream:${episodeLink}`;
  const cached = streamCache.get(cacheKey);
  if (cached) return cached;

  log.debug('fetching episode page', { episodeLink });
  const html = await fetchWithCloudscraper(episodeLink, { referer: BASE_URL, timeout: 15_000, proxyUrl: undefined });
  if (!html) return null;

  const $ = cheerio.load(html);
  let url = null;

  // Priority 1 — iframe inside player container (broad selector for Rama)
  $('div.episode-player-box iframe, [class*="player"] iframe, .video-container iframe, #player iframe, .wp-post-content iframe').each((_, el) => {
    if (url) return false;
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (src && !_isAdIframe(src)) url = src;
  });

  // Priority 2 — any non-ad iframe (Rama puts the player as the first iframe)
  if (!url) {
    $('iframe').each((_, el) => {
      if (url) return false;
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !_isAdIframe(src) && (src.startsWith('http') || src.startsWith('//'))) {
        url = src.startsWith('//') ? 'https:' + src : src;
      }
    });
  }

  // Priority 3 — <video> source tag
  if (!url) {
    const source = $('video[name="media"] source, video source');
    if (source.length) url = source.attr('src');
  }

  // Priority 4 — direct stream link anchor
  if (!url) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/\.(m3u8|mp4)/i.test(href) || href.includes('streamingrof')) {
        url = href;
        return false;
      }
    });
  }

  // Priority 5 — scan page source for m3u8/mp4 (handles URLs in quotes, even with spaces)
  if (!url) {
    // Match URLs delimited by quotes: captures spaces and brackets inside URL
    const match = html.match(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*?)["']/i);
    if (match) url = match[1];
  }
  // Fallback: strict no-whitespace version
  if (!url) {
    const match = html.match(/(https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*)/i);
    if (match) url = match[1];
  }

  if (url) {
    // Encode spaces and brackets that browsers auto-encode but JS strings don't
    url = url.replace(/ /g, '%20').replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    streamCache.set(cacheKey, url, 2 * 60 * 60_000); // 2h TTL for individual streams
    log.info('stream found', { episodeLink, url: url.slice(0, 80) });
  } else {
    log.warn('no stream found', { episodeLink });
  }

  return url;
}

function _isAdIframe(src) {
  return /a-ads\.com|googleads|doubleclick|facebook\.com\/plugins|syndication|adform|exoclick|adsrvr/i.test(src);
}

function _qualityLabel(url = '') {
  if (/2160|4k|uhd/i.test(url))  return '4K';
  if (/1080/i.test(url))          return '1080p';
  if (/720/i.test(url))           return '720p';
  if (/480/i.test(url))           return '480p';
  if (/360/i.test(url))           return '360p';
  if (/\.m3u8/i.test(url))       return 'HLS';
  if (/\.mp4/i.test(url))        return 'MP4';
  return 'HD';
}

function _cleanTitle(raw) {
  const words = raw.trim().split(/\s+/);
  const seen = new Set();
  return words.filter(w => { if (seen.has(w)) return false; seen.add(w); return true; }).join(' ');
}

/**
 * Build a basic meta using only TMDB when the provider page cannot be fetched.
 * Used when Cloudflare bypass fails on Vercel without a proxy configured.
 */
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
    // Poster priority: TopPoster > RPDB > TMDB
    const tp = topPosterUrl(config.topPosterKey, tmdb.imdbId);
    if (tp) {
      base.poster = tp;
    } else if (config.rpdbKey && tmdb.imdbId) {
      const rpdb = rpdbPosterUrl(config.rpdbKey, tmdb.imdbId);
      if (rpdb) base.poster = rpdb;
    }
    metaCache.set(seriesId, base);
  } catch (e) { /* TMDB unavailable — return basic meta */ }
  return base;
}

function _emptyMeta(id) {
  return { id, type: 'series', name: id.replace(/^rama_/, '').replace(/-/g, ' '), episodes: [] };
}

module.exports = { getCatalog, getMeta, getStreams };
