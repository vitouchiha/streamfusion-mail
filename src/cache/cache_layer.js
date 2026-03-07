/**
 * Unified Cache Layer for Streaming Koreano Project
 * Implements LRU In-Memory Cache with an optional Redis fallback.
 */

const TTL_TMDB = 24 * 60 * 60 * 1000;       // 1 giorno in ms
const TTL_CATALOG = 60 * 60 * 1000;        // 1 ora in ms
const TTL_STREAM = 15 * 60 * 1000;         // 15 minuti in ms

class InMemoryCache {
    /**
     * @param {number} maxSize Massimo numero di elementi in cache prima di svuotare il più vecchio (LRU)
     */
    constructor(maxSize = 1000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    async get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }

        // LRU bump: rimuovi e reinserisci per aggiornare l'ordine
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    async set(key, value, ttlMs) {
        // Applica LRU se superiamo maxSize
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            // Map keys mantiene l'ordine di inserimento, il primo è il più vecchio (LRU)
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        
        this.cache.set(key, { 
            value, 
            expiry: Date.now() + ttlMs 
        });
    }

    async invalidate(key) {
        this.cache.delete(key);
    }
}

class RedisCache {
    constructor(redisUrl) {
        this.redisUrl = redisUrl;
        // Mock Redis client init
        // this.client = require('redis').createClient({ url: redisUrl });
        // this.client.connect();
    }

    async get(key) {
        console.log(`[Redis Mock] get ${key}`);
        // return JSON.parse(await this.client.get(key));
        return null;
    }

    async set(key, value, ttlMs) {
        console.log(`[Redis Mock] set ${key} with TTL ${ttlMs}`);
        // await this.client.set(key, JSON.stringify(value), { PX: ttlMs });
    }

    async invalidate(key) {
        console.log(`[Redis Mock] del ${key}`);
        // await this.client.del(key);
    }
}

// Configurazione Factory
const REDIS_URL = process.env.REDIS_URL || null;
const cacheInstance = REDIS_URL ? new RedisCache(REDIS_URL) : new InMemoryCache(1500);

module.exports = {
    get: (key) => cacheInstance.get(key),
    set: (key, value, ttl) => cacheInstance.set(key, value, ttl),
    invalidate: (key) => cacheInstance.invalidate(key),
    TTL_TMDB,
    TTL_CATALOG,
    TTL_STREAM
};
