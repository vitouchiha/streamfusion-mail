'use strict';

const crypto = require('crypto');

const HLS_PROXY_PATH = '/proxy/hls/manifest.m3u8';
const DEFAULT_PROXY_TTL_MS = Number(process.env.HLS_PROXY_TTL_MS) || 6 * 60 * 60 * 1000;
const HEADER_ALLOWLIST = new Map([
  ['referer', 'Referer'],
  ['origin', 'Origin'],
  ['user-agent', 'User-Agent'],
  ['accept', 'Accept'],
  ['accept-language', 'Accept-Language'],
]);

function normalizeAddonBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function getProxySecret() {
  return String(
    process.env.HLS_PROXY_SECRET ||
    process.env.CONFIG_SECRET ||
    'streamfusion-hls-proxy-secret-change-me'
  ).trim();
}

function sanitizeProxyHeaders(headers = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = HEADER_ALLOWLIST.get(String(rawKey || '').toLowerCase());
    const value = String(rawValue || '').trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function signTokenPayload(payload) {
  return crypto
    .createHmac('sha256', getProxySecret())
    .update(payload)
    .digest('base64url');
}

function createProxyToken({ url, headers = {}, expiresAt, proxyUrl, cachedBody } = {}) {
  const normalizedUrl = String(url || '').trim();
  if (!isHttpUrl(normalizedUrl)) {
    throw new Error('Invalid proxy target URL');
  }

  const exp = Number.isFinite(expiresAt) && expiresAt > Date.now()
    ? Math.trunc(expiresAt)
    : Date.now() + DEFAULT_PROXY_TTL_MS;

  // Only embed the body if it's a reasonable size (< 16KB) to keep the token URL manageable.
  // Master manifests are typically 1-8KB; this avoids embedding large media playlists.
  const body = cachedBody && String(cachedBody).length < 16384 ? String(cachedBody) : undefined;

  const payload = Buffer.from(JSON.stringify({
    u: new URL(normalizedUrl).toString(),
    h: sanitizeProxyHeaders(headers),
    e: exp,
    ...(proxyUrl ? { p: String(proxyUrl) } : {}),
    ...(body ? { b: body } : {}),
  })).toString('base64url');

  return `${payload}.${signTokenPayload(payload)}`;
}

function parseProxyToken(token) {
  const raw = String(token || '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) {
    throw new Error('Malformed proxy token');
  }

  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = signTokenPayload(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error('Invalid proxy token signature');
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid proxy token payload');
  }

  if (!data || !isHttpUrl(data.u)) {
    throw new Error('Invalid proxy token URL');
  }

  const expiresAt = Number(data.e);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('Expired proxy token');
  }

  return {
    url: new URL(String(data.u)).toString(),
    headers: sanitizeProxyHeaders(data.h),
    expiresAt,
    proxyUrl: typeof data.p === 'string' ? data.p : undefined,
    cachedBody: typeof data.b === 'string' ? data.b : undefined,
  };
}

function buildProxyUrl(baseUrl, targetUrl, headers = {}, expiresAt, proxyUrl, cachedBody) {
  const normalizedBaseUrl = normalizeAddonBaseUrl(baseUrl);
  if (!normalizedBaseUrl || !isHttpUrl(targetUrl)) {
    return targetUrl;
  }

  const token = createProxyToken({ url: targetUrl, headers, expiresAt, proxyUrl, cachedBody });
  return `${normalizedBaseUrl}${HLS_PROXY_PATH}?token=${encodeURIComponent(token)}`;
}

function resolveProxyTarget(rawUrl, baseUrl) {
  return new URL(String(rawUrl || '').trim(), baseUrl).toString();
}

function rewriteTagUris(line, baseUrl, buildUrl) {
  return line.replace(/URI="([^"]+)"/g, (_match, rawUrl) => {
    const resolved = resolveProxyTarget(rawUrl, baseUrl);
    return `URI="${buildUrl(resolved)}"`;
  });
}

function rewritePlaylist(playlistBody, playlistUrl, headers, addonBaseUrl, expiresAt, proxyUrl) {
  const buildUrl = (resolvedUrl) => buildProxyUrl(addonBaseUrl, resolvedUrl, headers, expiresAt, proxyUrl);
  return String(playlistBody || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return rewriteTagUris(line, playlistUrl, buildUrl);
      }
      return buildUrl(resolveProxyTarget(trimmed, playlistUrl));
    })
    .join('\n');
}

function isHlsProxyPlaybackUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return /\/proxy\/(?:hls|mpd)\/manifest\.m3u8$/i.test(parsed.pathname || '');
  } catch {
    return /\/proxy\/(?:hls|mpd)\/manifest\.m3u8/i.test(String(rawUrl || '').trim());
  }
}

function isLikelyHlsPlaylist(targetUrl, contentType = '') {
  const type = String(contentType || '').toLowerCase();
  if (
    type.includes('application/vnd.apple.mpegurl') ||
    type.includes('application/x-mpegurl') ||
    type.includes('audio/mpegurl') ||
    type.includes('audio/x-mpegurl')
  ) {
    return true;
  }

  return /\.m3u8(?:[?#].*)?$/i.test(String(targetUrl || '').trim());
}

module.exports = {
  HLS_PROXY_PATH,
  buildProxyUrl,
  createProxyToken,
  isHlsProxyPlaybackUrl,
  isLikelyHlsPlaylist,
  parseProxyToken,
  rewritePlaylist,
  sanitizeProxyHeaders,
};
