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
    const mfpConfig = providerContext || {};
    if (mfpConfig.mfpUrl) {
      const mfpUrl = await extractViaMfp(url, 'Mixdrop', mfpConfig, false);
      if (mfpUrl) {
        const origin = getUrlOrigin(url) || 'https://m1xdrop.net';
        return {
          url: mfpUrl,
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': `${origin}/`,
            'Origin': origin
          }
        };
      }
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
