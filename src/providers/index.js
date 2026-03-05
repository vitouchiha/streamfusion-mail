'use strict';

/**
 * Provider aggregator — StreamFusion Mail
 *
 * Routes requests to the correct provider based on ID prefix or catalog type,
 * runs parallel provider calls where applicable, applies configurable timeouts,
 * and merges/deduplicates results.
 *
 * ID prefixes:
 *   "kisskh_*"  → KissKH provider   (type: series)
 *   "rama_*"    → Rama provider     (type: kdrama)
 *   "tt*"       → Cinemeta IMDB ID  (search both providers by title)
 *
 * Catalog IDs:
 *   "kisskh_catalog"  → KissKH
 *   "rama_catalog"    → Rama
 */

const axios         = require('axios');
const kisskh        = require('./kisskh');
const rama          = require('./rama');
const drammatica    = require('./drammatica');
const guardaserie   = require('./guardaserie');
const { withTimeout } = require('../utils/fetcher');
const { titleSimilarity } = require('../utils/titleHelper');
const { createLogger } = require('../utils/logger');

const log = createLogger('aggregator');

// Configurable timeouts (ms)
const CATALOG_TIMEOUT  = Number(process.env.CATALOG_TIMEOUT)  || 25_000;
const META_TIMEOUT     = Number(process.env.META_TIMEOUT)     || 30_000;
const STREAM_TIMEOUT   = Number(process.env.STREAM_TIMEOUT)   || 45_000;
const CINEMETA_TIMEOUT = 5_000;

// ─── Catalog handler ─────────────────────────────────────────────────────────

/**
 * @param {'series'|'kdrama'} type
 * @param {string} catalogId
 * @param {object} extra  { search?, skip? }
 * @param {object} [config]
 * @returns {Promise<{metas: Array}>}
 */
async function handleCatalog(type, catalogId, extra = {}, config = {}) {
  const skip   = Number(extra.skip)   || 0;
  const search = String(extra.search  || '').trim();

  log.info('catalog request', { type, catalogId, skip, search });

  try {
    if (catalogId === 'kisskh_catalog' || type === 'series') {
      const metas = await withTimeout(kisskh.getCatalog(skip, search, config), CATALOG_TIMEOUT, 'kisskh.getCatalog');
      return { metas };
    }

    if (catalogId === 'rama_catalog') {
      const metas = await withTimeout(rama.getCatalog(skip, search, config), CATALOG_TIMEOUT, 'rama.getCatalog');
      return { metas };
    }

    if (catalogId === 'drammatica_catalog') {
      const metas = await withTimeout(drammatica.getCatalog(skip, search, config), CATALOG_TIMEOUT, 'drammatica.getCatalog');
      return { metas };
    }

    if (catalogId === 'guardaserie_catalog') {
      const metas = await withTimeout(guardaserie.getCatalog(skip, search, config), CATALOG_TIMEOUT, 'guardaserie.getCatalog');
      return { metas };
    }
  } catch (err) {
    log.error(`catalog failed: ${err.message}`, { type, catalogId });
  }

  return { metas: [] };
}

// ─── Meta handler ─────────────────────────────────────────────────────────────

/**
 * @param {'series'|'kdrama'} type
 * @param {string} id
 * @param {object} [config]
 * @returns {Promise<{meta: object|null}>}
 */
async function handleMeta(type, id, config = {}) {
  log.info('meta request', { type, id });

  try {
    if (id.startsWith('kisskh_')) {
      const result = await withTimeout(kisskh.getMeta(id, config), META_TIMEOUT, 'kisskh.getMeta');
      return result || { meta: null };
    }

    if (id.startsWith('rama_')) {
      const result = await withTimeout(rama.getMeta(id, config), META_TIMEOUT, 'rama.getMeta');
      return result || { meta: null };
    }

    if (id.startsWith('drammatica_')) {
      const result = await withTimeout(drammatica.getMeta(id, config), META_TIMEOUT, 'drammatica.getMeta');
      return result || { meta: null };
    }

    if (id.startsWith('guardaserie_')) {
      const result = await withTimeout(guardaserie.getMeta(id, config), META_TIMEOUT, 'guardaserie.getMeta');
      return result || { meta: null };
    }
  } catch (err) {
    log.error(`meta failed: ${err.message}`, { type, id });
  }

  return { meta: null };
}

// ─── Stream handler ───────────────────────────────────────────────────────────

/**
 * @param {'series'|'kdrama'|'movie'} type
 * @param {string} id   May be composite: "kisskh_123:456", "tt1234567:1:2"
 * @param {object} [config]
 * @returns {Promise<{streams: Array}>}
 */
async function handleStream(type, id, config = {}) {
  log.info('stream request', { type, id });

  let streams = [];

  // Cinemeta / IMDB ID — e.g. "tt1234567:1:1"
  if (id.startsWith('tt')) {
    streams = await _fetchFromImdbId(id, type, config);
  } else {
    const results = await Promise.allSettled([
      _fetchFromProvider(id, type, config),
    ]);
    streams = results
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
      .flatMap(r => r.value);
  }

  // Deduplicate by URL
  const seen   = new Set();
  const unique = streams.filter(s => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  log.info(`stream: returning ${unique.length} streams`, { id });
  return { streams: unique };
}

// ─── Cinemeta / IMDB lookup ───────────────────────────────────────────────────

/**
 * Given a Cinemeta ID like "tt1234567:1:2" (series, season 1 ep 2) or "tt1234567" (movie),
 * fetch the title from Cinemeta, search our providers, and return matching streams.
 */
async function _fetchFromImdbId(rawId, type, config) {
  // Parse: "tt1234567"  or  "tt1234567:1:2"
  const parts     = rawId.split(':');
  const imdbId    = parts[0];
  const seasonNum  = parts[1] ? Number(parts[1]) : null;
  const episodeNum = parts[2] ? Number(parts[2]) : null;

  log.info('Cinemeta lookup', { imdbId, seasonNum, episodeNum, type });

  // 1. Fetch title from Cinemeta
  let title = null;
  try {
    const metaType = type === 'movie' ? 'movie' : 'series';
    const resp = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`,
      { timeout: CINEMETA_TIMEOUT }
    );
    title = resp.data?.meta?.name;
  } catch (err) {
    log.warn(`Cinemeta meta fetch failed: ${err.message}`, { imdbId });
    return [];
  }
  if (!title) {
    log.warn('no title from Cinemeta', { imdbId });
    return [];
  }
  log.info(`Cinemeta title: "${title}"`, { imdbId });

  // 2. Search providers for the title, respecting `config.providers`
  const useKisskh     = !config.providers || config.providers === 'all' || config.providers === 'kisskh';
  const useRama       = !config.providers || config.providers === 'all' || config.providers === 'rama';
  const useDrammatica = !config.providers || config.providers === 'all' || config.providers === 'drammatica';
  const useGuardaserie = !config.providers || config.providers === 'all' || config.providers === 'guardaserie';

  const jobs = [];
  if (useKisskh)      jobs.push(_kisskhStreamsForTitle(title, seasonNum, episodeNum, config).catch(e => { log.warn(`kisskh title search failed: ${e.message}`); return []; }));
  if (useRama)        jobs.push(_ramaStreamsForTitle(title, episodeNum, config).catch(e => { log.warn(`rama title search failed: ${e.message}`); return []; }));
  if (useDrammatica)  jobs.push(_drammaticaStreamsForTitle(title, episodeNum, config).catch(e => { log.warn(`drammatica title search failed: ${e.message}`); return []; }));
  if (useGuardaserie) jobs.push(_guardaserieStreamsForTitle(title, episodeNum, config).catch(e => { log.warn(`guardaserie title search failed: ${e.message}`); return []; }));

  const results = await Promise.all(jobs);
  return results.flat();
}

/**
 * Search KissKH by title, then get streams for the matching episode.
 */
async function _kisskhStreamsForTitle(title, seasonNum, episodeNum, config) {
  const SEARCH_TIMEOUT = 8_000;
  const results = await withTimeout(kisskh.getCatalog(0, title, config), SEARCH_TIMEOUT, 'kisskh.search').catch(() => []);
  if (!results || !results.length) return [];

  // Pick best title match
  const best = _bestMatch(results, title);
  if (!best) return [];
  log.info(`kisskh best match: "${best.name}" (${best.id})`, { title });

  // Get episode list
  const { meta } = await withTimeout(kisskh.getMeta(best.id, config), META_TIMEOUT, 'kisskh.getMeta').catch(() => ({ meta: null }));
  if (!meta || !meta.videos || !meta.videos.length) return [];

  // Find matching episode
  const ep = _matchEpisode(meta.videos, seasonNum, episodeNum);
  if (!ep) {
    log.warn(`kisskh: no matching episode s${seasonNum}e${episodeNum} in "${best.name}"`);
    return [];
  }

  return withTimeout(kisskh.getStreams(ep.id, config), STREAM_TIMEOUT, 'kisskh.getStreams').catch(() => []);
}

/**
 * Search Rama by title, then get streams for the matching episode.
 */
async function _ramaStreamsForTitle(title, episodeNum, config) {
  const SEARCH_TIMEOUT = 8_000;
  const results = await withTimeout(rama.getCatalog(0, title, config), SEARCH_TIMEOUT, 'rama.search').catch(() => []);
  if (!results || !results.length) return [];

  const best = _bestMatch(results, title);
  if (!best) return [];
  log.info(`rama best match: "${best.name}" (${best.id})`, { title });

  // Get meta + episodes for this series
  const { meta } = await withTimeout(rama.getMeta(best.id, config), META_TIMEOUT, 'rama.getMeta').catch(() => ({ meta: null }));
  if (!meta || !meta.videos || !meta.videos.length) return [];

  // Find episode by sequential number (Rama always uses season=1)
  const ep = _matchEpisode(meta.videos, 1, episodeNum);
  if (!ep) {
    log.warn(`rama: no matching episode e${episodeNum} in "${best.name}"`);
    return [];
  }

  return withTimeout(rama.getStreams(ep.id, config), STREAM_TIMEOUT, 'rama.getStreams').catch(() => []);
}

/**
 * Search Drammatica by title, then get streams for the matching episode.
 */
async function _drammaticaStreamsForTitle(title, episodeNum, config) {
  const SEARCH_TIMEOUT = 8_000;
  const results = await withTimeout(drammatica.getCatalog(0, title, config), SEARCH_TIMEOUT, 'drammatica.search').catch(() => []);
  if (!results || !results.length) return [];

  const best = _bestMatch(results, title);
  if (!best) return [];
  log.info(`drammatica best match: "${best.name}" (${best.id})`, { title });

  const { meta } = await withTimeout(drammatica.getMeta(best.id, config), META_TIMEOUT, 'drammatica.getMeta').catch(() => ({ meta: null }));
  if (!meta || !meta.videos || !meta.videos.length) return [];

  const ep = _matchEpisode(meta.videos, 1, episodeNum);
  if (!ep) {
    log.warn(`drammatica: no matching episode e${episodeNum} in "${best.name}"`);
    return [];
  }

  return withTimeout(drammatica.getStreams(ep.id, config), STREAM_TIMEOUT, 'drammatica.getStreams').catch(() => []);
}

/**
 * Search Guardaserie by title, then get streams for the matching episode.
 */
async function _guardaserieStreamsForTitle(title, episodeNum, config) {
  const SEARCH_TIMEOUT = 8_000;
  const results = await withTimeout(guardaserie.getCatalog(0, title, config), SEARCH_TIMEOUT, 'guardaserie.search').catch(() => []);
  if (!results || !results.length) return [];

  const best = _bestMatch(results, title);
  if (!best) return [];
  log.info(`guardaserie best match: "${best.name}" (${best.id})`, { title });

  const { meta } = await withTimeout(guardaserie.getMeta(best.id, config), META_TIMEOUT, 'guardaserie.getMeta').catch(() => ({ meta: null }));
  if (!meta || !meta.videos || !meta.videos.length) return [];

  const ep = _matchEpisode(meta.videos, 1, episodeNum);
  if (!ep) {
    log.warn(`guardaserie: no matching episode e${episodeNum} in "${best.name}"`);
    return [];
  }

  return withTimeout(guardaserie.getStreams(ep.id, config), STREAM_TIMEOUT, 'guardaserie.getStreams').catch(() => []);
}

/**
 * Normalise a title for comparison: lowercase, remove punctuation, collapse spaces.
 * Handles both English and romanised Korean titles better.
 */
function _normaliseTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pick the best-matching meta item from a catalog result by title similarity.
 * Tries exact normalised match first, then similarity score.
 */
function _bestMatch(metas, queryTitle) {
  const normQuery = _normaliseTitle(queryTitle);

  // 1. Exact normalised match
  const exact = metas.find(m => _normaliseTitle(m.name || m.title || '') === normQuery);
  if (exact) return exact;

  // 2. Best fuzzy match (threshold 0.45 — slightly more permissive for romanised titles)
  let bestScore = 0;
  let bestItem  = null;
  for (const m of metas) {
    const score = titleSimilarity(_normaliseTitle(m.name || m.title || ''), normQuery);
    if (score > bestScore) { bestScore = score; bestItem = m; }
  }
  return bestScore >= 0.45 ? bestItem : null;
}

/**
 * Find a video in a videos array by season + episode number.
 * Handles both KissKH (uses `episode` field) and Rama (uses `number` field).
 */
function _matchEpisode(videos, seasonNum, episodeNum) {
  if (!episodeNum) return videos[0] || null;

  // Normalise: accept `episode` OR `number` on each video
  const epNum = v => v.episode ?? v.number ?? null;

  // Exact match: season + episode
  if (seasonNum !== null && seasonNum !== undefined) {
    const exact = videos.find(v => v.season === seasonNum && epNum(v) === episodeNum);
    if (exact) return exact;
  }
  // Fallback: just episode / sequential number (Korean dramas always season=1)
  return videos.find(v => epNum(v) === episodeNum) || null;
}

// ─── Native-prefix provider dispatch ─────────────────────────────────────────

async function _fetchFromProvider(id, type, config = {}) {
  // Determine provider by ID prefix
  if (id.startsWith('kisskh_')) {
    return withTimeout(kisskh.getStreams(id, config), STREAM_TIMEOUT, 'kisskh.getStreams');
  }
  if (id.startsWith('rama_')) {
    return withTimeout(rama.getStreams(id, config), STREAM_TIMEOUT, 'rama.getStreams');
  }
  if (id.startsWith('drammatica_')) {
    return withTimeout(drammatica.getStreams(id, config), STREAM_TIMEOUT, 'drammatica.getStreams');
  }
  if (id.startsWith('guardaserie_')) {
    return withTimeout(guardaserie.getStreams(id, config), STREAM_TIMEOUT, 'guardaserie.getStreams');
  }

  // Unknown prefix — try all providers in parallel and merge
  log.warn('unknown id prefix, trying all providers', { id });
  const allResults = await Promise.allSettled([
    withTimeout(kisskh.getStreams(`kisskh_${id}`, config), STREAM_TIMEOUT, 'kisskh.getStreams.fallback'),
    withTimeout(rama.getStreams(`rama_${id}`, config), STREAM_TIMEOUT, 'rama.getStreams.fallback'),
    withTimeout(drammatica.getStreams(`drammatica_${id}`, config), STREAM_TIMEOUT, 'drammatica.getStreams.fallback'),
    withTimeout(guardaserie.getStreams(`guardaserie_${id}`, config), STREAM_TIMEOUT, 'guardaserie.getStreams.fallback'),
  ]);

  return allResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

module.exports = { handleCatalog, handleMeta, handleStream };
