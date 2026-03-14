# StreamFusionMail Cache Mechanism Research

## Cache Implementation

Two caching layers in use:

### 1. **Cache Layer** (src/cache/cache_layer.js)
- **Type**: LRU (Least Recently Used) In-Memory Cache
- **Optional**: Redis fallback if `REDIS_URL` env var is set
- **Default maxSize**: 1500 items

### 2. **TTL Cache** (src/utils/cache.js)
- **Type**: Per-provider TTL caches
- **Used by**: individual providers (guardaserie, rama, drammatica, kisskh)
- **Methods**: `get()`, `set()`, `has()`, `delete()`, `flush()`
- **Default maxSize**: 500 items
- **Default TTL**: 300,000ms (5 min)

---

## TTL Values

From `src/cache/cache_layer.js`:
- **TTL_TMDB**: 24 hours (1,440 minutes)
- **TTL_CATALOG**: 1 hour (60 minutes)
- **TTL_STREAM**: 15 minutes

Per-provider TTL examples (guardaserie.js):
- catalogCache: 10 minutes
- metaCache: 30 minutes
- streamCache: can be overridden, e.g., 2 hours for certain results

---

## Cache Keys

Multiple formats used across providers:

1. **Stream Cache**: `streams_${contentId}` (engine.js)
2. **Catalog Cache**: `catalog:${skip}:${search}` (guardaserie.js)
3. **Meta Cache**: seriesId (simple ID string)
4. **Stream Cache**: `${type}:${id}` or similar patterns per provider

---

## Cache Control Headers (server.js)

### Positive Caching (maxAge > 0):
```
Cache-Control: public, max-age={maxAge}, stale-while-revalidate={maxAge * 3}
```
- Used for catalog/meta responses (1800s = 30 min for non-empty meta)

### No-Cache (maxAge === 0):
```
Cache-Control: no-store, no-cache, must-revalidate
```
- Used for stream responses (short-lived URLs, expire, unstable)
- Used for empty/null responses (prevent Stremio from caching stale data)
- Used for HLS proxy responses

---

## Invalidation Methods

### 1. **Direct Key Invalidation**
```javascript
await cacheLayer.invalidate(key);
// or
cache.delete(key);
```

### 2. **Flush Entire Cache**
```javascript
cache.flush();  // Clears all entries
```

### 3. **Manual LRU Logic**
- Cache entry removed when TTL expires (auto on next access)
- When maxSize exceeded, oldest entry (LRU) is evicted

---

## Testing Bypass Methods

To bypass cache during testing:

1. **HTTP Headers** (client-side):
   ```
   Cache-Control: no-cache
   Pragma: no-cache
   ```

2. **Edge Cache Bypass** (Vercel/CDN):
   - Stream responses already set `Cache-Control: no-store`
   - Empty/null responses get `Cache-Control: no-store, no-cache, must-revalidate`

3. **In-Code Bypass**:
   - Call `cache.flush()` at startup or in debug mode
   - Modify cache.set() TTL to 0 for immediate expiration

4. **Environment Variable**:
   - Set `REDIS_URL=""` to ensure memory cache only (no Redis persistence)

---

## Key File References

- [cache_layer.js](../../src/cache/cache_layer.js) - Main cache implementation
- [cache.js](../../src/utils/cache.js) - Per-provider TTLCache
- [server.js](../../server.js#L178) - Cache-Control headers
- [engine.js](../../src/stream_engine/engine.js#L25) - Stream cache usage
- [guardaserie.js](../../src/providers/guardaserie.js#L189) - Provider cache usage
