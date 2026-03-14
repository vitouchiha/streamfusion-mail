'use strict';

/**
 * Smart proxy fetch — tries multiple proxy IPs on failure.
 *
 * Priority order:
 * 1. Previously working proxy (cached per invocation)
 * 2. PROXY_URL env var (rotating or static)
 * 3. Static proxies from proxies.json (fallback pool)
 * 4. Direct fetch (no proxy) — last resort
 *
 * Caches the working proxy within the Lambda invocation (~5 min).
 */

let _cachedWorkingProxy = null;
let _fallbackProxies = null;

function _loadFallbackProxies() {
  if (_fallbackProxies !== null) return _fallbackProxies;
  try {
    _fallbackProxies = require('../../proxies.json');
  } catch {
    _fallbackProxies = [];
  }
  return _fallbackProxies;
}

/**
 * Fetch with automatic proxy rotation and failover.
 * Retries on 403 with the next proxy IP from the pool.
 * @param {string} url
 * @param {object} [opts]  Standard fetch options (headers, method, body, signal, etc.)
 * @returns {Promise<Response>}
 */
async function proxyFetch(url, opts = {}) {
  const proxiesToTry = [];

  // 1. Cached working proxy (fastest path)
  if (_cachedWorkingProxy) proxiesToTry.push(_cachedWorkingProxy);

  // 2. PROXY_URL env var
  const envProxy = (process.env.PROXY_URL || '').trim();
  if (envProxy && envProxy !== _cachedWorkingProxy) proxiesToTry.push(envProxy);

  // 3. Static fallback proxies
  for (const p of _loadFallbackProxies()) {
    if (!proxiesToTry.includes(p)) proxiesToTry.push(p);
  }

  if (proxiesToTry.length === 0) return fetch(url, opts);

  const { ProxyAgent } = require('undici');

  for (const proxyUrl of proxiesToTry) {
    try {
      const dispatcher = new ProxyAgent(proxyUrl);
      const resp = await fetch(url, { ...opts, dispatcher });
      if (resp.status !== 403) {
        _cachedWorkingProxy = proxyUrl;
        return resp;
      }
      // Consume body before trying next proxy
      await resp.text().catch(() => {});
    } catch { /* try next proxy */ }
  }

  // All proxies failed — try direct as last resort
  return fetch(url, opts);
}

/** Reset the cached proxy (useful if the working proxy stops working). */
function resetProxyCache() {
  _cachedWorkingProxy = null;
}

module.exports = { proxyFetch, resetProxyCache };
