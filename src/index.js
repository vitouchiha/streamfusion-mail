const guardahd = require('./guardahd/index');
const guardaflix = require('./guardaflix/index');
const toonitalia = require('./toonitalia/index');
const loonex = require('./loonex/index');
const guardaserie = require('./guardaserie/index');
const guardoserie = require('./guardoserie/index');
const streamingcommunity = require('./streamingcommunity/index');
const animeunity = require('./animeunity/index');
const animeworld = require('./animeworld/index');
const animesaturn = require('./animesaturn/index');
const cb01 = require('./cb01/index');
const eurostreaming = require('./eurostreaming/index');
const { createTimeoutSignal } = require('./fetch_helper.js');
const { wrapProviderStreamsWithMfp } = require('./utils/mediaflow');
const mapping = require('./mapping/index');

const { TMDB_API_KEY } = require('./utils/config');
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

// Internal Mapping API (replaces external animemapping.stremio.dpdns.org)
async function fetchMappingByRoute(route, value, season, episode) {
    if (!route || !value) return null;
    try {
        const options = {};
        if (Number.isInteger(season) && season >= 0) options.season = season;
        if (Number.isInteger(episode) && episode > 0) options.episode = episode;
        return await mapping.resolve(route, value, options);
    } catch { return null; }
}

async function fetchMappingByKitsu(kitsuId, season, episode) {
    if (!kitsuId) return null;
    try {
        const options = {};
        if (Number.isInteger(season) && season >= 0) options.season = season;
        if (Number.isInteger(episode) && episode > 0) options.episode = episode;
        return await mapping.resolve("kitsu", kitsuId, options);
    } catch { return null; }
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

async function resolveProviderRequestContext(id, type, season, episode, seasonProvided = false) {
    const parsedSeason = Number.parseInt(season, 10);
    const normalizedRequestedSeason =
        Number.isInteger(parsedSeason) && parsedSeason >= 0
            ? parsedSeason
            : null;
    const normalizedEp = Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || null);

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
                const byTmdb = await fetchMappingByRoute('tmdb', context.tmdbId, context.requestedSeason, normalizedEp);
                if (byTmdb) applyMappingHintsToContext(context, byTmdb);
            }
        } else if (idStr.startsWith('kitsu:')) {
            context.idType = 'kitsu';
            const parts = idStr.split(':');
            if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
                context.kitsuId = parts[1];
            }
            if (context.kitsuId) {
                const byKitsu = await fetchMappingByKitsu(context.kitsuId, context.requestedSeason, normalizedEp);
                if (byKitsu) applyMappingHintsToContext(context, byKitsu);
            }
        } else if (/^tt\d+$/i.test(idStr.split(':')[0])) {
            const rawImdbId = idStr.split(':')[0];
            context.idType = 'imdb';
            context.imdbId = rawImdbId;
            const byImdb = await fetchMappingByRoute('imdb', rawImdbId, context.requestedSeason, normalizedEp);
            if (byImdb) {
                applyMappingHintsToContext(context, byImdb);
            }

            if (!context.tmdbId) {
                const fallbackTmdbId = await fetchTmdbIdFromImdb(rawImdbId, String(type || '').toLowerCase());
                if (fallbackTmdbId !== null && fallbackTmdbId !== undefined) {
                    context.tmdbId = String(fallbackTmdbId);
                }
            }
        } else if (/^\d+$/.test(idStr.split(':')[0])) {
            const rawTmdbId = idStr.split(':')[0];
            context.idType = 'tmdb-numeric';
            context.tmdbId = rawTmdbId;
            if (context.tmdbId) {
                const byTmdb = await fetchMappingByRoute('tmdb', context.tmdbId, context.requestedSeason, normalizedEp);
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
        providers: config.providers,
        primaryTitle: String(config.primaryTitle || '').trim(),
        titleCandidates
    };
}

function normalizeRequestedProviders(config) {
    const raw = config && config.providers;
    if (!raw || raw === 'all' || raw === 'easystreams') return null;

    const values = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);

    const aliasMap = new Map([
        ['streamingcommunity', 'streamingcommunity'],
        ['guardahd', 'guardahd'],
        ['guardaflix', 'guardaflix'],
        ['guardaserie', 'guardaserie'],
        ['guardaserie-es', 'guardaserie'],
        ['guardoserie', 'guardoserie'],
        ['animeunity', 'animeunity'],
        ['animeworld', 'animeworld'],
        ['animesaturn', 'animesaturn'],
        ['toonitalia', 'toonitalia'],
        ['loonex', 'loonex'],
        ['cb01', 'cb01'],
        ['eurostreaming', 'eurostreaming'],
    ]);

    const normalized = new Set();
    for (const value of values) {
        const key = String(value || '').trim().toLowerCase();
        if (!key || key === 'all' || key === 'easystreams') return null;
        const mapped = aliasMap.get(key);
        if (mapped) normalized.add(mapped);
    }

    return normalized.size > 0 ? normalized : null;
}

async function getStreams(id, type, season, episode, config = {}) {
    const normalizedType = String(type || '').toLowerCase();
    const parsedNormalizedSeason = Number.parseInt(season, 10);
    const normalizedSeason =
        Number.isInteger(parsedNormalizedSeason) && parsedNormalizedSeason >= 0
            ? parsedNormalizedSeason
            : null;
    const normalizedEpisode = Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || 1);
    const providerContext = await resolveProviderRequestContext(id, normalizedType, normalizedSeason, normalizedEpisode, false);
    const parsedCanonicalSeason = Number.parseInt(providerContext?.canonicalSeason, 10);
    const effectiveSeason =
        Number.isInteger(parsedCanonicalSeason) && parsedCanonicalSeason >= 0
            ? parsedCanonicalSeason
            : 1;
    const sharedContext = buildProviderRequestContext(providerContext, config);
    const promises = [];
    const likelyAnime = isLikelyAnimeRequest(normalizedType);
    const requestedProviders = normalizeRequestedProviders(config);

    const isKitsuRequest =
        String(providerContext?.idType || '').toLowerCase() === 'kitsu' ||
        /^kitsu:\d+$/i.test(String(id || '').trim()) || (providerContext && !!providerContext.kitsuId);

    const isImdbRequest =
        String(providerContext?.idType || '').toLowerCase() === 'imdb' ||
        /^tt\d+$/i.test(String(id || '').trim());
    const selectedProviders = [];
    if (normalizedType === 'movie') {
        if (likelyAnime || isKitsuRequest) {
            selectedProviders.push('animeunity', 'animeworld', 'animesaturn', 'toonitalia', 'loonex', 'guardoserie', 'streamingcommunity', 'guardahd');
        } else {
            selectedProviders.push('streamingcommunity', 'guardahd', 'guardaflix', 'guardoserie', 'toonitalia', 'loonex', 'cb01');
        }
    } else if (normalizedType === 'anime') {
        selectedProviders.push('animeunity', 'animeworld', 'animesaturn', 'toonitalia', 'loonex', 'guardaserie', 'guardoserie');
    } else if (normalizedType === 'tv' || normalizedType === 'series') {
        if (likelyAnime || isKitsuRequest) {
            selectedProviders.push('animeunity', 'animeworld', 'animesaturn', 'toonitalia', 'loonex', 'guardaserie', 'guardoserie', 'streamingcommunity');
        } else {
            if (isImdbRequest) {
                selectedProviders.push('streamingcommunity', 'guardaserie', 'guardoserie', 'eurostreaming', 'cb01', 'toonitalia', 'loonex');
            } else {
                selectedProviders.push('streamingcommunity', 'guardaserie', 'guardoserie', 'animeunity', 'animeworld', 'animesaturn', 'toonitalia', 'loonex', 'eurostreaming', 'cb01');
            }
        }
    } else {
        selectedProviders.push('streamingcommunity', 'guardahd', 'guardoserie', 'toonitalia', 'loonex');
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

      // ── MFP-selective helpers ────────────────────────────────────────────────
      // Providers where MFP is applied instead of the internal HLS proxy.
      // EXCLUDED: guardaserie, guardahd, cb01, guardoserie — their streams use
      // IP-locked tokens (serversicuro.cc / mxcontent.net) that break when MFP
      // fetches from a different IP than the one that extracted them.
      const MFP_PROVIDERS = new Set(['guardaflix', 'animesaturn', 'animeunity']);

      // When MFP is configured, pass a context without addonBaseUrl to these providers
      // so formatStream doesn't apply the internal proxy (avoids double-wrapping).
      const ctxFor = (providerName) =>
        (sharedContext.mfpUrl && MFP_PROVIDERS.has(providerName))
          ? { ...sharedContext, addonBaseUrl: '' }
          : sharedContext;

      // Post-process a provider's stream promise with MFP when applicable
      const withMfp = (providerName, streamsPromise) => {
        if (!sharedContext.mfpUrl || !MFP_PROVIDERS.has(providerName)) return streamsPromise;
        return streamsPromise.then(ss => wrapProviderStreamsWithMfp(ss, sharedContext));
      };
      // ────────────────────────────────────────────────────────────────────────

      for (const providerName of [...new Set(selectedProviders)]) {
          if (requestedProviders && !requestedProviders.has(providerName)) {
              continue;
          }
          if (providerName === 'streamingcommunity') {
              promises.push(withProviderTimeout('StreamingCommunity', streamingcommunity.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext), 8000));
              continue;
          }
          if (providerName === 'guardahd') {
              promises.push(withProviderTimeout('GuardaHD', withMfp('guardahd', guardahd.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('guardahd'))), 12000));
              continue;
          }
          if (providerName === 'guardaserie') {
              promises.push(withProviderTimeout('Guardaserie', withMfp('guardaserie', guardaserie.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('guardaserie'))), 15000));
              continue;
          }
          if (providerName === 'animeunity') {
              promises.push(withProviderTimeout('AnimeUnity', withMfp('animeunity', animeunity.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('animeunity'))), 15000));
              continue;
          }
          if (providerName === 'animeworld') {
              promises.push(withProviderTimeout('AnimeWorld', animeworld.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext)));
              continue;
          }
          if (providerName === 'animesaturn') {
              promises.push(withProviderTimeout('AnimeSaturn', withMfp('animesaturn', animesaturn.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('animesaturn')))));
              continue;
          }
          if (providerName === 'toonitalia') {
                promises.push(withProviderTimeout('ToonItalia', toonitalia.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext), 12000));
                continue;
            }
            if (providerName === 'cb01') {
              promises.push(withProviderTimeout('CB01', withMfp('cb01', cb01.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('cb01'))), 30000));
                continue;
            }
            if (providerName === 'eurostreaming') {
              promises.push(withProviderTimeout('Eurostreaming', eurostreaming.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext), 15000));
                continue;
            }
            if (providerName === 'guardaflix') {
                promises.push(withProviderTimeout('Guardaflix', withMfp('guardaflix', guardaflix.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('guardaflix'))), 12000));
                continue;
            }
            if (providerName === 'loonex') {
                promises.push(withProviderTimeout('Loonex', loonex.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, sharedContext), 8000));
                continue;
            }
            if (providerName === 'guardoserie') {
              promises.push(withProviderTimeout('Guardoserie', withMfp('guardoserie', guardoserie.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('guardoserie'))), 15000));
        }
    }

    // Fast-path: collect streams as they arrive.
    // Strategy: absolute cap of 25s from start. Once the first provider returns
    // streams, give remaining providers a grace period to also finish.
    // Grace = min(remaining time until cap, GRACE_MS).
    const allStreams = [];
    const settled = new Map();
    const seenUrls = new Set();

    const ABSOLUTE_CAP_MS = 35000; // never wait more than 35s total (CB01 proxy chain can take 25s+)
    const GRACE_AFTER_FIRST_MS = 25000; // 25s grace after first streams arrive (gives CB01 full time for proxy chain)
    const MIN_WAIT_MS = 12000; // always wait at least 12s for slower providers

    await new Promise((resolveAll) => {
      let resolved = false;
      const startTime = Date.now();
      const finish = () => {
        if (!resolved && Date.now() - startTime >= MIN_WAIT_MS) {
          resolved = true; resolveAll();
        } else if (!resolved) {
          // Schedule finish after MIN_WAIT_MS
          setTimeout(() => { if (!resolved) { resolved = true; resolveAll(); } }, MIN_WAIT_MS - (Date.now() - startTime));
        }
      };
      const forceFinish = () => { if (!resolved) { resolved = true; resolveAll(); } };

      // Hard cap: always resolve after ABSOLUTE_CAP_MS
      const capTimeout = setTimeout(forceFinish, ABSOLUTE_CAP_MS);

      let graceTimeout = null;

      for (const p of promises) {
        p.then((result) => {
          if (resolved) return;
          settled.set(result.provider, result);
          if (result.status === 'fulfilled' && result.streams?.length > 0) {
            // Deduplicate streams by URL before adding
            for (const s of result.streams) {
              const url = String(s?.url || s?.externalUrl || '').trim();
              if (url && !seenUrls.has(url)) {
                seenUrls.add(url);
                allStreams.push(s);
              }
            }
            // Start grace timer on first successful result
            if (!graceTimeout) {
              graceTimeout = setTimeout(finish, GRACE_AFTER_FIRST_MS);
            }
          }
          // All done? Resolve immediately (bypass MIN_WAIT)
          if (settled.size >= promises.length) {
            clearTimeout(capTimeout);
            if (graceTimeout) clearTimeout(graceTimeout);
            forceFinish();
          }
        });
      }

      // Safety fallback
      Promise.all(promises).then(() => {
        clearTimeout(capTimeout);
        if (graceTimeout) clearTimeout(graceTimeout);
        forceFinish();
      });
    });

    return allStreams;
}

module.exports = { getStreams };
