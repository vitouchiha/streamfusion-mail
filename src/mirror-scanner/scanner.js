'use strict';

/**
 * Mirror Scanner
 *
 * Discovers and validates alternative domain mirrors for providers that
 * frequently change domains (guardoserie, eurostreaming, cb01, etc.).
 *
 * Strategy:
 *   1. Check known TLD patterns (provider + common TLDs)
 *   2. Check well-known redirect sites (domain lists)
 *   3. Validate discovered mirrors (HEAD check + content fingerprint)
 *   4. Register valid mirrors with the failover system
 *
 * Runs periodically via cron and caches results.
 */

const { createLogger } = require('../utils/logger');
const sysConfig = require('../config/system');
const failover = require('../domain-failover/failover');

const log = createLogger('mirror-scan');

// ── Known TLD variants for Italian streaming sites ─────────────────────────

const PROVIDER_TLD_MAP = {
  guardoserie: {
    base: 'guardoserie',
    tlds: ['digital', 'best', 'horse', 'surf', 'bar', 'blog', 'website', 'online', 'top', 'life', 'site', 'fun', 'space', 'click', 'link', 'uno'],
    fingerprint: '/serie/',  // expected content in valid page
  },
  eurostreaming: {
    base: 'eurostreaming',
    tlds: ['ing', 'life', 'pro', 'run', 'org', 'name', 'world', 'live', 'to', 'love', 'cam', 'bond', 'bio'],
    altBases: ['eurostreamings', 'eurostream'],
    fingerprint: 'eurostreaming',
  },
  cb01: {
    base: 'cb01',
    tlds: ['gold', 'info', 'live', 'uno', 'co', 'website', 'fun', 'top', 'org', 'online', 'site'],
    fingerprint: 'cb01',
  },
  guardahd: {
    base: 'guardahd',
    tlds: ['me', 'stream', 'life', 'one', 'site', 'pro', 'top', 'run', 'online'],
    fingerprint: 'GuardaHD',
  },
  streamingcommunity: {
    base: 'streamingcommunity',
    tlds: ['actor', 'city', 'best', 'coffee', 'computer', 'agency', 'buzz', 'art', 'prof', 'bond'],
    fingerprint: 'streaming community',
  },
  guardaserie: {
    base: 'guardaserie',
    altBases: ['guardaserietv'],
    tlds: ['skin', 'cfd', 'click', 'hair', 'bond', 'observer', 'online', 'site', 'top', 'life', 'fun'],
    fingerprint: 'guardaserie',
  },
  loonex: {
    base: 'loonex',
    tlds: ['eu', 'it', 'me', 'cc', 'live', 'pro', 'tv', 'online', 'site', 'fun'],
    fingerprint: 'loonex',
  },
  toonitalia: {
    base: 'toonitalia',
    tlds: ['xyz', 'org', 'com', 'cc', 'co', 'live', 'fun', 'site', 'online', 'top'],
    fingerprint: 'toonitalia',
  },
  guardaflix: {
    base: 'guardaflix',
    altBases: ['guardaplay'],
    tlds: ['space', 'online', 'site', 'life', 'fun', 'top', 'click', 'live', 'cam'],
    fingerprint: 'guardaflix',
  },
};

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, { mirrors: string[], lastScanAt: number }>} */
const _scanResults = new Map();

// ── Scanner ───────────────────────────────────────────────────────────────────

/**
 * Check if a mirror URL is valid by fetching it and checking for fingerprint.
 * @param {string} url
 * @param {string} fingerprint
 * @returns {Promise<{ok: boolean, ms: number, status: number}>}
 */
async function _checkMirror(url, fingerprint) {
  const timeout = sysConfig.mirrorScanner.checkTimeoutMs;
  const t0 = Date.now();

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9',
      },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    const ms = Date.now() - t0;
    const body = await resp.text();

    // CF block check
    const isCfBlock = body.includes('Just a moment') || body.includes('Checking your browser');
    if (isCfBlock) {
      // CF-protected but reachable = potentially valid (needs Worker bypass)
      return { ok: true, ms, status: resp.status, cfProtected: true };
    }

    // Fingerprint check
    const hasFingerprint = body.toLowerCase().includes(fingerprint.toLowerCase());
    return { ok: resp.ok && hasFingerprint, ms, status: resp.status, cfProtected: false };
  } catch {
    return { ok: false, ms: Date.now() - t0, status: 0, cfProtected: false };
  }
}

/**
 * Generate candidate mirror URLs for a provider.
 * @param {string} provider
 * @returns {string[]}
 */
function _generateCandidates(provider) {
  const config = PROVIDER_TLD_MAP[provider];
  if (!config) return [];

  const candidates = [];
  const bases = [config.base, ...(config.altBases || [])];
  const maxPerProvider = sysConfig.mirrorScanner.maxMirrorsPerProvider;

  for (const base of bases) {
    for (const tld of config.tlds) {
      candidates.push(`https://${base}.${tld}`);
      if (candidates.length >= maxPerProvider * 2) break;
    }
  }

  return candidates;
}

/**
 * Scan for mirrors of a specific provider.
 * @param {string} provider
 * @returns {Promise<string[]>}  Array of valid mirror URLs
 */
async function scanProvider(provider) {
  const key = provider.toLowerCase();
  const config = PROVIDER_TLD_MAP[key];
  if (!config) {
    log.debug('no TLD config for provider', { provider: key });
    return [];
  }

  const candidates = _generateCandidates(key);
  log.info('scanning mirrors', { provider: key, candidates: candidates.length });

  const validMirrors = [];
  const maxMirrors = sysConfig.mirrorScanner.maxMirrorsPerProvider;

  // Check candidates in batches of 5 to avoid overwhelming
  const batchSize = 5;
  for (let i = 0; i < candidates.length && validMirrors.length < maxMirrors; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(url => _checkMirror(url, config.fingerprint))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled' && results[j].value.ok) {
        validMirrors.push(batch[j]);
        log.info('mirror found', {
          provider: key,
          url: batch[j],
          ms: results[j].value.ms,
          cfProtected: results[j].value.cfProtected,
        });
      }
    }
  }

  // Store results
  _scanResults.set(key, {
    mirrors: validMirrors,
    lastScanAt: Date.now(),
  });

  // Register with failover system
  if (validMirrors.length > 0) {
    failover.registerAlternatives(key, validMirrors);
  }

  log.info('scan complete', { provider: key, found: validMirrors.length, total: candidates.length });
  return validMirrors;
}

/**
 * Scan all configured providers for mirrors.
 * @returns {Promise<Object>}
 */
async function scanAll() {
  const results = {};
  for (const provider of Object.keys(PROVIDER_TLD_MAP)) {
    results[provider] = await scanProvider(provider);
  }
  return results;
}

/**
 * Get cached scan results for a provider.
 * @param {string} provider
 * @returns {{ mirrors: string[], lastScanAt: number } | null}
 */
function getScanResults(provider) {
  return _scanResults.get(provider.toLowerCase()) || null;
}

/**
 * Get all scan results.
 * @returns {Object}
 */
function getAllScanResults() {
  const out = {};
  for (const [provider, data] of _scanResults) {
    out[provider] = {
      mirrors: data.mirrors,
      lastScanAt: new Date(data.lastScanAt).toISOString(),
      count: data.mirrors.length,
    };
  }
  return out;
}

module.exports = {
  scanProvider,
  scanAll,
  getScanResults,
  getAllScanResults,
  PROVIDER_TLD_MAP,
};
