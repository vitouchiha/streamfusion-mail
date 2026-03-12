const {
  USER_AGENT,
  extractPackedValue,
  getUrlOrigin,
  normalizeExtractorUrl,
} = require('./common');
const { extractViaMfp } = require('../utils/mediaflow');

function isMixDropDisabled() {
  if (typeof global !== 'undefined' && global && global.DISABLE_MIXDROP === true) {
    return true;
  }

  const rawEnv =
    typeof process !== 'undefined' &&
    process &&
    process.env &&
    typeof process.env.DISABLE_MIXDROP === 'string'
      ? process.env.DISABLE_MIXDROP.trim().toLowerCase()
      : '';

  return ['1', 'true', 'yes', 'on'].includes(rawEnv);
}

async function extractMixDrop(url, refererBase = 'https://m1xdrop.net/', providerContext = null) {
  if (isMixDropDisabled()) return null;

  try {
    url = normalizeExtractorUrl(url);
    if (!url) return null;

    // Try MFP extractor first (handles new MixDrop obfuscation)
    // Use the extractor URL directly as the stream URL so MFP extracts AND
    // proxies from the same IP — MixDrop MP4 tokens are IP-locked.
    const mfpConfig = providerContext || {};
    if (mfpConfig.mfpUrl) {
      const base = mfpConfig.mfpUrl.replace(/\/$/, '');
      const params = new URLSearchParams({
        host: 'Mixdrop',
        d: url,
        redirect_stream: 'true',
      });
      if (mfpConfig.mfpKey) params.set('api_password', mfpConfig.mfpKey);
      const extractorUrl = `${base}/extractor/video?${params}`;
      return {
        url: extractorUrl,
        headers: null,
        mfpHandled: true,
      };
    }

    // Fallback: local p.a.c.k.e.r extraction (old MixDrop format)
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Referer": refererBase
      }
    });
    if (!response.ok) return null;
    const html = await response.text();

    const packed = extractPackedValue(html, [
      /MDCore\.wurl\s*=\s*"([^"]+)"/i,
      /MDCore\.wurl\s*=\s*'([^']+)'/i,
      /wurl\s*=\s*"([^"]+)"/i,
    ]);

    if (packed && packed.value) {
      const streamUrl = normalizeExtractorUrl(packed.value, url);
      if (!streamUrl) return null;

      const origin = getUrlOrigin(url) || 'https://m1xdrop.net';
      return {
        url: streamUrl,
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': `${origin}/`,
          'Origin': origin
        }
      };
    }
    return null;
  } catch (e) {
    console.error("[Extractors] MixDrop extraction error:", e);
    return null;
  }
}

module.exports = { extractMixDrop };
