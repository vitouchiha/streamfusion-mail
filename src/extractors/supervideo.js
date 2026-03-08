const {
  USER_AGENT,
  extractPackedValue,
  getProxiedUrl,
  getRefererBase,
  normalizeExtractorUrl,
} = require('./common');
const { fetchWithCloudscraper } = require('../utils/fetcher');

function buildSuperVideoEmbedUrl(url) {
  const normalized = normalizeExtractorUrl(url);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    let id = parts[parts.length - 1];
    const markerIndex = parts.findIndex((part) => part === 'e' || part === 'y');
    if (markerIndex !== -1 && parts[markerIndex + 1]) {
      id = parts[markerIndex + 1];
    }

    id = String(id || '').trim();
    if (!id) return null;
    return `https://supervideo.tv/e/${id}`;
  } catch {
    return null;
  }
}

async function extractSuperVideo(url, options = {}) {
  try {
    const embedUrl = buildSuperVideoEmbedUrl(url);
    if (!embedUrl) return null;

    let refererBase = typeof options === 'string' ? options : options.refererBase;
    if (!refererBase) refererBase = getRefererBase(embedUrl, "https://supervideo.tv/");
    const proxyUrl = typeof options === 'object' ? String(options.proxyUrl || '').trim() : '';

    // Use proxy for the initial fetch to bypass Cloudflare if configured
    const proxiedUrl = getProxiedUrl(embedUrl);

    let response = await fetch(proxiedUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Referer": refererBase
      }
    });
    let html = await response.text();

    if (html.includes("Cloudflare") || response.status === 403) {
      console.log(`[Extractors] SuperVideo (tv) returned 403/Cloudflare, retrying with cloudscraper`);
      html = await fetchWithCloudscraper(embedUrl, {
        retries: 1,
        timeout: 12_000,
        referer: refererBase,
        proxyUrl,
      });
      if (!html || html.includes("Cloudflare") || html.includes("Just a moment")) {
        console.log(`[Extractors] SuperVideo cloudscraper fallback failed`);
        return null;
      }
    }

    const packed = extractPackedValue(html, [
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*'([^']+)'/i,
    ]);

    if (packed && packed.value) {
      return normalizeExtractorUrl(packed.value, embedUrl);
    }
    return null;
  } catch (e) {
    console.error("[Extractors] SuperVideo extraction error:", e);
    return null;
  }
}

module.exports = { extractSuperVideo };
