const guardahd = require('./guardahd/index');
const guardaserie = require('./guardaserie/index');
const guardoserie = require('./guardoserie/index');
const streamingcommunity = require('./streamingcommunity/index');
const animeunity = require('./animeunity/index');
const animeworld = require('./animeworld/index');
const animesaturn = require('./animesaturn/index');
const { createTimeoutSignal } = require('./fetch_helper.js');

const TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
const CONTEXT_TIMEOUT = 3000;

async function fetchJsonWithTimeout(url, timeoutMs = CONTEXT_TIMEOUT) {
    if (typeof fetch === 'undefined') return null;

    const timeoutConfig = createTimeoutSignal(timeoutMs);

    try {
        const response = await fetch(url, { signal: timeoutConfig.signal });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        if (typeof timeoutConfig.cleanup === "function") {
            timeoutConfig.cleanup();
        }
    }
}

// Mapping API implementation
async function fetchMappingByRoute(route, value, season) {
    const MAPPING_API_URL = "https://animemapping.stremio.dpdns.org";
    if (!route || !value) return null;
    const encodedValue = encodeURIComponent(String(value).trim());
    let url = `${MAPPING_API_URL}/${route}/${encodedValue}`;
    if (Number.isInteger(season) && season >= 0) {
        url += `?season=${season}`;
    }
    return fetchJsonWithTimeout(url, 2000);
}

async function fetchMappingByKitsu(kitsuId, season) {
    const MAPPING_API_URL = "https://animemapping.stremio.dpdns.org";
    if (!kitsuId) return null;
    const encodedValue = encodeURIComponent(String(kitsuId).trim());
    let url = `${MAPPING_API_URL}/kitsu/${encodedValue}`;
    if (Number.isInteger(season) && season >= 0) {
        url += `?season=${season}`;
    }
    return fetchJsonWithTimeout(url, 2000);
}

function applyMappingHintsToContext(context, payload) {
    if (!context || !payload || typeof payload !== 'object') return;
    
    // The payload from this API wraps mapping data inside `.mappings.ids` or `.kitsu`, `.requested` etc.
    const mappingIds = payload.mappings?.ids || {};
    const kitsuDirect = payload.kitsu?.id || payload.requested?.resolvedKitsuId;

    const kitsuCandidate = String(kitsuDirect || mappingIds.kitsu || payload.kitsuId || payload.kitsu_id || '').trim();
    if (/^\d+$/.test(kitsuCandidate)) {
        context.kitsuId = kitsuCandidate;
    }
    
    const tmdbCandidate = String(mappingIds.tmdb || payload.tmdbId || '').trim();
    if (/^tmdb:\d+$/i.test(tmdbCandidate)) {
        context.tmdbId = tmdbCandidate.split(':')[1];
    } else if (/^\d+$/.test(tmdbCandidate)) {
        context.tmdbId = tmdbCandidate;
    } else if (/^tt\d+$/i.test(tmdbCandidate) && !context.imdbId) {
        context.imdbId = tmdbCandidate;
    }

    const imdbCandidate = String(mappingIds.imdb || payload.imdbId || '').trim();
    if (/^tt\d+$/i.test(imdbCandidate)) {
        context.imdbId = imdbCandidate;
    }
}

async function fetchTmdbIdFromImdb(imdbId, normalizedType) {
    if (!TMDB_API_KEY || !imdbId) return null;
    const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const payload = await fetchJsonWithTimeout(url);
    if (!payload || typeof payload !== 'object') return null;

    if (normalizedType === 'movie') {
        if (Array.isArray(payload.movie_results) && payload.movie_results.length > 0) {
            return payload.movie_results[0].id;
        }
        if (Array.isArray(payload.tv_results) && payload.tv_results.length > 0) {
            return payload.tv_results[0].id;
        }
    } else {
        if (Array.isArray(payload.tv_results) && payload.tv_results.length > 0) {
            return payload.tv_results[0].id;
        }
        if (Array.isArray(payload.movie_results) && payload.movie_results.length > 0) {
            return payload.movie_results[0].id;
        }
    }

    return null;
}

async function resolveProviderRequestContext(id, type, season, seasonProvided = false) {
    const parsedSeason = Number.parseInt(season, 10);
    const normalizedRequestedSeason =
        Number.isInteger(parsedSeason) && parsedSeason >= 0
            ? parsedSeason
            : null;

    const context = {
        idType: 'raw',
        providerId: String(id || ''),
        requestedSeason: normalizedRequestedSeason,
        seasonProvided: seasonProvided === true,
        kitsuId: null,
        tmdbId: null,
        imdbId: null,
        canonicalSeason: normalizedRequestedSeason
    };

    let rawId = String(id || '');
    try {
        rawId = decodeURIComponent(rawId);
    } catch {
        // keep raw id
    }
    const idStr = rawId.trim();

    try {
        if (idStr.startsWith('tmdb:')) {
            context.idType = 'tmdb';
            const parts = idStr.split(':');
            if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
                context.tmdbId = parts[1];
            }
            if (context.tmdbId) {
                const byTmdb = await fetchMappingByRoute('tmdb', context.tmdbId, context.requestedSeason);
                if (byTmdb) applyMappingHintsToContext(context, byTmdb);
            }
        } else if (idStr.startsWith('kitsu:')) {
            context.idType = 'kitsu';
            const parts = idStr.split(':');
            if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
                context.kitsuId = parts[1];
            }
            if (context.kitsuId) {
                const byKitsu = await fetchMappingByKitsu(context.kitsuId, context.requestedSeason);
                if (byKitsu) applyMappingHintsToContext(context, byKitsu);
            }
        } else if (/^tt\d+$/i.test(idStr)) {
            context.idType = 'imdb';
            context.imdbId = idStr;
            const byImdb = await fetchMappingByRoute('imdb', idStr, context.requestedSeason);
            if (byImdb) {
                applyMappingHintsToContext(context, byImdb);
            }

            if (!context.tmdbId) {
                const fallbackTmdbId = await fetchTmdbIdFromImdb(idStr, String(type || '').toLowerCase());
                if (fallbackTmdbId !== null && fallbackTmdbId !== undefined) {
                    context.tmdbId = String(fallbackTmdbId);
                }
            }
        } else if (/^\d+$/.test(idStr)) {
            context.idType = 'tmdb-numeric';
            context.tmdbId = idStr;
            if (context.tmdbId) {
                const byTmdb = await fetchMappingByRoute('tmdb', context.tmdbId, context.requestedSeason);
                if (byTmdb) applyMappingHintsToContext(context, byTmdb);
            }
        }
    } catch {
        // Keep partial context.
    }

    return context;
}

function isLikelyAnimeRequest(type) {
    const normalizedType = String(type || '').toLowerCase();
    return normalizedType === 'anime';
}

function buildProviderRequestContext(context, config = {}) {
    if (!context) return null;
    const titleCandidates = Array.isArray(config.titleCandidates)
        ? config.titleCandidates
            .map((value) => String(value || "").trim())
            .filter((value, index, array) => value && array.indexOf(value) === index)
        : [];
    return {
        __requestContext: true,
        idType: context.idType,
        providerId: context.providerId,
        requestedSeason: context.requestedSeason,
        seasonProvided: context.seasonProvided === true,
        kitsuId: context.kitsuId,
        tmdbId: context.tmdbId,
        imdbId: context.imdbId,
        addonBaseUrl: String(config.addonBaseUrl || '').trim(),
        mfpUrl: String(config.mfpUrl || '').trim(),
        mfpKey: String(config.mfpKey || '').trim(),
        proxyUrl: String(config.proxyUrl || '').trim(),
        primaryTitle: String(config.primaryTitle || '').trim(),
        titleCandidates
    };
}

async function getStreams(id, type, season, episode, config = {}) {
    const streams = [];
    const normalizedType = String(type || '').toLowerCase();
    const parsedNormalizedSeason = Number.parseInt(season, 10);
    const normalizedSeason =
        Number.isInteger(parsedNormalizedSeason) && parsedNormalizedSeason >= 0
            ? parsedNormalizedSeason
            : null;
    const normalizedEpisode = Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || 1);
    const providerContext = await resolveProviderRequestContext(id, normalizedType, normalizedSeason, false);
    const parsedCanonicalSeason = Number.parseInt(providerContext?.canonicalSeason, 10);
    const effectiveSeason =
        Number.isInteger(parsedCanonicalSeason) && parsedCanonicalSeason >= 0
            ? parsedCanonicalSeason
            : 1;
    const sharedContext = buildProviderRequestContext(providerContext, config);
    const promises = [];
    const likelyAnime = isLikelyAnimeRequest(normalizedType);

    const isKitsuRequest =
        String(providerContext?.idType || '').toLowerCase() === 'kitsu' ||
        /^kitsu:\d+$/i.test(String(id || '').trim()) || (providerContext && !!providerContext.kitsuId);

    const isImdbRequest =
        String(providerContext?.idType || '').toLowerCase() === 'imdb' ||
        /^tt\d+$/i.test(String(id || '').trim());
    const selectedProviders = [];
    if (normalizedType === 'movie') {
        if (likelyAnime || isKitsuRequest) {
            selectedProviders.push('animeunity', 'animeworld', 'animesaturn', 'guardoserie', 'streamingcommunity', 'guardahd');
        } else {
            selectedProviders.push('streamingcommunity', 'guardahd', 'guardoserie');
        }
    } else if (normalizedType === 'anime') {
        selectedProviders.push('animeunity', 'animeworld', 'animesaturn', 'guardaserie', 'guardoserie');
    } else if (normalizedType === 'tv' || normalizedType === 'series') {
        if (likelyAnime || isKitsuRequest) {
            selectedProviders.push('animeunity', 'animeworld', 'animesaturn', 'guardaserie', 'guardoserie', 'streamingcommunity');
        } else {
            if (isImdbRequest) {
                selectedProviders.push('streamingcommunity', 'guardaserie', 'guardoserie');
            } else {
                selectedProviders.push('streamingcommunity', 'guardaserie', 'guardoserie', 'animeunity', 'animeworld', 'animesaturn');
            }
        }
    } else {
        selectedProviders.push('streamingcommunity', 'guardahd', 'guardoserie');
    }

// Utility to set timeout per provider so one slow provider doesn't block the rest
      const withProviderTimeout = (providerName, promise, timeoutMs = 12000) => {
          let timeoutHandle;
          const timeoutPromise = new Promise((resolve) => {
              timeoutHandle = setTimeout(() => {
                  console.warn(`[Easystreams] Provider ${providerName} timed out after ${timeoutMs}ms`);
                  resolve({ provider: providerName, streams: [], status: 'fulfilled' });
              }, timeoutMs);
          });

          return Promise.race([
              promise.then(s => ({ provider: providerName, streams: s, status: 'fulfilled' }))
                     .catch(e => ({ provider: providerName, error: e, status: 'rejected' })),
              timeoutPromise
          ]).finally(() => clearTimeout(timeoutHandle));
      };

      for (const providerName of [...new Set(selectedProviders)]) {
          if (providerName === 'streamingcommunity') {
              promises.push(withProviderTimeout('StreamingCommunity', streamingcommunity.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext), 14000));
              continue;
          }
          if (providerName === 'guardahd') {
              promises.push(withProviderTimeout('GuardaHD', guardahd.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext)));
              continue;
          }
          if (providerName === 'guardaserie') {
              promises.push(withProviderTimeout('Guardaserie', guardaserie.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext)));
              continue;
          }
          if (providerName === 'animeunity') {
              promises.push(withProviderTimeout('AnimeUnity', animeunity.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext)));
              continue;
          }
          if (providerName === 'animeworld') {
              promises.push(withProviderTimeout('AnimeWorld', animeworld.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext)));
              continue;
          }
          if (providerName === 'animesaturn') {
              promises.push(withProviderTimeout('AnimeSaturn', animesaturn.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext)));
              continue;
          }
          if (providerName === 'guardoserie') {
              promises.push(withProviderTimeout('Guardoserie', guardoserie.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext)));
        }
    }

    const results = await Promise.all(promises);
    for (const result of results) {
        if (result.status === 'fulfilled' && result.streams) {
            streams.push(...result.streams);
        }
    }

    return streams;
}

module.exports = { getStreams };
