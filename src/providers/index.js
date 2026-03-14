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
 *   "rama_*"    → Rama provider     (type: series)
 *   "tt*"       → Cinemeta IMDB ID  (search both providers by title)
 *
 * Catalog IDs:
 *   "kisskh_catalog"  → KissKH
 *   "rama_catalog"    → Rama
 */

const axios           = require('axios');
const kisskh          = require('./kisskh');
const rama            = require('./rama');
// Drammatica and legacy Guardaserie removed

// Orchestratore completo easystreams (include tutti i provider originali)
const easystreams = require('../index');

const { withTimeout } = require('../utils/fetcher');
const { titleSimilarity } = require('../utils/titleHelper');
const { findTitleByImdbId } = require('../utils/tmdb');
const { createLogger } = require('../utils/logger');

const log = createLogger('aggregator');

// Configurable timeouts (ms)
const CATALOG_TIMEOUT  = Number(process.env.CATALOG_TIMEOUT)  || 12_000;
const META_TIMEOUT     = Number(process.env.META_TIMEOUT)     || 12_000;
const STREAM_TIMEOUT   = Number(process.env.STREAM_TIMEOUT)   || 30_000;
const CINEMETA_TIMEOUT = 5_000;
const IMDB_PROVIDER_TIMEOUT = Number(process.env.IMDB_PROVIDER_TIMEOUT) || 15_000;
const ENABLE_LEGACY_ENGINE = String(process.env.ENABLE_LEGACY_ENGINE || '').trim() === '1';
const ENABLE_GUARDASERIE_LEGACY_IMDB = String(process.env.ENABLE_GUARDASERIE_LEGACY_IMDB || '').trim() === '1';
const IMDB_EPISODE_CACHE_TTL = Number(process.env.IMDB_EPISODE_CACHE_TTL) || 6 * 60 * 60_000;
const IMDB_NO_MATCH_CACHE_TTL = Number(process.env.IMDB_NO_MATCH_CACHE_TTL) || 60_000;

const _imdbEpisodeCache = new Map();

// ─── In-memory stream response cache ──────────────────────────────────────────
// Short-lived cache for stream results. Avoids redundant scraping when Stremio
// re-requests the same ID within a few minutes (e.g. user browses back/forth).
const _streamCache = new Map();
const STREAM_CACHE_TTL = 5 * 60_000;     // 5 minutes
const STREAM_CACHE_MAX = 200;            // max entries to prevent memory leaks

// ─── Request deduplication queue ──────────────────────────────────────────────
// If the same ID is requested concurrently (Stremio often fires 2-3 requests at once),
// reuse the in-flight Promise instead of launching parallel scrapes.
const _inflightRequests = new Map();

function _cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.exp <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function _cacheSet(map, key, value, ttl) {
  map.set(key, { value, exp: Date.now() + ttl });
}

function _isProviderEnabled(config, providerName) {
  const p = config?.providers;
  if (!p || p === 'all') return true;
  if (Array.isArray(p)) return p.includes(providerName);
  if (typeof p === 'string') {
    if (p.includes(',')) return p.split(',').map(s => s.trim()).includes(providerName);
    return p === providerName;
  }
  return false;
}

function _isAnyProviderEnabled(config, providerNames) {
  if (!Array.isArray(providerNames) || providerNames.length === 0) return false;
  return providerNames.some(name => _isProviderEnabled(config, name));
}

function _hasExplicitProviderSelection(config) {
  const providers = config?.providers;
  if (!providers || providers === 'all') return false;
  if (Array.isArray(providers)) return providers.length > 0;
  return String(providers).trim().length > 0 && String(providers).trim() !== 'all';
}

function _fallbackMetaForId(id, type = 'series') {
  const clean = String(id || '')
    .replace(/^(kisskh_|rama_|drammatica_|guardaserie_)/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return {
    id,
    type,
    name: clean ? clean.replace(/\b\w/g, c => c.toUpperCase()) : id,
    description: 'Metadata temporaneamente non disponibile. Riprova tra pochi secondi.',
    videos: [],
  };
}

// ─── Catalog handler ─────────────────────────────────────────────────────────

/**
 * @param {'series'} type
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
    if (catalogId === 'kisskh_catalog') {
      const metas = await withTimeout(kisskh.getCatalog(skip, search, config), CATALOG_TIMEOUT, 'kisskh.getCatalog');
      return { metas };
    }

    if (catalogId === 'rama_catalog') {
      const metas = await withTimeout(rama.getCatalog(skip, search, config), CATALOG_TIMEOUT, 'rama.getCatalog');
      return { metas };
    }

    // Only Rama and KissKH catalogs remain

  } catch (err) {
    log.error(`catalog failed: ${err.message}`, { type, catalogId });
  }

  return { metas: [] };
}

// ─── Meta handler ─────────────────────────────────────────────────────────────

/**
 * @param {'series'} type
 * @param {string} id
 * @param {object} [config]
 * @returns {Promise<{meta: object|null}>}
 */
async function handleMeta(type, id, config = {}) {
  log.info('meta request', { type, id });

  try {
    let result = { meta: null };

    if (id.startsWith('kisskh_')) {
      result = await withTimeout(kisskh.getMeta(id, config), META_TIMEOUT, 'kisskh.getMeta');
      if (!result?.meta) result = { meta: _fallbackMetaForId(id, 'series') };
      const videos = Array.isArray(result.meta?.videos) ? result.meta.videos.length : 0;
      log.info('meta response', { id, provider: 'kisskh', hasMeta: !!result.meta, videos });
      return result;
    }

    if (id.startsWith('rama_')) {
      result = await withTimeout(rama.getMeta(id, config), META_TIMEOUT, 'rama.getMeta');
      if (!result?.meta) result = { meta: _fallbackMetaForId(id, 'series') };
      const videos = Array.isArray(result?.meta?.videos) ? result.meta.videos.length : 0;
      log.info('meta response', { id, provider: 'rama', hasMeta: !!result?.meta, videos });
      return result;
    }

    // Drammatica and legacy Guardaserie meta removed

  } catch (err) {
    log.error(`meta failed: ${err.message}`, { type, id });
    if (id.startsWith('kisskh_') || id.startsWith('rama_') || id.startsWith('drammatica_') || id.startsWith('guardaserie_')) {
      const fallback = { meta: _fallbackMetaForId(id, 'series') };
      log.warn('meta fallback served after error', { id });
      return fallback;
    }
  }

  return { meta: null };
}

// ─── Stream handler ───────────────────────────────────────────────────────────

/**
 * @param {'series'|'movie'} type
 * @param {string} id   May be composite: "kisskh_123:456", "tt1234567:1:2"
 * @param {object} [config]
 * @returns {Promise<{streams: Array}>}
 */
async function handleStream(type, id, config = {}) {
  log.info('stream request', { type, id });

  // ─── Stream response cache: return cached result if fresh ────────────────
  const cacheKey = `${type}:${id}`;
  const cachedResult = _cacheGet(_streamCache, cacheKey);
  if (cachedResult !== undefined) {
    log.info(`stream cache hit (${cachedResult.streams?.length || 0} streams)`, { id });
    return cachedResult;
  }

  // ─── Request dedup: if same ID is already in-flight, piggyback on it ─────
  const inflightKey = cacheKey;
  if (_inflightRequests.has(inflightKey)) {
    log.info('stream dedup: reusing in-flight request', { id });
    return _inflightRequests.get(inflightKey);
  }

  const promise = _handleStreamImpl(type, id, config).then(result => {
    // Cache the result (evict oldest if over limit)
    if (_streamCache.size >= STREAM_CACHE_MAX) {
      const oldest = _streamCache.keys().next().value;
      _streamCache.delete(oldest);
    }
    _cacheSet(_streamCache, cacheKey, result, STREAM_CACHE_TTL);
    return result;
  }).finally(() => {
    _inflightRequests.delete(inflightKey);
  });

  _inflightRequests.set(inflightKey, promise);
  return promise;
}

async function _handleStreamImpl(type, id, config = {}) {

  let streams = [];

  // Cinemeta / IMDB ID — e.g. "tt1234567:1:1"
  if (id.startsWith('tt')) {
    streams = await _fetchFromImdbId(id, type, config);
  } else if (id.startsWith('tmdb:') || id.startsWith('kitsu:')) {
    const useEasystreams = _isAnyProviderEnabled(config, [
      'all', 'easystreams', 'streamingcommunity', 'guardahd', 'guardaflix', 'guardaserie', 'guardoserie', 'animeunity', 'animeworld', 'animesaturn', 'cb01', 'eurostreaming'
    ]);
    
    if (useEasystreams) {
      const parts = id.split(':');
      let baseId, seasonNum = null, episodeNum = null;
      if (id.startsWith('tmdb:')) {
        baseId = `tmdb:${parts[1]}`;
        seasonNum = parts[2] ? Number(parts[2]) : null;
        episodeNum = parts[3] ? Number(parts[3]) : null;
      } else {
        baseId = `kitsu:${parts[1]}`;
        seasonNum = 1; // Kitsu IDs typically treat movies/series seasons as 1 unless mapped.
        episodeNum = parts[2] ? Number(parts[2]) : 1;
      }

      streams = await easystreams.getStreams(
        baseId, type === 'movie' ? 'movie' : 'series', seasonNum, episodeNum, config
      );
    }
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
    const streamKey = String(s?.url || s?.externalUrl || '').trim();
    if (!streamKey || seen.has(streamKey)) return false;
    seen.add(streamKey);
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

  // 1. Fetch title from Cinemeta (primary), then TMDB, then IMDb page fallback.
  //    v3-cinemeta.strem.io returns {} for Korean/Asian dramas when called from
  //    Vercel datacenter IPs — TMDB's /find endpoint covers all IMDB-indexed shows.
  let title = null;
  try {
    const metaType = type === 'movie' ? 'movie' : 'series';
    const resp = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`,
      { timeout: CINEMETA_TIMEOUT }
    );
    title = resp.data?.meta?.name || null;
  } catch (err) {
    log.warn(`Cinemeta meta fetch failed: ${err.message}`, { imdbId });
  }

  // Fallback #1: TMDB find endpoint
  if (!title) {
    const tmdbKey = config.tmdbKey || process.env.TMDB_API_KEY || '68e094699525b18a70bab2f86b1fa706';
    title = await findTitleByImdbId(imdbId, tmdbKey).catch(() => null);
  }

  // Fallback #2: IMDb public page (no API key needed)
  if (!title) {
    title = await _findTitleFromImdbPage(imdbId).catch(() => null);
  }

  if (!title) {
    log.warn('no title from Cinemeta or TMDB', { imdbId });
    return [];
  }
  log.info(`title resolved: "${title}"`, { imdbId });
  const titleCandidates = await _buildTitleCandidates(imdbId, type, config, title);
  log.info('title candidates', { imdbId, count: titleCandidates.length, titles: titleCandidates.slice(0, 5) });

  // 2. Search providers for the title, respecting `config.providers`
  const hasExplicitProviderSelection = _hasExplicitProviderSelection(config);
  // Drammatica and legacy Guardaserie removed
  
  // Provider easystreams completi (guardahd, guardaserie, guardoserie,
  // animeunity, animeworld, animesaturn, streamingcommunity, cb01, eurostreaming)
  const useEasystreams = _isAnyProviderEnabled(config, [
    'all',
    'easystreams',
    'streamingcommunity',
    'guardahd',
    'guardaflix',
    'guardaserie',
    'guardaserie-es',
    'guardoserie',
    'animeunity',
    'animeworld',
    'animesaturn',
    'cb01',
    'eurostreaming',
  ]);

  const useKisskh = _isProviderEnabled(config, 'kisskh');
  const useRama = _isProviderEnabled(config, 'rama');

  const jobs = [];
  const imdbJobTimeout = Math.max(1_000, Number(config?.imdbJobTimeout) || IMDB_PROVIDER_TIMEOUT);
  const runImdbJob = (label, fn, timeoutMs = imdbJobTimeout) => withTimeout(Promise.resolve().then(fn), timeoutMs, label).catch(e => {
    log.warn(`${label} failed: ${e.message}`);
    return [];
  });

  const providerTimeout = (name) => {
    if (name === 'kisskh.imdb') return Math.max(imdbJobTimeout, 20_000);
    if (name === 'guardaserie.imdb') return Math.max(imdbJobTimeout, 18_000);
    return imdbJobTimeout;
  };

  if (useKisskh) {
    jobs.push(runImdbJob('kisskh.imdb', () => _legacyProviderStreamsForImdb({
      provider: 'kisskh', imdbId, titleCandidates, seasonNum, episodeNum, config,
      searchTimeout: 20_000,
      catalogFn: kisskh.getCatalog,
      metaFn: kisskh.getMeta,
      streamsFn: kisskh.getStreams,
      forceSeasonOne: false,
    }), providerTimeout('kisskh.imdb')));
  }
  if (useRama) {
    jobs.push(runImdbJob('rama.imdb', () => _legacyProviderStreamsForImdb({
      provider: 'rama', imdbId, titleCandidates, seasonNum, episodeNum, config,
      searchTimeout: 8_000,
      catalogFn: rama.getCatalog,
      metaFn: rama.getMeta,
      streamsFn: rama.getStreams,
      forceSeasonOne: true,
    }), providerTimeout('rama.imdb')));
  }
  // Only Rama and KissKH legacy IMDB jobs remain
  
  // Lookup integrale tramite orchestratore easystreams originale.
  if (useEasystreams) {
    jobs.push(runImdbJob('easystreams.imdb', () => easystreams.getStreams(
      imdbId,
      type === 'movie' ? 'movie' : 'series',
      seasonNum,
      episodeNum,
      {
        ...config,
        primaryTitle: titleCandidates[0] || title,
        titleCandidates,
      }
    ), 25_000)); // Reduced: absolute cap is now 20s + buffer
  }

  // Legacy stream_engine is experimental and still includes mock adapters.
  // Keep it disabled by default to avoid IMDB route slowdowns/timeouts.
  const useLegacyEngine = config?.enableLegacyEngine === true || ENABLE_LEGACY_ENGINE;
  if (useLegacyEngine) {
    jobs.push(runImdbJob('legacy-engine.imdb', async () => {
      const streamEngine = require('../stream_engine/engine');
      const streams = await streamEngine.discover(title, rawId);
      if (!streams) return [];
      return streams.map(s => ({
        name: s.provider ? s.provider.toUpperCase() : 'Engine',
        title: `[${(s.type || 'stream').toUpperCase()}] ${s.quality} - ${s.size}\nAudio: ${s.audio_lang} | Sub: ${s.subtitles && s.subtitles.join(',') || 'N/A'}`,
        url: s.url,
      }));
    }));
  }

  const results = await Promise.all(jobs);
  return results.flat();
}

async function _tryTitleCandidates(candidates, runForTitle) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  for (const t of list) {
    const streams = await Promise.resolve().then(() => runForTitle(t)).catch(() => []);
    if (Array.isArray(streams) && streams.length > 0) return streams;
  }
  return [];
}

async function _legacyProviderStreamsForImdb(opts) {
  const {
    provider,
    imdbId,
    titleCandidates,
    seasonNum,
    episodeNum,
    config,
    searchTimeout,
    catalogFn,
    metaFn,
    streamsFn,
    forceSeasonOne,
  } = opts;

  const normalizedSeason = Number.isInteger(seasonNum) && seasonNum > 0 ? seasonNum : 1;
  const normalizedEpisode = Number.isInteger(episodeNum) && episodeNum > 0 ? episodeNum : 1;
  const seasonForMatch = forceSeasonOne ? 1 : normalizedSeason;
  const cacheKey = `${provider}:${imdbId}:${seasonForMatch}:${normalizedEpisode}`;

  const cachedEpisodeId = _cacheGet(_imdbEpisodeCache, cacheKey);
  if (cachedEpisodeId === '__NO_MATCH__') return [];

  if (cachedEpisodeId) {
    const cachedStreams = await withTimeout(
      streamsFn(cachedEpisodeId, config),
      STREAM_TIMEOUT,
      `${provider}.getStreams.cached`
    ).catch(() => []);

    if (Array.isArray(cachedStreams) && cachedStreams.length > 0) {
      return cachedStreams;
    }
  }

  const candidateList = Array.isArray(titleCandidates) && titleCandidates.length
    ? titleCandidates
    : [];
  let hadTransientFailure = false;

  for (const title of candidateList) {
    const metas = await withTimeout(
      catalogFn(0, title, config),
      searchTimeout,
      `${provider}.search`
    ).catch(() => null);
    if (metas === null) {
      hadTransientFailure = true;
      continue;
    }
    if (!Array.isArray(metas) || metas.length === 0) continue;

    const best = _bestMatch(metas, title);
    if (!best?.id) continue;

    const { meta } = await withTimeout(
      metaFn(best.id, config),
      META_TIMEOUT,
      `${provider}.getMeta`
    ).catch(() => {
      hadTransientFailure = true;
      return { meta: null };
    });

    const videos = Array.isArray(meta?.videos) ? meta.videos : [];
    if (!videos.length) continue;

    const ep = _matchEpisode(videos, seasonForMatch, normalizedEpisode);
    if (!ep?.id) continue;

    _cacheSet(_imdbEpisodeCache, cacheKey, ep.id, IMDB_EPISODE_CACHE_TTL);

    const streams = await withTimeout(
      streamsFn(ep.id, config),
      STREAM_TIMEOUT,
      `${provider}.getStreams`
    ).catch(() => {
      hadTransientFailure = true;
      return [];
    });

    if (Array.isArray(streams) && streams.length > 0) {
      return streams;
    }
  }

  if (!hadTransientFailure) {
    _cacheSet(_imdbEpisodeCache, cacheKey, '__NO_MATCH__', IMDB_NO_MATCH_CACHE_TTL);
  }
  return [];
}

async function _buildTitleCandidates(imdbId, type, config, primaryTitle) {
  const set = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    set.add(s);
  };

  add(primaryTitle);

  const tmdbKey = config.tmdbKey || process.env.TMDB_API_KEY || '68e094699525b18a70bab2f86b1fa706';
  if (tmdbKey && imdbId) {
    try {
      const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${tmdbKey}&external_source=imdb_id&language=it-IT`;
      const findResp = await axios.get(findUrl, { timeout: 5000 });
      const isMovie = type === 'movie';
      const hit = isMovie
        ? findResp?.data?.movie_results?.[0]
        : findResp?.data?.tv_results?.[0] || findResp?.data?.movie_results?.[0];

      const tmdbId = hit?.id;
      if (tmdbId) {
        const endpoint = isMovie ? 'movie' : 'tv';
        const detailUrl = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${tmdbKey}&language=it-IT`;
        const d = await axios.get(detailUrl, { timeout: 5000 });
        const item = d?.data || {};
        add(item.name);
        add(item.original_name);
        add(item.title);
        add(item.original_title);

        // Also fetch English title (useful for K-dramas with no Italian title)
        try {
          const enUrl = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${tmdbKey}&language=en-US`;
          const enResp = await axios.get(enUrl, { timeout: 5000 });
          const en = enResp?.data || {};
          add(en.name);
          add(en.title);
        } catch (_) { /* best effort */ }
      }
    } catch (_) {
      // Best effort only
    }
  }

  return Array.from(set);
}

/**
 * Search KissKH by title, then get streams for the matching episode.
 */
async function _kisskhStreamsForTitle(title, seasonNum, episodeNum, config) {
  const SEARCH_TIMEOUT = 20_000; // KissKH API ignores `search=` param — must paginate up to 20 pages
  log.info('kisskh title search start', { title, seasonNum, episodeNum });
  const results = await withTimeout(kisskh.getCatalog(0, title, config), SEARCH_TIMEOUT, 'kisskh.search').catch(() => []);
  log.info('kisskh title search done', { title, count: results?.length || 0 });
  if (!results || !results.length) {
    log.warn('kisskh title search returned 0 results', { title });
    return [];
  }

  // Pick best title match
  const best = _bestMatch(results, title);
  if (!best) return [];
  log.info(`kisskh best match: "${best.name}" (${best.id})`, { title });

  // Get episode list
  const { meta } = await withTimeout(kisskh.getMeta(best.id, config), META_TIMEOUT, 'kisskh.getMeta').catch(() => ({ meta: null }));
  const videoCount = meta?.videos?.length || 0;
  log.info('kisskh meta fetched for best match', { bestId: best.id, videoCount });
  if (!meta || !meta.videos || !meta.videos.length) {
    log.warn('kisskh meta has no videos', { bestId: best.id, title: best.name });
    return [];
  }

  // Find matching episode
  const ep = _matchEpisode(meta.videos, seasonNum, episodeNum);
  if (!ep) {
    log.warn(`kisskh: no matching episode s${seasonNum}e${episodeNum} in "${best.name}"`);
    return [];
  }

  log.info('kisskh episode match found', { bestId: best.id, episodeId: ep.id, seasonNum, episodeNum });
  const streams = await withTimeout(kisskh.getStreams(ep.id, config), STREAM_TIMEOUT, 'kisskh.getStreams').catch(() => []);
  log.info('kisskh streams fetched', { episodeId: ep.id, count: streams?.length || 0 });
  return streams;
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

async function _drammaticaStreamsForTitle(title, episodeNum, config) {
  const SEARCH_TIMEOUT = 10_000;
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

async function _guardaserieStreamsForTitle(title, episodeNum, config) {
  const SEARCH_TIMEOUT = 10_000;
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

  // 2. Best fuzzy match with token overlap guard to avoid false positives
  // (e.g. "Game of Thrones" matching "Pyramid Game").
  let bestScore = 0;
  let bestOverlap = 0;
  let bestItem  = null;
  for (const m of metas) {
    const candidate = _normaliseTitle(m.name || m.title || '');
    const score = titleSimilarity(candidate, normQuery);
    const overlap = _tokenOverlap(candidate, normQuery);
    if (score > bestScore || (score === bestScore && overlap > bestOverlap)) {
      bestScore = score;
      bestOverlap = overlap;
      bestItem = m;
    }
  }

  const accepted = bestScore >= 0.72 || (bestScore >= 0.58 && bestOverlap >= 0.5);
  return accepted ? bestItem : null;
}

function _tokenOverlap(a, b) {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'la', 'il', 'lo', 'gli', 'le', 'di', 'del', 'della']);
  const toSet = (s) => new Set(String(s || '')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(x => x.length >= 3 && !stop.has(x)));

  const sa = toSet(a);
  const sb = toSet(b);
  if (!sa.size || !sb.size) return 0;

  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
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

/**
 * Resolve title directly from IMDb HTML as last fallback when APIs fail.
 * Works without API keys and keeps Cinemeta tt* flow alive if TMDB is unavailable.
 */
async function _findTitleFromImdbPage(imdbId) {
  if (!imdbId) return null;
  try {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    const { data: html } = await axios.get(url, {
      timeout: 7_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9,it-IT;q=0.8',
      },
    });

    const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    const rawTitle = og?.[1] || null;
    const cleaned = _cleanImdbTitle(rawTitle);

    if (cleaned) {
      log.info(`IMDb fallback: ${imdbId} → "${cleaned}"`);
      return cleaned;
    }
  } catch (err) {
    log.warn(`IMDb fallback failed for ${imdbId}: ${err.message}`);
  }
  return null;
}

function _cleanImdbTitle(title) {
  if (!title) return null;
  let t = String(title)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s*[-|]\s*IMDb\s*$/i, '')
    .replace(/\s*\((TV\s+Series|TV\s+Mini\s+Series|TV\s+Episode|Video|Short)[^)]*\)\s*$/i, '')
    .replace(/\s*\([^)]*\d{4}[^)]*\)\s*$/i, '');

  // IMDb often appends rating/genres after a star marker.
  if (t.includes('⭐')) t = t.split('⭐')[0];
  if (t.includes('|')) t = t.split('|')[0];

  return t.replace(/^\s*['"“”]+|['"“”]+\s*$/g, '').trim();
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
