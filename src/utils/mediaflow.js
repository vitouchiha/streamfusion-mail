'use strict';

/**
 * MediaFlow Proxy / HLS Proxy integration
 *
 * Wraps stream and subtitle URLs through a proxy instance.
 * Compatible with:
 *   - Standard MediaFlow Proxy (https://github.com/mhdzumair/mediaflow-proxy)
 *   - Custom HLS Proxy Server (e.g. https://easy.koyeb.app)
 *
 * Endpoint mapping:
 *   HLS (.m3u8)  → /proxy/hls/manifest.m3u8?d=URL[&api_password=KEY]
 *   DASH (.mpd)  → /proxy/mpd/manifest.m3u8?d=URL[&api_password=KEY]
 *   MP4/direct   → /proxy/stream?d=URL  (standard MFP direct video passthrough)
 *   Subtitle     → /proxy/hls/manifest.m3u8?d=URL
 */

/**
 * Wrap a stream URL through MediaFlow Proxy.
 * @param {string} url           - Original stream URL
 * @param {object} config        - User config { mfpUrl, mfpKey }
 * @param {object} [fwdHeaders]  - Headers to forward (Referer, Origin)
 * @returns {string}             - Proxied URL, or original if MFP not configured
 */
function wrapStreamUrl(url, config, fwdHeaders = {}) {
  if (!config || !config.mfpUrl || !url) return url;

  const base   = config.mfpUrl.replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('d', url);
  if (config.mfpKey) params.set('api_password', config.mfpKey);
  if (fwdHeaders['Referer']) params.set('h_referer', fwdHeaders['Referer']);
  if (fwdHeaders['Origin'])  params.set('h_origin',  fwdHeaders['Origin']);

  if (/\.mpd(\?|$)/i.test(url)) {
    return `${base}/proxy/mpd/manifest.m3u8?${params}`;
  }
  // Direct video files → /proxy/stream (standard MFP passthrough endpoint)
  if (/\.(mp4|mkv|avi|ts)(\?|#|$)/i.test(url)) {
    return `${base}/proxy/stream?${params}`;
  }
  // HLS playlists → /proxy/hls/manifest.m3u8
  return `${base}/proxy/hls/manifest.m3u8?${params}`;
}

/**
 * Wrap a subtitle URL through MediaFlow Proxy.
 * @param {string} url    - Original subtitle URL (.srt / .vtt / .txt1)
 * @param {object} config - User config { mfpUrl, mfpKey }
 * @returns {string}
 */
function wrapSubUrl(url, config) {
  if (!config || !config.mfpUrl || !url) return url;
  const base   = config.mfpUrl.replace(/\/$/, '');
  const params = new URLSearchParams({ d: url });
  if (config.mfpKey) params.set('api_password', config.mfpKey);
  return `${base}/proxy/hls/manifest.m3u8?${params}`;
}

/**
 * Post-process a provider's stream array applying MFP when configured.
 *
 * Only wraps streams that actually need a proxy (those that have headers to forward
 * OR are HLS playlists). Streams without headers and plain MP4 direct-plays are
 * left untouched so they are not unnecessarily routed through MFP.
 *
 * Call this AFTER the provider returns its results and BEFORE merging into the
 * final streams array. The context passed to the provider should have been built
 * with addonBaseUrl='' to prevent the internal HLS proxy from double-wrapping.
 *
 * @param {Array}  streams - Raw stream objects from the provider
 * @param {object} config  - User config { mfpUrl, mfpKey }
 * @returns {Array} Streams with MFP-wrapped URLs (or original if no MFP)
 */
function wrapProviderStreamsWithMfp(streams, config) {
  if (!config || !config.mfpUrl || !Array.isArray(streams)) return streams;

  return streams.map(s => {
    if (!s || !s.url) return s;

    // Collect headers from all locations formatStream or providers may write them
    const fwdHeaders =
      (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) ||
      s.headers ||
      {};

    const hasHeaders = Object.keys(fwdHeaders).length > 0;
    // Also proxy HLS playlists even without explicit headers (notWebReady case)
    const isHls = !hasHeaders && /\.(m3u8|txt)(\?|#|$)/i.test(s.url.split('?')[0]);

    if (!hasHeaders && !isHls) return s; // plain MP4 or unknown — leave untouched

    const wrapped = wrapStreamUrl(s.url, config, fwdHeaders);
    if (wrapped === s.url) return s; // wrapStreamUrl had nothing to do

    // Build clean stream: MFP URL, no headers (consumed by MFP query params)
    const result = { ...s, url: wrapped };
    delete result.headers;
    if (result.behaviorHints) {
      result.behaviorHints = { ...result.behaviorHints };
      delete result.behaviorHints.proxyHeaders;
      delete result.behaviorHints.headers;
      result.behaviorHints.notWebReady = false; // MFP makes it web-ready
    }
    return result;
  });
}

module.exports = { wrapStreamUrl, wrapSubUrl, wrapProviderStreamsWithMfp };
