# AnimeUnity Provider Investigation

## Full Flow Analysis

### 1. getStreams() Entry Point (Line 1217-1263)
- Receives: `id`, `type`, `season`, `episode`, `providerContext`
- Creates lookup via `resolveLookupRequest(id, season, episode, providerContext)`
- Fetches mapping via `fetchMappingPayload(lookup)`
- Extracts paths via `extractAnimeUnityPaths(mappingPayload)`
- Maps each path through `extractStreamsFromAnimePath(path, requestedEpisode)`

### 2. resolveLookupRequest() (Line 883-933)
**CRITICAL: Season handling is INCONSISTENT**
- For Kitsu (line 917): `season: null` - **SEASON EXPLICITLY NULLIFIED FOR KITSU!**
- For IMDb/TMDB: Season preserved

### 3. fetchMappingPayload() (Line 957-987)
- Calls `mapping.resolve(provider, externalId, options)`
- Only includes season in options if `Number.isInteger(requestedSeason) && requestedSeason >= 0`
- If season is null (from Kitsu path), season won't be passed to mapping module

### 4. extractAnimeUnityPaths() (Line 989-1010)
- Extracts `mappingPayload?.mappings?.animeunity`
- Returns normalized anime paths (e.g., `/anime/7211-frieren-...`)

### 5. extractStreamsFromAnimePath() (Line 1076-1200)
**CRITICAL ISSUE**: Takes only `(animePath, requestedEpisode)` - NO SEASON INFO
- Fetches anime page at that path
- Gets all episodes from page or API
- Picks episode by number only
- **Assumes path already encodes correct season**

## Potential Failure Points

1. **Season Nullification**: Kitsu paths explicitly set `season: null` (line 917)
   - May cause mapping to return paths for WRONG season

2. **No Season Passthrough**: `extractStreamsFromAnimePath()` receives only episode number
   - If mapping returns path for wrong season, no way to correct it
   - Anime path parsing can't distinguish seasons beyond what's in the URL slug

3. **Episode Selection**: Uses `pickEpisodeEntry()` which selects by episode number only
   - If page has episodes 1-12 for Season 1, requesting ep 1 of Season 2 returns Season 1 ep 1

4. **Missing Path Validation**: No check that extracted paths match requested season

## Questions to Verify

- Does mapping module respect season parameter when Kitsu is used?
- Are the anime paths returned actually for the correct season?
- Is `requestedEpisode` resolved correctly before being passed to `extractStreamsFromAnimePath()`?
