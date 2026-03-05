'use strict';

/**
 * TMDB (The Movie Database) enrichment utility
 *
 * Used to enrich Korean/Asian drama metadata with high-quality artwork,
 * full descriptions, cast lists, and IMDB IDs (required for RPDB).
 *
 * API docs: https://developer.themoviedb.org/docs
 *
 * RPDB (Rating Poster Database):
 *   Replaces standard posters with rated versions.
 *   Poster URL format: https://api.ratingposterdb.com/{key}/imdb/poster-default/{imdbId}.jpg
 *   Requires an IMDB ID, which we obtain via TMDB external_ids.
 */

const axios = require('axios');
const { createLogger } = require('./logger');
const { TTLCache } = require('./cache');

const log = createLogger('tmdb');
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE  = 'https://image.tmdb.org/t/p';

// TTL: 24h — metadata doesn't change often
const cache = new TTLCache({ ttl: 24 * 60 * 60_000, maxSize: 2000 });

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search TMDB for a TV series and return enriched metadata.
 *
 * @param {string} title     Series title (in any language)
 * @param {string|null} year Release year (optional, improves accuracy)
 * @param {string} apiKey    TMDB v3 API key
 * @returns {Promise<TmdbMeta|null>}
 *
 * @typedef {object} TmdbMeta
 * @property {string}   tmdbId
 * @property {string}   imdbId       — may be empty if not linked
 * @property {string}   poster       — https://image.tmdb.org/t/p/w500...
 * @property {string}   background   — https://image.tmdb.org/t/p/w1280...
 * @property {string}   description  — Italian (falls back to English)
 * @property {string[]} genres
 * @property {string[]} cast         — top 8 actor names
 * @property {string}   director
 * @property {string}   imdbRating   — e.g. "8.5"
 * @property {string}   releaseInfo  — year
 */
async function enrichFromTmdb(title, year, apiKey) {
  if (!apiKey || !title) return null;

  const cacheKey = `tmdb:${title}:${year || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // Step 1 — search by title (Italian language preferred, fallback English)
    const searchResult = await _searchTv(title, year, apiKey);
    if (!searchResult) {
      log.debug('TMDB no result', { title, year });
      return null;
    }

    // Step 2 — fetch full TV details + external IDs + credits in one call
    const detail = await _getTvDetail(searchResult.id, apiKey);
    if (!detail) return null;

    const meta = _buildMeta(searchResult.id, detail);
    cache.set(cacheKey, meta);
    log.info('TMDB enrichment OK', { title, tmdbId: meta.tmdbId, imdbId: meta.imdbId });
    return meta;
  } catch (err) {
    log.warn('TMDB enrichment failed', { title, err: err.message });
    return null;
  }
}

/**
 * Build an RPDB rated poster URL.
 * Returns null if apiKey or imdbId is missing.
 *
 * @param {string} rpdbKey
 * @param {string} imdbId   e.g. "tt1234567"
 * @returns {string|null}
 */
function rpdbPosterUrl(rpdbKey, imdbId) {
  if (!rpdbKey || !imdbId || !imdbId.startsWith('tt')) return null;
  return `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`;
}

/**
 * Build a TopPoster poster URL.
 * Returns null if apiKey or imdbId is missing.
 *
 * TopPoster API docs: https://api.top-streaming.stream/user/dashboard
 * Poster URL format: https://api.top-streaming.stream/{key}/imdb/poster-default/{imdbId}.jpg
 *
 * @param {string} topPosterKey
 * @param {string} imdbId   e.g. "tt1234567"
 * @returns {string|null}
 */
function topPosterUrl(topPosterKey, imdbId) {
  if (!topPosterKey || !imdbId || !imdbId.startsWith('tt')) return null;
  return `https://api.top-streaming.stream/${topPosterKey}/imdb/poster-default/${imdbId}.jpg`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _searchTv(title, year, apiKey) {
  // Try Italian first, then English
  for (const lang of ['it-IT', 'en-US']) {
    const params = new URLSearchParams({
      api_key: apiKey,
      query:   title,
      language: lang,
      page:    '1',
    });
    if (year) params.set('first_air_date_year', String(year));

    const { data } = await axios.get(`${TMDB_BASE}/search/tv?${params}`, { timeout: 8_000, headers: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' } });
    if (!data.results || !data.results.length) continue;

    // Prefer Korean-language results (original_language: 'ko')
    const koreanResults = data.results.filter(r => r.original_language === 'ko');
    const candidates   = koreanResults.length ? koreanResults : data.results;

    // Pick best match by title similarity
    const best = _bestMatch(title, candidates);
    if (best) return best;
  }
  return null;
}

async function _getTvDetail(tmdbId, apiKey) {
  const params = new URLSearchParams({
    api_key:            apiKey,
    language:           'it-IT',
    append_to_response: 'external_ids,credits,content_ratings',
  });
  const { data } = await axios.get(`${TMDB_BASE}/tv/${tmdbId}?${params}`, { timeout: 8_000, headers: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' } });
  return data || null;
}

function _buildMeta(tmdbId, d) {
  const imdbId = d.external_ids?.imdb_id || '';

  const poster     = d.poster_path    ? `${IMG_BASE}/w500${d.poster_path}`    : '';
  const background = d.backdrop_path  ? `${IMG_BASE}/w1280${d.backdrop_path}` : poster;

  // Description: TMDB returns Italian if exists, otherwise it may be empty → fallback to EN
  const description = (d.overview || '').trim();

  const genres = (d.genres || []).map(g => g.name).filter(Boolean);

  // Top 8 actors from credits
  const cast = (d.credits?.cast || []).slice(0, 8).map(a => a.name).filter(Boolean);

  // Director -- series creator or first director
  const directors = (d.credits?.crew || [])
    .filter(c => c.job === 'Director' || c.job === 'Series Director')
    .slice(0, 2)
    .map(c => c.name);
  const director = directors.join(', ');

  // IMDB/TMDB user rating
  const imdbRating = d.vote_average ? String(Math.round(d.vote_average * 10) / 10) : '';

  // Release year
  const releaseInfo = (d.first_air_date || '').slice(0, 4) || '';

  return {
    tmdbId: String(tmdbId),
    imdbId,
    poster,
    background,
    description,
    genres,
    cast,
    director,
    imdbRating,
    releaseInfo,
  };
}

/**
 * Simple title similarity: pick the result whose name lowercased contains the
 * query lowercased, or has the most words in common.
 */
function _bestMatch(query, results) {
  const q = query.toLowerCase().trim();
  // Exact or near-exact match first
  const exact = results.find(r =>
    (r.name || '').toLowerCase() === q ||
    (r.original_name || '').toLowerCase() === q
  );
  if (exact) return exact;

  // Contains match
  const contains = results.find(r =>
    (r.name || '').toLowerCase().includes(q) ||
    q.includes((r.name || '').toLowerCase())
  );
  if (contains) return contains;

  // Highest popularity among candidates
  return results.reduce((best, r) => (!best || r.popularity > best.popularity) ? r : best, null);
}

module.exports = { enrichFromTmdb, rpdbPosterUrl, topPosterUrl };
