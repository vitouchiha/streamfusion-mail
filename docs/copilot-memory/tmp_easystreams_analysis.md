# tmp_easystreams Reference Addon - ID Mapping & Provider Resolution Analysis

## Key Architecture Findings

### 1. **Anime ID Mapping Strategy**
The system uses an **external mapping API** (animemapping.stremio.dpdns.org) to resolve external IDs (Kitsu, TMDB, IMDb) to provider-specific paths.

**Flow:**
1. User provides ID (Kitsu, TMDB, or IMDb)
2. Parse explicit format: `kitsu:12345`, `tmdb:45678`, `imdb:tt1234567`
3. Call mapping API: `https://animemapping.stremio.dpdns.org/{provider}/{externalId}?ep=1&s=0`
4. Receive mapping payload containing provider-specific paths

### 2. **NO Direct Search API to Providers**
- **Does NOT search provider websites by title**
- **Does NOT use provider search APIs**
- **Completely relies on pre-computed mapping database**

The providers are **only used for content extraction** after path is resolved.

### 3. **Provider Path Resolution - Three Implementations**

#### **AnimeSaturn Provider** (`animesaturn.js`)
- **Supported path format:** `/anime/{slug}` (e.g., `/anime/jujutsu-kaisen`)
- **Extraction flow:**
  1. Fetch anime page via mapped path
  2. Parse episode list from HTML (Cheerio)
  3. Extract watchable URLs from episode pages
  4. Use extractors (MixDrop, DropLoad, SuperVideo, etc.) to get stream URLs
- **No search:** Path must come from mapping API

#### **AnimeWorld Provider** (`animeworld.js`)
- **Supported path format:** `/play/{slug}` or `/anime/{slug}`
- **Extraction flow:**
  1. Fetch anime page + extract CSRF token + session cookie
  2. Parse episodes using data attributes: `data-episode-id`, `data-episode-num`
  3. Call episode API: `GET /api/episode/info?id={episodeToken}`
  4. Extract grabber URLs from API response
  5. Fetch target player to extract streams
- **No search:** Uses data-id from pre-mapped paths

#### **AnimeUnity Provider** (`animeunity.js`)
- **Similar to AnimeWorld:**
  1. Fetch anime page
  2. Parse episodes from HTML attributes
  3. Call episode info API
  4. Extract grabber/stream URLs
- **No search:** Path-based lookup only

### 4. **Mapping Payload Structure**
```javascript
{
  mappings: {
    animesaturn: ["/anime/jujutsu-kaisen"],  // or single string
    animeworld: ["/play/jujutsu-kaisen"],    // or single string
    animeunity: ["/anime/jujutsu-kaisen"],   // or single string
    ids: { tmdb: 123456 },
    tmdb_episode: { rawEpisodeNumber: 1 }
  },
  kitsu: { episode: 1 },
  requested: { episode: 1 }
}
```

### 5. **Episode Resolution Strategy**
1. **Try mapping payload first** - uses mapped episode info
2. **Fallback logic:**
   - If no AnimeSaturn paths: try TMDB ID if available
   - If no paths from TMDB: return empty
3. **Episode lookup within provider:**
   - Fetch anime page
   - Find episode by number from parsed list
   - If not found, fetch related anime pages (for alternate versions)
   - Pick first matching episode or by index

### 6. **Caching Strategy**
- **HTTP cache:** 5 minutes (TTL.http)
- **Anime page cache:** 15 minutes (TTL.page)  
- **Episode info cache:** 5 minutes (TTL.info)
- **Mapping cache:** 2 minutes (TTL.mapping)
- **In-flight deduplication:** Prevents duplicate concurrent requests

### 7. **Stream Extraction (After finding content)**
- Uses provider-specific extractors:
  - MixDrop (JavaScript packed)
  - DropLoad (packed JS)
  - SuperVideo (packed JS)
  - StreamTape (HTML parse)
  - Uqload (source extraction)
  - Upstream (packed JS)
  - Vidoza (HTML parse)
  - VixCloud (token-based M3U8)

- Quality detection from:
  - URL patterns (720p, 1080p in URL)
  - M3U8 playlist parsing (RESOLUTION tags)

### 8. **Does It Do Title Search?**
✗ **NO** - It ONLY uses pre-mapped anime paths
- Title sanitization is for display/caching purposes only
- No direct provider search/title lookup
- Mapping API is responsible for ID→Path resolution

### 9. **Supported ID Types**
1. Explicit format: `kitsu:99999`, `tmdb:12345`, `imdb:tt1234567`
2. Direct format: `12345` (treated as TMDB), `tt1234567` (treated as IMDb)
3. **Context-based:** From provider context object:
   - `kitsuId`
   - `tmdbId`
   - `imdbId`

### 10. **Key Functions That Handle Mapping**

**Core mapping functions:**
- `fetchMappingPayload(lookup)` - Calls external mapping API
- `extractAnimeSaturnPaths(mappingPayload)` - Extracts `/anime/...` paths
- `extractAnimeWorldPaths(mappingPayload)` - Extracts `/play/...` paths
- `resolveLookupRequest()` - Parses user-provided ID into structured lookup
- `getStreams(id, type, season, episode, providerContext)` - Main entry point

**No functions named:** `searchByTitle`, `searchProvider`, `queryApi`, etc.

## Database/Mapping Source
- **External API:** `https://animemapping.stremio.dpdns.org`
- **API Query Format:** `/{provider}/{externalId}?ep={episode}&s={season}`
- **Providers Supported:** kitsu, tmdb, imdb
- **Response:** Pre-computed mapping to anime provider paths (appears to be pre-cached database lookup)

## Conclusion
**This is a pure ID→Path mapping system, NOT a search system:**
- All anime title lookups must happen OUTSIDE this addon
- The addon receives IDs (Kitsu/TMDB/IMDb) from external sources
- The mapping API returns provider-specific paths
- Provider pages are fetched using these paths
- Content is extracted from those pages

**No search functionality anywhere in the code - it's strictly path-based extraction.**
