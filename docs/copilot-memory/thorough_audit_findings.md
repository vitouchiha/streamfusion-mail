# Thorough Mapping Module Audit Findings

## Issue 1: Episode/Season Parameter Handling

### Flow Summary
Parameters flow: API callers → `fetchMappingByRoute()` / `fetchMappingByKitsu()` → `mapping.resolve()` → provider-specific resolvers

### PART 1: Parameter Entry Points in src/index.js

**Line 39-46: fetchMappingByRoute()**
```javascript
async function fetchMappingByRoute(route, value, season) {
    if (!route || !value) return null;
    try {
        const options = {};
        if (Number.isInteger(season) && season >= 0) options.season = season;
        return await mapping.resolve(route, value, options);  // ⚠️ ONLY season passed, NO episode!
    } catch { return null; }
}
```

**Line 48-55: fetchMappingByKitsu()**
```javascript
async function fetchMappingByKitsu(kitsuId, season) {
    if (!kitsuId) return null;
    try {
        const options = {};
        if (Number.isInteger(season) && season >= 0) options.season = season;
        return await mapping.resolve("kitsu", kitsuId, options);  // ⚠️ ONLY season, NO episode!
    } catch { return null; }
}
```

**⚠️ CRITICAL FINDING #1: Episode parameter is NEVER passed to mapping functions!**
- `fetchMappingByRoute()` accepts `season` but NOT `episode`
- `fetchMappingByKitsu()` accepts `season` but NOT `episode`
- Callers at lines 143, 153, 160, 176 only pass `context.requestedSeason`, never send episode

### PART 2: How resolve() Processes Parameters in src/mapping/index.js

**Line 638-651: Main resolve() function**
```javascript
async function resolve(provider, externalId, options = {}) {
  const p = String(provider || "").trim().toLowerCase();
  const id = String(externalId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  switch (p) {
    case "kitsu": return resolveByKitsu(id, options);
    case "tmdb": return resolveByTmdb(id, options);
    case "imdb": return resolveByImdb(id, options);
    case "mal":
    case "anilist":
    case "tvdb":
    case "anidb": return resolveByExternalProvider(p, id, options);
    default: return { ok: false, error: "unsupported_provider" };
  }
}
```

### PART 3: How resolveByKitsu() Handles Episode Parameters (Lines 589-637)

```javascript
async function resolveByKitsu(kitsuId, options = {}) {
  // Line 594: extracts episode from options
  const requestedEpisode = parseInt(String(options.episode || ""), 10) || null;
  const requestedSeason = Number.isInteger(parseInt(String(options.season ?? ""), 10))
    ? parseInt(String(options.season), 10)
    : null;

  // Line 604-607: Fetches Kitsu episode airdate
  let episodeAirdate = null;
  if (requestedEpisode) {
    episodeAirdate = await fetchKitsuEpisodeAirdate(id, requestedEpisode);
  }

  // Line 610-613: Resolves TMDB episode details
  let tmdbEpisode = null;
  if (tmdbId && requestedEpisode) {
    tmdbEpisode = await resolveTmdbEpisode(tmdbId, requestedEpisode, requestedSeason);
  }

  // Line 620-622: Searches provider paths
  const [animeWorldPaths, animeSaturnPaths, animeUnityPaths] = await Promise.all([
    searchAnimeWorld(searchTitles),
    searchAnimeSaturn(searchTitles),
    searchAnimeUnity(searchTitles, externalIds.anilist),  // ⚠️ Never passes episode!
  ]);

  // Line 625-637: Returns payload with episode data
  const payload = {
    ok: true,
    requested: {
      id: `kitsu:${id}`,
      numericId: id,
      ...(requestedEpisode ? { episode: requestedEpisode } : {}),  // ✓ Episode in requested
    },
    kitsu: {
      ...kitsuAnime,
      episode_airdate: episodeAirdate,
      ...(requestedEpisode ? { episode: requestedEpisode } : {}),  // ✓ Episode in kitsu object
    },
    mappings: {
      ids,
      ...(animeWorldPaths.length > 0 ? { animeworld: animeWorldPaths } : {}),
      ...(animeSaturnPaths.length > 0 ? { animesaturn: animeSaturnPaths } : {}),
      ...(animeUnityPaths.length > 0 ? { animeunity: animeUnityPaths } : {}),  // ❌ No episode info with paths
      ...(tmdbEpisode ? { tmdb_episode: tmdbEpisode } : {}),  // ✓ TMDB episode included
    },
  };
  return cacheSet(cacheKey, payload);
}
```

### PART 4: resolveTmdbEpisode() Details (Lines 390-442)

```javascript
async function resolveTmdbEpisode(tmdbId, requestedEpisode, requestedSeason) {
  if (!tmdbId || !requestedEpisode) return null;

  const key = `tmdb:ep:${tmdbId}:s${requestedSeason}:e${requestedEpisode}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const season = Number.isInteger(requestedSeason) && requestedSeason >= 0
    ? requestedSeason
    : 1;

  // Attempts direct season/episode lookup on TMDB
  const epData = await fetchJson(
    `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${requestedEpisode}?api_key=${TMDB_API_KEY}`
  );

  if (epData && epData.episode_number) {
    const result = {
      id: String(tmdbId),
      season: epData.season_number ?? season,
      episode: epData.episode_number,
      rawEpisodeNumber: requestedEpisode,
      absoluteEpisode: null,
      matchedBy: "season_episode",
      episodeUrl: `https://www.themoviedb.org/tv/${tmdbId}/season/${epData.season_number ?? season}/episode/${epData.episode_number}`,
    };
    return cacheSet(key, result);
  }

  // If direct lookup fails and season = 1, tries mapping as absolute episode
  if (season <= 1) {
    const showData = await fetchJson(
      `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=seasons`
    );
    // ... attempts to resolve as absolute episode to season/episode mapping
  }

  // Fallback returns what we have
  const fallback = {
    id: String(tmdbId),
    season,
    episode: requestedEpisode,
    rawEpisodeNumber: requestedEpisode,
    absoluteEpisode: null,
    matchedBy: "fallback",
    episodeUrl: `https://www.themoviedb.org/tv/${tmdbId}/season/${season}/episode/${requestedEpisode}`,
  };
  return cacheSet(key, fallback);
}
```

### PART 5: Episode Handling in resolveByTmdb() (Lines 552-573)

```javascript
async function resolveByTmdb(tmdbId, options = {}) {
  const id = String(tmdbId).replace(/^tmdb:/i, "").trim();
  if (!id || !/^\d+$/.test(id)) return { ok: false, error: "invalid_tmdb_id" };

  const kitsuId = await resolveKitsuIdFromTmdb(id);
  if (kitsuId) {
    const result = await resolveByKitsu(kitsuId, options);  // ✓ Passes options (with episode) to Kitsu resolver
    if (result?.ok) {
      result.requested = {
        provider: "tmdb",
        externalId: id,
        id: `tmdb:${id}`,
        resolvedKitsuId: kitsuId,
        ...(options.episode ? { episode: parseInt(String(options.episode), 10) } : {}),  // ✓ Extracts episode
      };
      return result;
    }
  }

  return buildMinimalTmdbResponse(id, options);  // ✓ Passes options with episode
}
```

### PART 6: Episode Handling in resolveByImdb() (Lines 574-612)

```javascript
async function resolveByImdb(imdbId, options = {}) {
  const id = String(imdbId).trim();
  if (!id || !/^tt\d+$/i.test(id)) return { ok: false, error: "invalid_imdb_id" };

  let kitsuId = await findKitsuIdByExternalId("imdb", id);
  
  if (kitsuId) {
    const result = await resolveByKitsu(kitsuId, options);  // ✓ Passes options through
    if (result?.ok) {
      result.requested = {
        provider: "imdb",
        externalId: id,
        id: `imdb:${id}`,
        resolvedKitsuId: kitsuId,
        ...(options.episode ? { episode: parseInt(String(options.episode), 10) } : {}),  // ✓ Extracts episode
      };
      return result;
    }
  }

  const fallbackTmdbId = resolvedTmdbId || await findTmdbIdFromExternal(id, "imdb_id");
  if (fallbackTmdbId) {
    return buildMinimalTmdbResponse(fallbackTmdbId, options, id);  // ✓ Passes options with episode
  }

  return { ok: false, error: "not_found" };
}
```

## FINDINGS: Episode/Season Parameter Threading

### ✓ CORRECT THREADING:
1. **resolveByKitsu()** extracts `options.episode` and `options.season` correctly (line 594)
2. **resolveTmdbEpisode()** receives episode and season and builds TMDB episode mapping
3. **Episode returned in payload** at `payload.requested.episode` and `payload.kitsu.episode`
4. **TMDB episode mapping returned** at `payload.mappings.tmdb_episode`

### ⚠️ PROBLEMS FOUND:

**PROBLEM #1: Episode never passed from callers to mapping functions**
- `fetchMappingByRoute()` and `fetchMappingByKitsu()` only accept `season`, NO `episode` parameter
- Callers at lines 143, 153, 160, 176 only pass season, never episode
- This means when API receives `/kitsu/123?ep=5`, the episode is lost before reaching `resolve()`

**PROBLEM #2: searchAnimeUnity() never receives episode info**
- Line 620 calls `searchAnimeUnity(searchTitles, externalIds.anilist)` 
- Episode info is NOT passed, so AnimeUnity search returns generic paths without episode context
- Same issue with `searchAnimeWorld()` and `searchAnimeSaturn()`

**PROBLEM #3: TMDB episode info not passed to provider searches**
- Line 625-633: Response includes `tmdb_episode` in mappings, but provider paths (animeworld, animesaturn, animeunity) don't include episode hints
- Providers would need to fetch episodes separately after getting the anime path

## Issue 2: AnimeUnity Investigation

### searchAnimeUnity() Implementation (Lines 519-530 in src/mapping/index.js)

```javascript
async function searchAnimeUnity(titles, anilistId) {
  const base = getProviderBase("animeunity");
  if (!base) return [];

  // AnimeUnity is JS-rendered, standard HTML scraping doesn't work.
  // Try fetching by known AniList ID pattern if available.
  if (anilistId) {
    const key = `au:anilist:${anilistId}`;
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;

    // Try common AnimeUnity URL patterns using their internal search
    // AnimeUnity's URL format: /anime/{internal_id}-{slug}
    // We can't derive internal_id from AniList ID directly.
    // As fallback, return empty - the provider already handles this gracefully.
    return cacheSet(key, []);  // ❌ ALWAYS RETURNS EMPTY!
  }

  return [];  // ❌ ALWAYS RETURNS EMPTY!
}
```

**⚠️ CRITICAL FINDING #2: searchAnimeUnity() ALWAYS RETURNS EMPTY ARRAY!**
- No actual search is performed
- Even with AniList ID available, it just returns `[]`
- Comment says "we can't derive internal_id from AniList ID directly" but doesn't attempt fallback

### How AnimeUnity is Called in src/index.js (Line 510)

```javascript
if (providerName === 'animeunity') {
    promises.push(withProviderTimeout('AnimeUnity', 
      withMfp('animeunity', 
        animeunity.getStreams(id, normalizedType, effectiveSeason, normalizedEpisode, ctxFor('animeunity')), 
        25000)));
    continue;
}
```

**✓ AnimeUnity IS being called** with proper timeout handling

### AnimeUnity getStreams() Flow (src/animeunity/index.js Lines 1079-1158)

**Line 1079-1083: Entry point**
```javascript
async function getStreams(id, type, season, episode, providerContext = null) {
  try {
    const lookup = resolveLookupRequest(id, season, episode, providerContext);
    if (!lookup) return [];

    let mappingPayload = await fetchMappingPayload(lookup);  // ← Calls mapping.resolve()
    let animePaths = extractAnimeUnityPaths(mappingPayload);  // ← Extracts /anime/... paths
```

**Line 1086-1105: Fallback when paths empty**
```javascript
    // IMDb mappings may be missing while TMDB mapping exists: retry with TMDB id.
    if (animePaths.length === 0 && String(lookup.provider || "").toLowerCase() === "imdb") {
      const tmdbFromContext = /^\d+$/.test(String(providerContext?.tmdbId || "").trim())
        ? String(providerContext.tmdbId).trim()
        : null;
      const tmdbFromPayload = extractTmdbIdFromMappingPayload(mappingPayload);
      const fallbackTmdbId = tmdbFromContext || tmdbFromPayload;
      if (fallbackTmdbId) {
        const tmdbLookup = {
          provider: "tmdb",
          externalId: fallbackTmdbId,
          season: lookup.season,
          episode: lookup.episode
        };
        const tmdbPayload = await fetchMappingPayload(tmdbLookup);
        const tmdbPaths = extractAnimeUnityPaths(tmdbPayload);
        if (tmdbPaths.length > 0) {
          mappingPayload = tmdbPayload;
          animePaths = tmdbPaths;
        }
      }
    }

    if (animePaths.length === 0) return [];  // Returns empty if no paths found!
```

**Line 1109-1115: Extract streams from each anime path**
```javascript
    const requestedEpisode = resolveEpisodeFromMappingPayload(mappingPayload, lookup.episode);
    const perPathStreams = await mapLimit(animePaths, 3, (path) =>
      extractStreamsFromAnimePath(path, requestedEpisode)
    );

    const streams = perPathStreams.flat().filter((stream) => stream && stream.url);
    // ... deduplication and formatting
    return deduped
      .map((stream) => formatStream({ ...stream, addonBaseUrl: providerContext?.addonBaseUrl }, "AnimeUnity"))
      .filter(Boolean);
```

### Why AnimeUnity Returns Nothing

**Root Cause Chain:**
1. `searchAnimeUnity()` in mapping/index.js ALWAYS returns `[]` (lines 519-530)
2. When `resolveByKitsu()` calls it (line 620), it gets empty array every time
3. Response has `mappings.animeunity: []` or doesn't include animeunity key at all
4. `extractAnimeUnityPaths()` gets empty array and returns `[]`
5. AnimeUnity `getStreams()` checks `if (animePaths.length === 0) return [];`
6. **AnimeUnity fails silently without streams**

### searchAnimeUnity() Issues

The function has fundamental problems:
1. **No HTML scraping attempt** - Unlike `searchAnimeWorld()` and `searchAnimeSaturn()` which use regex
2. **Assumes JS-rendering limitation** - Comment says "AnimeUnity is JS-rendered, standard HTML scraping doesn't work"
3. **No title-based search** - Even though titles are passed in
4. **No fallback** - Comment says it can't derive internal_id but doesn't try alternative approaches

## Summary of Findings

### Episode/Season Threading
- ✓ Episode/Season properly passed through resolvers
- ❌ **CRITICAL: Episode NEVER passed from API callers to mapping functions**
- ❌ **CRITICAL: searchAnimeUnity() never receives episode info**
- ✓ TMDB episode mapping works correctly
- ⚠️ Provider paths don't include episode context

### AnimeUnity Integration
- ✓ AnimeUnity IS called with proper timeout
- ❌ **CRITICAL: searchAnimeUnity() ALWAYS returns empty array**
- ❌ Comment says JS-rendering prevents scraping but no fallback implemented
- ❌ Unlike AnimeWorld/AnimeSaturn, no HTML scraping attempted
