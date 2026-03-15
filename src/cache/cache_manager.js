'use strict';

/**
 * Distributed Cache Manager
 *
 * Multi-tier cache: In-Memory (L1) → CF Worker KV (L2)
 * Features:
 *   - LRU eviction with configurable max size
 *   - Stale-while-revalidate: serves stale data while refreshing in background
 *   - Stale-if-error: serves stale data if upstream fails
 *   - KV write-through via CF Worker pool (fire-and-forget)
 *   - Namespace-prefixed keys to avoid collisions
 *   - TTL categories: stream, catalog, tmdb, domain
 *   - Cache stats for monitoring
 */

const { createLogger } = require('../utils/logger');
const sysConfig = require('../config/system');

const log = createLogger('cache-mgr');

// ── Stats tracking ────────────────────────────────────────────────────────────
const stats = { hits: 0, misses: 0, staleHits: 0, kvHits: 0, kvMisses: 0, sets: 0, evictions: 0 };

// ── In-Memory LRU Cache (L1) ─────────────────────────────────────────────────
class LRUCache {
  constructor(maxSize) {
    this._maxSize = maxSize;
    this._store = new Map();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;

    const now = Date.now();

    // Fresh hit
    if (now <= entry.expiresAt) {
      // LRU bump
      this._store.delete(key);
      this._store.set(key, entry);
      stats.hits++;
      return { value: entry.value, stale: false };
    }

    // Stale-while-revalidate window
    if (now <= entry.staleUntil) {
      this._store.delete(key);
      this._store.set(key, entry);
      stats.staleHits++;
      return { value: entry.value, stale: true };
    }

    // Fully expired
    this._store.delete(key);
    stats.misses++;
    return null;
  }

  set(key, value, ttlMs) {
    // Evict oldest if at capacity
    if (this._store.size >= this._maxSize && !this._store.has(key)) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
      stats.evictions++;
    }

    const now = Date.now();
    this._store.set(key, {
      value,
      expiresAt: now + ttlMs,
      staleUntil: now + ttlMs * (1 + sysConfig.cache.staleMultiplier),
      createdAt: now,
    });
    stats.sets++;
  }

  delete(key) {
    this._store.delete(key);
  }

  clear() {
    this._store.clear();
  }

  get size() {
    return this._store.size;
  }
}

// ── Singleton L1 cache ────────────────────────────────────────────────────────
const l1 = new LRUCache(sysConfig.cache.memoryMaxSize);

// ── CF Worker KV helpers (L2) ─────────────────────────────────────────────────
let _kvModule = null;
function _getKvModule() {
  if (_kvModule) return _kvModule;
  try {
    _kvModule = require('../utils/cfWorkerPool');
  } catch {
    _kvModule = { getPrimaryWorker: () => null, broadcastKvWrite: () => {} };
  }
  return _kvModule;
}

/**
 * Read from CF Worker KV (async, used for L2 fallback).
 * @param {string} kvParam  The query param used by cfworker.js (e.g. 'kk_meta')
 * @param {string} kvKey    The key value
 * @returns {Promise<any|null>}
 */
async function _kvGet(kvParam, kvKey) {
  if (!sysConfig.cache.kvPersistEnabled) return null;
  const pool = _getKvModule();
  const w = pool.getPrimaryWorker();
  if (!w) return null;

  try {
    const u = new URL(w.url);
    u.searchParams.set(kvParam, kvKey);
    const headers = { Accept: 'application/json' };
    if (w.auth) headers['x-worker-auth'] = w.auth;
    const resp = await fetch(u.toString(), {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    stats.kvHits++;
    return data;
  } catch {
    stats.kvMisses++;
    return null;
  }
}

/**
 * Write to CF Worker KV (fire-and-forget to ALL workers).
 * @param {string} kvParam
 * @param {string} kvKey
 * @param {*} data
 */
function _kvSet(kvParam, kvKey, data) {
  if (!sysConfig.cache.kvPersistEnabled) return;
  try {
    const pool = _getKvModule();
    pool.broadcastKvWrite(kvParam, kvKey, data);
  } catch { /* ignore */ }
}

// ── TTL presets ───────────────────────────────────────────────────────────────
const TTL = {
  STREAM:       sysConfig.cache.streamTtl,
  CATALOG:      sysConfig.cache.catalogTtl,
  TMDB:         sysConfig.cache.tmdbTtl,
  DOMAIN_HEALTH: sysConfig.cache.domainHealthTtl,
  SHORT:        60_000,   // 1 min
  MEDIUM:       5 * 60_000, // 5 min
  LONG:         60 * 60_000, // 1 hour
};

// ── Auto-KV persistence for page caches ───────────────────────────────────────
// All keys starting with 'page:' automatically persist to CF Worker KV via the
// generic 'pc' handler. This survives Vercel cold starts without modifying
// individual provider files. Max 500KB to avoid excessive bandwidth.
const _AUTO_KV_PREFIX = 'page:';
const _AUTO_KV_MAX_SIZE = 500_000; // chars

function _autoKv(key, value) {
  if (!key.startsWith(_AUTO_KV_PREFIX)) return null;
  if (value != null && typeof value === 'string' && value.length > _AUTO_KV_MAX_SIZE) return null;
  return { kvParam: 'pc', kvKey: key };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get a cached value. Returns the value or null.
 * If stale, triggers background revalidation via the optional revalidateFn.
 *
 * @param {string} key
 * @param {object} [opts]
 * @param {string} [opts.kvParam]       KV param name for L2 lookup
 * @param {string} [opts.kvKey]         KV key for L2 lookup
 * @param {Function} [opts.revalidate]  Async fn to call in background when stale
 * @returns {Promise<any|null>}
 */
async function get(key, opts = {}) {
  // L1 check
  const l1Result = l1.get(key);
  if (l1Result && !l1Result.stale) {
    return l1Result.value;
  }

  // If stale, trigger background revalidation
  if (l1Result && l1Result.stale) {
    if (typeof opts.revalidate === 'function') {
      opts.revalidate().catch((err) => {
        log.debug('stale revalidation failed', { key, error: err.message });
      });
    }
    return l1Result.value;
  }

  // L2 (KV) check — explicit opts or auto-KV for page: keys
  const kv = (opts.kvParam && opts.kvKey) ? opts : _autoKv(key);
  if (kv) {
    const kvData = await _kvGet(kv.kvParam, kv.kvKey);
    if (kvData != null) {
      // Backfill L1
      l1.set(key, kvData, TTL.MEDIUM);
      return kvData;
    }
  }

  return null;
}

/**
 * Set a value in cache (L1 + optional L2 write-through).
 *
 * @param {string} key
 * @param {any} value
 * @param {number} [ttlMs]        TTL in ms (default: MEDIUM)
 * @param {object} [opts]
 * @param {string} [opts.kvParam]  KV param for L2 write-through
 * @param {string} [opts.kvKey]    KV key for L2 write-through
 */
function set(key, value, ttlMs = TTL.MEDIUM, opts = {}) {
  l1.set(key, value, ttlMs);

  // L2 write-through — explicit opts or auto-KV for page: keys
  const kv = (opts.kvParam && opts.kvKey) ? opts : _autoKv(key, value);
  if (kv) {
    _kvSet(kv.kvParam, kv.kvKey, value);
  }
}

/**
 * Delete a key from L1 cache.
 * @param {string} key
 */
function invalidate(key) {
  l1.delete(key);
}

/**
 * Get cache stats for monitoring.
 * @returns {object}
 */
function getStats() {
  return {
    ...stats,
    l1Size: l1.size,
    l1MaxSize: sysConfig.cache.memoryMaxSize,
    hitRate: stats.hits + stats.staleHits > 0
      ? ((stats.hits + stats.staleHits) / (stats.hits + stats.staleHits + stats.misses) * 100).toFixed(1) + '%'
      : '0%',
  };
}

/** Reset stats (for testing / cron reporting) */
function resetStats() {
  for (const k of Object.keys(stats)) stats[k] = 0;
}

module.exports = {
  get,
  set,
  invalidate,
  getStats,
  resetStats,
  TTL,
  // Export for drop-in compatibility with existing cache_layer.js
  TTL_TMDB: TTL.TMDB,
  TTL_CATALOG: TTL.CATALOG,
  TTL_STREAM: TTL.STREAM,
};
