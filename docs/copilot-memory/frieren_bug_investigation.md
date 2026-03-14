# Frieren S2E7 Bug Investigation - Full Request Flow Analysis

## Overview
Investigating two bugs for Frieren: Beyond Journey's End S2E7 (IMDB: tt22248376, Stremio ID: tt22248376:2:7)
- **Bug 1**: AnimeUnity streams missing
- **Bug 2**: Season 1 results leaking into Season 2 requests

## Request Flow Trace: getStreams(id='tt22248376', type='series', season=2, episode=7)

### 1. Main Entry Point: src/index.js - getStreams()
- **Called with**: id='tt22248376', type='series', season=2, episode=7
- **Processing**:
  - Normalizes type to 'series'
  - Parses season=2, episode=7
  - Calls `resolveProviderRequestContext('tt22248376', 'series', 2, 7, false)` - CONTEXT RESOLUTION
  - Detects IMDB format: `/^tt\d+$/i.test(idStr.split(':')[0])` ✓ MATCH
  - Sets `context.idType = 'imdb'` and `context.imdbId = 'tt22248376'`

### 2. Mapping Resolution: resolveProviderRequestContext() in src/index.js
```javascript
// For IMDB ID, calls:
const byImdb = await fetchMappingByRoute('imdb', 'tt22248376', 2, 7);

// Which calls:
await mapping.resolve('imdb', 'tt22248376', { season: 2, episode: 7 })
```

### 3. Mapping Module: src/mapping/index.js - resolve()
Entry point calls `resolveByImdb()`

### 4. CRITICAL: resolveByImdb() - IMDb → Kitsu Resolution Chain
```javascript
async function resolveByImdb(imdbId, options = {}) {
  // Step 1: Try direct Kitsu IMDB lookup (rarely works)
  let kitsuId = await findKitsuIdByExternalId("imdb", id);
  
  // Step 2: If fails, chain: IMDB → TMDB → TVDB → Kitsu
  if (!kitsuId) {
    resolvedTmdbId = await findTmdbIdFromExternal(id, "imdb_id"); // TMDB API
    if (resolvedTmdbId) {
      // Get TVDB from TMDB external_ids
      const extIds = await fetchJson(`https://api.themoviedb.org/3/tv/${resolvedTmdbId}/external_ids`);
      if (extIds?.tvdb_id) {
        kitsuId = await findKitsuIdByExternalId("tvdb", String(extIds.tvdb_id));
      }
      // If still no Kitsu, try movie external_ids
      // Last resort: search Kitsu by TMDB title
      if (!kitsuId) {
        kitsuId = await searchKitsuByTmdbTitle(resolvedTmdbId);
      }
    }
  }
  
  // If kitsuId found, resolve via Kitsu:
  if (kitsuId) {
    const result = await resolveByKitsu(kitsuId, options);
    result.requested = { provider: "imdb", externalId: id, ... };
    return result;
  }
  
  // FALLBACK: If no Kitsu found, use buildMinimalTmdbResponse()
  // ⚠️ BUG ZONE: This might miss Kitsu entirely and use only TMDB data
  const fallbackTmdbId = resolvedTmdbId || await findTmdbIdFromExternal(id, "imdb_id");
  if (fallbackTmdbId) {
    return buildMinimalTmdbResponse(fallbackTmdbId, options, id);
  }
}
```

### 5. CRITICAL: resolveByKitsu() - Provider Search
```javascript
async function resolveByKitsu(kitsuId, options = {}) {
  // options = { season: 2, episode: 7 }
  
  const [kitsuAnime, externalIds] = await Promise.all([
    fetchKitsuAnime(kitsuId),
    fetchKitsuMappings(kitsuId),
  ]);
  
  // Resolve TMDB ID from offline list first
  let tmdbId = externalIds.tmdb || null;
  
  // Provider path search (PARALLEL):
  const searchTitles = buildSearchTitles(kitsuAnime);
  const [animeWorldPaths, animeSaturnPaths, animeUnityPaths] = await Promise.all([
    searchAnimeWorld(searchTitles),
    searchAnimeSaturn(searchTitles),
    searchAnimeUnity(searchTitles, externalIds.anilist), // ⚠️ Uses AniList ID!
  ]);
  
  // Returns payload with:
  const payload = {
    requested: { episode: 7, ... },
    kitsu: { episode_airdate, episode: 7, ... },  // ⚠️ Episode data
    mappings: {
      animeunity: [...paths],  // ⚠️ This is what AnimeUnity provider gets
      animeworld: [...paths],
      animesaturn: [...paths],
      tmdb_episode: { ... }
    }
  };
}
```

### 6. buildMinimalTmdbResponse() - Fallback (When Kitsu Not Found)
```javascript
async function buildMinimalTmdbResponse(tmdbId, options = {}, imdbOverride = null) {
  // options = { season: 2, episode: 7 }
  
  const searchTitles = [];
  if (tvData?.name) searchTitles.push(tvData.name);
  if (tvData?.original_name) searchTitles.push(tvData.original_name);
  
  // Search provider sites by TMDB title
  let animeUnityPaths = [];
  if (searchTitles.length > 0) {
    animeUnityPaths = await searchAnimeUnity(searchTitles, null); // ⚠️ No AniList ID!
  }
  
  // Returns payload
  return {
    mappings: {
      animeunity: animeUnityPaths,  // May be different results!
      ...
    }
  };
}
```

### 7. AnimeUnity Provider: src/animeunity/index.js - getStreams()
```javascript
async function getStreams(id, type, season, episode, providerContext = null) {
  // id='tt22248376', season=2, episode=7
  
  const lookup = resolveLookupRequest(id, 2, 7, providerContext);
  // Returns: { provider: 'imdb', externalId: 'tt22248376', season: 2, episode: 7 }
  
  let mappingPayload = await fetchMappingPayload(lookup);
  // Calls: mapping.resolve('imdb', 'tt22248376', { episode: 7, season: 2 })
  
  let animePaths = extractAnimeUnityPaths(mappingPayload);
  // Gets: mappingPayload?.mappings?.animeunity
  
  // CRITICAL: Episode Resolution
  const requestedEpisode = resolveEpisodeFromMappingPayload(mappingPayload, episode); // episode=7
  
  // For each path, extract streams:
  const perPathStreams = await mapLimit(animePaths, 3, (path) =>
    extractStreamsFromAnimePath(path, requestedEpisode)  // requestedEpisode=7
  );
}
```

### 8. extractStreamsFromAnimePath() - Per-Path Extraction
```javascript
async function extractStreamsFromAnimePath(animePath, requestedEpisode) {
  // animePath = '/anime/XXXX', requestedEpisode = 7
  
  const html = await fetchResource(animeUrl, ...);
  const parsedAnime = parseAnimePage(html, { animePath });
  
  const normalizedEpisode = normalizeRequestedEpisode(requestedEpisode); // = 7
  let episodes = normalizeEpisodesList(parsedAnime.episodes);
  // episodes = [ {num: 1}, {num: 2}, ..., {num: X} ]
  
  let selected = pickEpisodeEntry(episodes, normalizedEpisode); // ⚠️ BUG ZONE 2
  // This function looks for episode #7 in the list
  
  if (!selected && parsedAnime.totalEpisodes > episodes.length) {
    // Fetch more episodes from API if needed
  }
  
  // If no episode 7 found: return []
  if (!selected) return [];
  
  // Extract streams for selected episode
  return [streams];
}
```

### 9. pickEpisodeEntry() - CRITICAL FOR SEASON LEAK
```javascript
function pickEpisodeEntry(episodes, requestedEpisode) {
  const list = normalizeEpisodesList(episodes);
  if (list.length === 0) return null;
  
  const episode = normalizeRequestedEpisode(requestedEpisode); // = 7
  const byNum = list.find((entry) => entry.num === episode); // ⚠️ BUG!
  if (byNum) return byNum;
  
  const byIndex = list[episode - 1]; // ⚠️ BUG! Array index 6 (7-1)
  if (byIndex) return byIndex;
  
  if (list.length === 1) return list[0];
  const first = list.find((entry) => entry.num === 1);
  if (episode === 1 && first) return first;
  return null;
}
```

## Bug Root Causes Identified

### **BUG 1: AnimeUnity Streams Missing**

**Root Cause Chain:**
1. Frieren's Kitsu mapping might be incomplete or missing AniList ID
2. If `resolveByKitsu()` fails to find anime paths, it falls back to `buildMinimalTmdbResponse()`
3. `buildMinimalTmdbResponse()` searches by TMDB title only (no AniList ID)
4. `searchAnimeUnity()` with TMDB title may fail when:
   - Title doesn't match well (romanization, punctuation)
   - AnimeUnity database uses different naming
   - AniList ID lookup would have worked but wasn't passed to fallback

**Key Code Issue in `resolveByImdb()`**:
```javascript
// If findKitsuIdByExternalId("imdb", "tt22248376") fails OR returns no anime:
// Falls back to buildMinimalTmdbResponse() which loses AniList ID context
// Result: searchAnimeUnity(["Frieren: Beyond Journey's End"], null) 
// VS optimal: searchAnimeUnity([...], anilistId) which checks r.anilist_id first
```

**In `searchAnimeUnity(titles, anilistId)`**:
```javascript
// OPTIMAL PATH (with anilistId):
if (anilistId) {
  const match = records.find(r => r.anilist_id === Number(anilistId)); // ✓ Direct match
  if (match && match.id && match.slug) {
    paths.push(`/anime/${match.id}-${match.slug}`);
  }
}

// FALLBACK PATH (anilistId = null):
if (paths.length === 0) {
  // Relies on title similarity matching, which can fail
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const r of records) {
    const norm = c.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (norm.includes(normalizedTitle) || normalizedTitle.includes(norm)) {
      const path = `/anime/${r.id}-${r.slug}`;
      // ... only adds if title matches
    }
  }
}
```

**Why Frieren might fail**:
- Frieren has special characters (colon, apostrophe)
- Title normalization: "frieren: beyond journey's end" → "frierenbeyondjourneyend"
- AnimeUnity record titles might be "Frieren" or "Sousou no Frieren" or other variations
- Without AniList ID= matching, title search fails

---

### **BUG 2: Season 1 Results Leaking Into Season 2**

**Root Cause Chain:**

1. **Season/Episode Info NOT Passed to AnimeUnity Search**: 
   - `resolveByKitsu()} calls `searchAnimeUnity(titles, anilistId)` with NO season info
   - Result: Returns paths for ANY version of Frieren (S1, S2, movies, all mixed)
   - Example: Both `/anime/12345-frieren-season-1` and `/anime/54321-frieren-season-2`

2. **Per-Path Episode Selection Has No Season Context**:
   - `extractStreamsFromAnimePath(path, requestedEpisode=7)` gets called
   - It parses the anime page and extracts episodes: `[{num:1}, {num:2}, ..., {num:13}]`
   - For Season 1, it has 28 episodes, so episode 7 exists ✓
   - For Season 2, it has 10 episodes, so episode 7 exists ✓
   - **Problem**: If Season 1 path is used, episodes 1-28 include episode 7 (S1E7)
   - **Problem**: No way to distinguish "this is S1E7, not S2E7"

3. **parseAnimePage() Returns All Episodes Without Season Info**:
   - Hits the anime page (e.g., `https://animeunity.it/anime/XXXX-frieren`)
   - This page might show EITHER Season 1 OR Season 2 episodes
   - Or it might consolidate episodes across seasons as a flat list
   - Returns: `episodes = [{num:1}, {num:2}, ..., {num:N}]`
   - **No season field in episode entries**: `{ num, token, episodeId, scwsId, link, ... }`

4. **pickEpisodeEntry() Just Matches by Episode Number**:
   - Given `episodes=[{num:1}, ..., {num:28}]` (from S1 page) and `requestedEpisode=7`
   - Returns `episodes[6]` (0-indexed) = `{num: 7}` ← S1E7, NOT S2E7!
   - No validation that this is actually the requested season

**Code Issue in AnimeUnity Episode Handling**:
```javascript
// Episode normalization ONLY knows about num, not season
function normalizeEpisodesList(sourceEpisodes = []) {
  for (let index = 0; index < sourceEpisodes.length; index += 1) {
    const entry = sourceEpisodes[index] || {};
    const num = Number.isFinite(numRaw) && numRaw > 0 ? numRaw : index + 1;
    // ⚠️ NO SEASON FIELD CAPTURED
    out.push({
      num,           // Episode number only
      token,         // No season
      episodeId,     // Might indicate season internally, but not parsed
      // ... etc
      // MISSING: season, seasonId, or any season indicator
    });
  }
}

// pickEpisodeEntry matching
function pickEpisodeEntry(episodes, requestedEpisode) {
  const byNum = list.find((entry) => entry.num === 7); // ⚠️ Matches FIRST {num:7}
  // Could be S1E7 or S2E7 or S3E7, doesn't matter!
  if (byNum) return byNum;
  // ...
}
```

**For AniWorld/AnimeSaturn**: Same issue - no season context in path search or episode picking.

---

## Why Does This Happen?

### Problem 1: Missing Kitsu-Based AniList Mapping
- Frieren might not have a Kitsu ID in anime-lists.json
- Or Kitsu lookup chain fails (IMDB → TMDB → TVDB → Kitsu chain breaks)
- Fallback uses TMDB title search without AniList ID
- Title search is fragile compared to database ID matching

### Problem 2: Anime Provider Architecture Doesn't Store Season Info
- AnimeUnity/AnimeWorld URLs like `/anime/XXXX` don't encode season
- When parsing pages, season is not extracted from content
- Episode lists are flat (no season grouping)
- Providers assume one anime = one URL = one consistent season

**Solution Needed**:
1. **For Bug 1**: Ensure AniList ID reaches AnimeUnity search even in fallback paths
2. **For Bug 2**: 
   - Parse/store season info from anime pages
   - Filter episode selection by season when available
   - OR: Fetch season-specific episode lists via API not HTML parsing
