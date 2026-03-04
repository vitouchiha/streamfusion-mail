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
 *   Direct video → /proxy/hls/manifest.m3u8?d=URL  (pass-through on custom proxy)
 *   Subtitle     → /proxy/hls/manifest.m3u8?d=URL
 *
 * Note: /proxy/stream is NOT used because custom HLS proxies return 404 for it.
 *       /proxy/hls/manifest.m3u8 works universally: proxies HLS and passes through MP4.
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
  // Use /proxy/hls/manifest.m3u8 universally:
  //   - properly proxies HLS (.m3u8) playlists + segments
  //   - passes through direct MP4/video files (content-type: video/mp4)
  //   - compatible with both standard MFP and custom HLS proxy servers
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

module.exports = { wrapStreamUrl, wrapSubUrl };
