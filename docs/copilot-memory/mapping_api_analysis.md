# Mapping API Usage Analysis

## Overview
The mapping API at `https://animemapping.stremio.dpdns.org` is a critical infrastructure component used by anime provider modules to translate between different ID systems (Kitsu, IMDB, TMDB) and to retrieve provider-specific anime paths.

## Key Components

### 1. `src/provider_urls.js`
- **Function**: `getProviderUrl(providerKey)`
  - Retrieves provider URLs from `provider_urls.json`
  - Supports aliases for providers (e.g., "mapping_api", "mappingapi", "mapping_api_url")
  - Returns normalized URL with trailing slashes removed

- **Flow**:
  1. Loads from embedded JSON (bundled)
  2. Checks local file system for `provider_urls.json` (every 1.5s)
  3. Fetches from GitHub remote (every 10s) as backup
  4. Merges sources: remote + local overrides = final data

### 2. Usage Pattern Across All Providers

Each provider implements:
```javascript
function getMappingApiBase() {
  return getProviderUrl("mapping_api").replace(/\/+$/, "");
}
```

### 3. Mapping API Endpoint Structure

**Pattern**: `{getMappingApiBase()}/{provider}/{externalId}?ep={episode}&s={season}`

**Providers queried**:
- `kitsu/{kitsuId}` - Query via Kitsu ID
- `imdb/{imdbId}` - Query via IMDb ID  
- `tmdb/{tmdbId}` - Query via TMDB ID

## Per-Provider Implementation

### animesaturn/index.js
- **getTTL**: `mapping: 2 * 60 * 1000` (2 minutes)
- **Query Method**: `fetchMappingPayload(lookup)`
- **Response Extraction**: `extractAnimeSaturnPaths(mappingPayload)`
  - Looks for: `mappingPayload?.mappings?.animesaturn`
  - Extracts paths: `/anime/{slug}` format
- **Usage**: Converts Kitsu/IMDB/TMDB IDs → AnimeSaturn paths to find episodes

### animeworld/index.js
- **TTL**: `mapping: 2 * 60 * 1000` (2 minutes)
- **Query Method**: `fetchMappingPayload(lookup)`
- **Response Extraction**: `extractAnimeWorldPaths(mappingPayload)`
  - Looks for: `mappingPayload?.mappings?.animeworld`
  - Extracts paths: `/play/{slug}` or `/anime/{slug}` format
- **Usage**: Maps external IDs to AnimeWorld playback paths

### animeunity/index.js
- **TTL**: `mapping: 2 * 60 * 1000` (2 minutes)
- **Query Method**: `fetchMappingPayload(lookup)`
- **Response Extraction**: `extractAnimeUnityPaths(mappingPayload)`
  - Looks for: `mappingPayload?.mappings?.animeunity`
  - Extracts paths: `/anime/{id}` or `/play/{slug}` format
- **Usage**: Converts external IDs to AnimeUnity anime/play paths

### guardaserie/index.js
- **Function**: `getMappingApiUrl()` (returns mapped API base)
- **Key Feature**: Uses Kitsu ID mapping via:
  ```javascript
  const url = `${getMappingApiUrl()}/kitsu/${encodeURIComponent(String(kitsuId).trim())}?${params.toString()}`;
  ```
- **Response Fields Used**:
  - `payload.mappings.ids.tmdb` - Get TMDB ID
  - `payload.mappings.ids.imdb` - Get IMDb ID
  - `payload.mappings.tmdb_episode` - Get episode number mapping
  - `payload.mappings.tmdbEpisode` - Alternative episode field
  - `payload.tmdb_episode` - Fallback episode field
- **Episode Mapping**: Extracts season/episode numbers from response for exact match

### guardoserie/index.js
- **Function**: `getMappingApiUrl()` (returns mapped API base)
- **Kitsu Mapping**: Via `getIdsFromKitsu(kitsuId, season, episode)`
- **Response Fields Used**:
  - `payload.mappings.ids.tmdb` - TMDB conversion
  - `payload.mappings.ids.imdb` - IMDb conversion
  - `payload.mappings.tmdb_episode` - Episode mapping
  - `payload.mappings.tmdbEpisode` - Alternative
  - `payload.tmdb_episode` - Fallback
- **Episode Mapping**: Maps Kitsu episode → TMDB season/episode numbering

## API Response Schema (Inferred)

```json
{
  "mappings": {
    "ids": {
      "imdb": "tt1234567",
      "tmdb": "12345"
    },
    "animesaturn": ["/anime/slug-here"],
    "animeworld": ["/play/slug-here"],
    "animeunity": ["/anime/12345"],
    "tmdb_episode": {
      "season": 1,
      "episode": 5,
      "season_number": 1,
      "episode_number": 5,
      "rawEpisodeNumber": 5,
      "raw_episode_number": 5
    }
  },
  "kitsu": {
    "episode": 5
  },
  "requested": {
    "episode": 5
  }
}
```

## Caching Strategy

All providers use identical caching:
- **Key Structure**: `{provider}:{externalId}:s={season}:ep={episode}`
- **TTL**: 2 minutes (120,000 ms)
- **Cache Maps**: `caches.mapping` 
- **Inflight Deduplication**: Prevents concurrent requests for same data

## Data Flow Example

1. User requests episode: `kitsu:123456:1:5`
2. Provider resolves to: `{ provider: "kitsu", externalId: "123456", season: 1, episode: 5 }`
3. Calls mapping API: `GET /kitsu/123456?ep=5&s=1`
4. Response contains provider-specific paths + cross-provider IDs
5. Provider extracts relevant paths (e.g., AnimeSaturn: `/anime/jjk`)
6. Searches that path on provider site for streams
7. Returns formatted stream objects

## Fallback Chain

All anime providers implement:
1. **Primary**: Query mapping API with given ID type
2. **IMDb Fallback**: If IMDb lookup returns no paths → try TMDB conversion
3. **Direct Path**: Some providers attempt direct provider searches as last resort
