const {
  USER_AGENT,
  getRefererBase,
  normalizeExtractorUrl,
  getProxiedUrl,
} = require('./common');
const { checkQualityFromPlaylist } = require('../quality_helper.js');
const { fetchWithCloudscraper } = require('../utils/fetcher');

function extractScriptBlocks(html) {
  const blocks = [];
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    if (match[1]) blocks.push(match[1]);
  }
  return blocks;
}

function extractLegacyPlaylistData(source) {
  const text = String(source || '');
  const tokenMatch = /'token'\s*:\s*'([^']+)'/.exec(text) || /token\s*:\s*"([^"]+)"/.exec(text);
  const expiresMatch = /'expires'\s*:\s*'([^']+)'/.exec(text) || /expires\s*:\s*"([^"]+)"/.exec(text);
  const urlMatch = /url\s*:\s*'([^']+)'/.exec(text) || /url\s*:\s*"([^"]+)"/.exec(text);
  if (!tokenMatch || !expiresMatch || !urlMatch) return null;

  return {
    baseUrl: urlMatch[1],
    token: tokenMatch[1],
    expires: expiresMatch[1],
  };
}

function extractMasterPlaylistData(source) {
  const text = String(source || '');
  const patterns = [
    /masterPlaylist\s*=\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"][\s\S]*?params\s*:\s*\{[\s\S]*?token\s*:\s*['"]([^'"]+)['"][\s\S]*?expires\s*:\s*['"]([^'"]+)['"][\s\S]*?\}/i,
    /masterPlaylist\s*:\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"][\s\S]*?params\s*:\s*\{[\s\S]*?token\s*:\s*['"]([^'"]+)['"][\s\S]*?expires\s*:\s*['"]([^'"]+)['"][\s\S]*?\}/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    return {
      baseUrl: match[1],
      token: match[2],
      expires: match[3],
    };
  }

  const blockMatch =
    /masterPlaylist\s*=\s*(\{[\s\S]*?\})\s*;?/i.exec(text) ||
    /masterPlaylist\s*:\s*(\{[\s\S]*?\})\s*[,\n]/i.exec(text);
  if (!blockMatch) return null;

  const block = blockMatch[1];
  const urlMatch = /url\s*:\s*['"]([^'"]+)['"]/i.exec(block);
  const tokenMatch = /token\s*:\s*['"]([^'"]+)['"]/i.exec(block);
  const expiresMatch = /expires\s*:\s*['"]([^'"]+)['"]/i.exec(block);
  if (!urlMatch || !tokenMatch || !expiresMatch) return null;

  return {
    baseUrl: urlMatch[1],
    token: tokenMatch[1],
    expires: expiresMatch[1],
  };
}

function buildPlaylistUrl(baseUrl, token, expires, canPlayFhd) {
  let finalUrl = String(baseUrl || '').trim();
  if (!finalUrl) return null;

  if (finalUrl.includes('?b=1')) {
    finalUrl = `${finalUrl}&token=${encodeURIComponent(token)}&expires=${encodeURIComponent(expires)}`;
  } else {
    finalUrl = `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}&expires=${encodeURIComponent(expires)}`;
  }

  const parts = finalUrl.split('?');
  const path = parts[0];
  const query = parts.length > 1 ? `?${parts.slice(1).join('?')}` : '';
  finalUrl = /\.m3u8$/i.test(path) ? `${path}${query}` : `${path}.m3u8${query}`;

  if (canPlayFhd && !/[?&]h=1(?:&|$)/i.test(finalUrl)) {
    finalUrl += `${finalUrl.includes('?') ? '&' : '?'}h=1`;
  }

  return finalUrl;
}

async function extractVixCloud(url, pageReferer = null) {
  try {
    const embedUrl = normalizeExtractorUrl(url);
    if (!embedUrl) return [];

    // Use the embedding AnimeUnity page as referer (VixCloud expects the embedding site)
    const embedReferer = pageReferer || 'https://www.animeunity.so/';
    const selfReferer = getRefererBase(embedUrl, 'https://vixcloud.co/');
    let html = null;

    // Try via CF Worker proxy first with AnimeUnity referer (simulates iframe from AnimeUnity)
    const proxiedUrl = getProxiedUrl(embedUrl, embedReferer);
    if (proxiedUrl !== embedUrl) {
      try {
        const response = await fetch(proxiedUrl, {
          headers: { "User-Agent": USER_AGENT, "Referer": embedReferer }
        });
        if (response.ok) {
          const text = await response.text();
          if (!text.includes("Cloudflare") && !text.includes("Just a moment")) {
            html = text;
          }
        }
      } catch {
        // fall through
      }
    }

    // Direct fetch fallback
    if (!html) {
      try {
        const response = await fetch(embedUrl, {
          headers: { "User-Agent": USER_AGENT, "Referer": embedReferer }
        });
        if (response.ok) {
          const text = await response.text();
          if (!text.includes("Cloudflare") && !text.includes("Just a moment")) {
            html = text;
          }
        }
      } catch {
        // fall through
      }
    }

    // Cloudscraper as last resort
    if (!html) {
      console.log(`[Extractors] VixCloud proxy/direct failed, retrying with cloudscraper`);
      html = await fetchWithCloudscraper(embedUrl, {
        retries: 1,
        timeout: 12000,
        referer: embedReferer
      });
    }

    if (!html) return [];

    const canPlayFhd = /window\.canPlayFHD\s*=\s*true/i.test(html);
    const candidates = [html, ...extractScriptBlocks(html)];

    let playlistData = null;
    for (const source of candidates) {
      playlistData = extractMasterPlaylistData(source) || extractLegacyPlaylistData(source);
      if (playlistData) break;
    }

    if (!playlistData) return [];

    const finalUrl = buildPlaylistUrl(
      normalizeExtractorUrl(playlistData.baseUrl, embedUrl),
      playlistData.token,
      playlistData.expires,
      canPlayFhd
    );
    if (!finalUrl) return [];

    const headers = {
      "User-Agent": USER_AGENT,
      "Referer": selfReferer
    };

    let quality = "Auto";
    const detectedQuality = await checkQualityFromPlaylist(finalUrl, headers);
    if (detectedQuality) quality = detectedQuality;

    return [{
      url: finalUrl,
      quality,
      type: "m3u8",
      headers
    }];
  } catch (e) {
    console.error("[VixCloud] Extraction error:", e);
    return [];
  }
}

module.exports = { extractVixCloud };
