# Anime Provider Mapping Issue Analysis

## Problem
AnimeWorld, AnimeSaturn, AnimeUnity return empty results after switching from external API to internal mapping module. GuardaSerie works fine.

## Root Cause Identified

### The Internal Mapping Module (src/mapping/index.js)

The `resolveByKitsu()` function builds a response with provider paths nested at:
```javascript
mappings: {
  ids: { imdb, tmdb, ... },
  animeworld: [...paths],      // CONDITIONAL - only if pathsFound
  animesaturn: [...paths],     // CONDITIONAL - only if pathsFound
  animeunity: [...paths],      // CONDITIONAL - only if pathsFound
}
```

Provider paths are obtained from internal search functions:
- `searchAnimeWorld(titles)` - searches website at `/search?keyword=`
- `searchAnimeSaturn(titles)` - searches website at `/animelist?search=`
- `searchAnimeUnity(titles, anilistId)` - **BROKEN: Always returns empty array**

### The searchAnimeUnity Issue (Line ~270-310 in mapping/index.js)

```javascript
async function searchAnimeUnity(titles, anilistId) {
  const base = getProviderBase("animeunity");
  if (!base) return [];

  if (anilistId) {
    const key = `au:anilist:${anilistId}`;
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    // Comment: "AnimeUnity's URL format: /anime/{internal_id}-{slug}
    // We can't derive internal_id from AniList ID directly.
    // As fallback, return empty - the provider already handles this gracefully."
    return cacheSet(key, []);  // <-- RETURNS EMPTY ARRAY!
  }
  return [];  // <-- ALWAYS EMPTY
}
```

**The function is hardcoded to return empty array because developer commented that:**
- AnimeUnity is JS-rendered (can't scrape HTML)
- Can't derive internal_id from AniList ID
- Assumes provider fallback handling...but it doesn't!

### How Anime Providers Extract Paths (Each Provider)

In animeworld/index.js line 897-908:
```javascript
function extractAnimeWorldPaths(mappingPayload) {
  const raw = mappingPayload?.mappings?.animeworld;  // Expects array here
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // Process each path...
}
```

Same pattern for AnimeSaturn and AnimeUnity providers.

### Provider Flow

1. `getStreams(id, type, season, episode, providerContext)` called
2. `resolveLookupRequest()` creates: `{ provider: "imdb"/"kitsu", externalId: "..." }`
3. `fetchMappingPayload(lookup)` calls `mapping.resolve(provider, externalId, options)`
4. Returns payload with `mappings.animeworld/animesaturn/animeunity` arrays
5. `extractAnime[Provider]Paths(payload)` extracts these arrays
6. If array is empty → **no paths to search on provider website** → empty results

### Why GuardaSerie Works

GuardaSerie (src/guardaserie/index.js) does NOT depend on internal mapping paths:
- It calls `mapping.resolve("kitsu", kitsuId, options)` to get IDs
- Extracts ONLY `payload.mappings.ids` (tmdb, imdb, tvdb)
- Uses TMDB API to search for shows and episodes
- Doesn't rely on `mappings.animeworld/animesaturn/animeunity` paths

## Key Differences: External API vs Internal Module

### External API Format (animemapping.stremio.dpdns.org)
Presumably returned:
```json
{
  "mappings": {
    "ids": {...},
    "animeworld": ["existing_paths_on_site"],
    "animesaturn": ["existing_paths_on_site"],
    "animeunity": ["existing_paths_on_site"]
  }
}
```

### Internal Module Returns
For AnimeUnity: **NO `mappings.animeunity` key at all** (conditional only if paths found)
- `searchAnimeUnity()` always returns `[]`
- Code does: `...(animeUnityPaths.length > 0 ? { animeunity: animeUnityPaths } : {})`
- Result: `mappings.animeunity` key is missing

For AnimeWorld/AnimeSaturn: Works if website search finds paths, but could fail for similar reasons

## Error Paths (Silent Failures)

All three providers have try-catch that returns null silently:
```javascript
async function fetchMappingPayload(lookup) {
  try {
    const payload = await mapping.resolve(provider, externalId, options);
    // ... returns payload
  } catch (error) {
    console.error("[Provider] internal mapping error:", error.message);
    return null;  // <-- SILENTLY FAILS
  }
}
```

Then:
```javascript
let animePaths = extractAnimeWorldPaths(mappingPayload);  // null → []
if (animePaths.length === 0) return [];  // <-- NO FALLBACK
```

## Files and Line Numbers

**Root cause:**
- [src/mapping/index.js](src/mapping/index.js#L280-L310) - `searchAnimeUnity()` returns empty

**Impact points:**
- [src/animeworld/index.js](src/animeworld/index.js#L897-L908) - Extraction expects paths  
- [src/animesaturn/index.js](src/animesaturn/index.js#L987-L998) - Same issue
- [src/animeunity/index.js](src/animeunity/index.js#L810-L821) - Same issue

**Why GuardaSerie works:**
- [src/guardaserie/index.js](src/guardaserie/index.js#L219-L240) - `getIdsFromKitsu()` only extracts IDs, not provider paths
