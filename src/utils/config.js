'use strict';

/**
 * User configuration — encode/decode from URL path
 *
 * Config is stored as AES-256-GCM encrypted JSON in the addon URL:
 *   https://streamfusion-mail.vercel.app/ENCRYPTED_CONFIG/manifest.json
 *
 * Encryption prevents proxy credentials and MediaFlow API keys from being
 * exposed in URL logs, analytics tools, or browser history.
 *
 * If CONFIG_SECRET env var is not set, falls back to base64url (dev mode).
 *
 * Short keys to keep URLs compact:
 *   mfp   → MediaFlow Proxy base URL
 *   mfpk  → MediaFlow Proxy API key
 *   px    → HTTP proxy URL (for catalog/meta requests blocked by Cloudflare)
 *   hc    → hideCatalogs (1 = yes, omit = no)
 *   pv    → providers: 'a'=all (default), 'k'=kisskh, 'r'=rama, 'd'=drammatica, 'g'=guardaserie
 *   cm    → cinemeta (1 = enable IMDB stream support, omit = no)
 *   tm    → TMDB API key (for meta enrichment: poster, background, cast, genres)
 *   rp    → RPDB API key (for rated poster overlays)
 *   tp    → TopPoster API key (for TopPoster poster overlays)
 */

const crypto = require('crypto');

const DEFAULT_CONFIG = {
  mfpUrl:       (process.env.MFP_URL || '').trim(),
  mfpKey:       (process.env.MFP_API_PASSWORD || '').trim(),
  proxyUrl:     '',
  hideCatalogs: false,
  providers:    'all',
  cinemeta:     true,
  // Default TMDB key — active for all users unless they supply their own.
  // Provides poster HD, cast, genres, IMDB title lookup for Cinemeta streams.
  tmdbKey:        '6e0a84ca7b324763793422a6656d34ff',
  rpdbKey:        '',
  topPosterKey:   '',
};

// ─── Encryption helpers ───────────────────────────────────────────────────────

/**
 * Derive a 32-byte key from CONFIG_SECRET (or a hardcoded dev fallback).
 * Using scryptSync so keys are the same across restarts without storing state.
 */
function _getKey() {
  const secret = (process.env.CONFIG_SECRET || 'streamfusion-dev-secret-change-me').trim();
  return crypto.scryptSync(secret, 'sfm-config-salt-v1', 32);
}

function _encrypt(plaintext) {
  const iv  = crypto.randomBytes(12); // 96-bit GCM IV
  const key = _getKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body   = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag(); // 16 bytes
  // Layout: 12 bytes IV | 16 bytes tag | N bytes ciphertext → base64url
  return Buffer.concat([iv, tag, body]).toString('base64url');
}

function _decrypt(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 29) throw new Error('token too short');
  const iv   = buf.slice(0, 12);
  const tag  = buf.slice(12, 28);
  const body = buf.slice(28);
  const key  = _getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encode config object to encrypted (or base64url in dev) URL token.
 * @param {object} config
 * @returns {string}
 */
function encodeConfig(config) {
  const obj = {};
  if (config.mfpUrl)                    obj.mfp  = config.mfpUrl.trim();
  if (config.mfpKey)                    obj.mfpk = config.mfpKey.trim();
  if (config.proxyUrl)                  obj.px   = config.proxyUrl.trim();
  if (config.hideCatalogs)              obj.hc   = 1;
  const pvMap = { kisskh: 'k', rama: 'r', drammatica: 'd', guardaserie: 'g' };
  if (config.providers && config.providers !== 'all') obj.pv = pvMap[config.providers] || config.providers;
  if (config.cinemeta)                  obj.cm   = 1;
  if (config.tmdbKey)                   obj.tm   = config.tmdbKey.trim();
  if (config.rpdbKey)                   obj.rp   = config.rpdbKey.trim();
  if (config.topPosterKey)               obj.tp   = config.topPosterKey.trim();
  return _encrypt(JSON.stringify(obj));
}

/**
 * Decode encrypted (or legacy base64url) URL token to config object.
 * @param {string} encoded
 * @returns {object}
 */
function decodeConfig(encoded) {
  if (!encoded) return { ...DEFAULT_CONFIG };
  try {
    // Try AES-GCM first
    const json = _decrypt(encoded);
    const obj = JSON.parse(json);
    const pvMap = { k: 'kisskh', r: 'rama', d: 'drammatica', g: 'guardaserie', a: 'all' };
    const decodedProviders = typeof obj.pv === 'string' ? (pvMap[obj.pv] || obj.pv) : 'all';
    return {
      mfpUrl:       (obj.mfp  || '').trim(),
      mfpKey:       (obj.mfpk || '').trim(),
      proxyUrl:     (obj.px   || '').trim(),
      hideCatalogs: !!obj.hc,
      providers:    decodedProviders,
      cinemeta:     !!obj.cm,
      tmdbKey:        (obj.tm   || DEFAULT_CONFIG.tmdbKey).trim(),
      rpdbKey:        (obj.rp   || '').trim(),
      topPosterKey:   (obj.tp   || '').trim(),
    };
  } catch {
    // Legacy fallback: plain base64url (for old install URLs)
    try {
      const obj = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      const pvMap = { k: 'kisskh', r: 'rama', d: 'drammatica', g: 'guardaserie', a: 'all' };
      const decodedProviders = typeof obj.pv === 'string' ? (pvMap[obj.pv] || obj.pv) : 'all';
      return {
        mfpUrl:       (obj.mfp  || '').trim(),
        mfpKey:       (obj.mfpk || '').trim(),
        proxyUrl:     (obj.px   || '').trim(),
        hideCatalogs: !!obj.hc,
        providers:    decodedProviders,
        cinemeta:     !!obj.cm,
        tmdbKey:        (obj.tm   || DEFAULT_CONFIG.tmdbKey).trim(),
        rpdbKey:        (obj.rp   || '').trim(),
        topPosterKey:   (obj.tp   || '').trim(),
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
}

/**
 * Check if a path segment is a valid config token (not a reserved route segment).
 * @param {string} str
 * @returns {boolean}
 */
function isValidConfig(str) {
  if (!str || typeof str !== 'string' || str.length < 4) return false;
  const reserved = ['catalog', 'meta', 'stream', 'manifest.json', 'health', 'debug', 'configure'];
  if (reserved.includes(str.toLowerCase())) return false;
  // Must decrypt/decode to valid JSON object
  try {
    const json = _decrypt(str);
    const obj = JSON.parse(json);
    return typeof obj === 'object' && obj !== null;
  } catch {
    // Try legacy base64url
    try {
      const obj = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
      return typeof obj === 'object' && obj !== null;
    } catch {
      return false;
    }
  }
}

// Centralised TMDB key — all modules should import this instead of hardcoding.
const TMDB_API_KEY = process.env.TMDB_API_KEY || DEFAULT_CONFIG.tmdbKey;

module.exports = { encodeConfig, decodeConfig, isValidConfig, DEFAULT_CONFIG, TMDB_API_KEY };
