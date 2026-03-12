var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};
const { getProviderUrl } = require("../provider_urls.js");
function getGuardaHdBaseUrl() {
  return getProviderUrl("guardahd");
}
const TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

const { extractFromUrl } = require('../extractors');
require('../fetch_helper.js');
const { formatStream } = require('../formatter.js');
const { checkQualityFromPlaylist, getQualityFromUrl } = require('../quality_helper.js');
const { launchBrowser } = require('../utils/browser.js');
const { createLogger } = require('../utils/logger.js');
const { fetchWithCloudscraper } = require('../utils/fetcher.js');

const log = createLogger('guardahd');

function getQualityFromName(qualityStr) {
  if (!qualityStr) return 'Unknown';

  const quality = qualityStr.toUpperCase();

  // Map API quality values to normalized format
  if (quality === 'ORG' || quality === 'ORIGINAL') return 'Original';
  if (quality === '4K' || quality === '2160P') return '4K';
  if (quality === '1440P' || quality === '2K') return '1440p';
  if (quality === '1080P' || quality === 'FHD') return '1080p';
  if (quality === '720P' || quality === 'HD') return '720p';
  if (quality === '480P' || quality === 'SD') return '480p';
  if (quality === '360P') return '360p';
  if (quality === '240P') return '240p';

  // Try to extract number from string and format consistently
  const match = qualityStr.match(/(\d{3,4})[pP]?/);
  if (match) {
    const resolution = parseInt(match[1]);
    if (resolution >= 2160) return '4K';
    if (resolution >= 1440) return '1440p';
    if (resolution >= 1080) return '1080p';
    if (resolution >= 720) return '720p';
    if (resolution >= 480) return '480p';
    if (resolution >= 360) return '360p';
    return '240p';
  }

  return 'Unknown';
}

function getImdbId(tmdbId, type) {
  return __async(this, null, function* () {
    try {
      const normalizedType = String(type).toLowerCase();
      const endpoint = normalizedType === "movie" ? "movie" : "tv";
      const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
      const response = yield fetch(url);
      if (!response.ok) return null;
      const data = yield response.json();
      if (data.imdb_id) {
        console.log(`[GuardaHD] Converted TMDB ${tmdbId} to IMDb ${data.imdb_id}`);
        return data.imdb_id;
      }
      const externalUrl = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
      const extResponse = yield fetch(externalUrl);
      if (extResponse.ok) {
        const extData = yield extResponse.json();
        if (extData.imdb_id) {
            console.log(`[GuardaHD] Converted TMDB ${tmdbId} to IMDb ${extData.imdb_id} (via external_ids)`);
            return extData.imdb_id;
        }
      }
      console.log(`[GuardaHD] Failed to convert TMDB ${tmdbId} to IMDb`);
      return null;
    } catch (e) {
      console.error("[GuardaHD] Conversion error:", e);
      return null;
    }
  });
}
function getMetadata(id, type) {
  return __async(this, null, function* () {
    try {
      const normalizedType = String(type).toLowerCase();
      let queryId = id;

      let url;
      if (String(queryId).startsWith("tt")) {
          url = `https://api.themoviedb.org/3/find/${queryId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=it-IT`;
      } else {
          const endpoint = normalizedType === "movie" ? "movie" : "tv";
          url = `https://api.themoviedb.org/3/${endpoint}/${queryId}?api_key=${TMDB_API_KEY}&language=it-IT`;
      }
      
      const response = yield fetch(url);
      if (!response.ok) return null;
      const data = yield response.json();
      
      if (String(queryId).startsWith("tt")) {
          const results = normalizedType === "movie" ? data.movie_results : data.tv_results;
          if (results && results.length > 0) return results[0];
      } else {
          return data;
      }
      return null;
    } catch (e) {
      console.error("[GuardaHD] Metadata error:", e);
      return null;
    }
  });
}

function normalizeMirrorUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value || value === '#') return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:/i.test(value)) return value;
  return null;
}

function collectLegacyGuardaHdLinks(html) {
  const links = [];
  const iframeRegex = /<iframe[^>]+id=["']_player["'][^>]+src=["']([^"']+)["']/i;
  const iframeMatch = iframeRegex.exec(html);
  if (iframeMatch) {
    const normalized = normalizeMirrorUrl(iframeMatch[1]);
    if (normalized) links.push({ url: normalized, name: 'Active Player' });
  }

  const linkRegex = /data-link=["']([^"']+)["']/g;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const normalized = normalizeMirrorUrl(match[1]);
    if (normalized) links.push({ url: normalized, name: 'Alternative' });
  }

  return links;
}

function collectStreamvixMovieLinks(html) {
  const results = [];
  const seen = new Set();
  const blocks = [
    { regex: /<ul[^>]+class=["'][^"']*_player-mirrors[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i, name: 'Main Mirror' },
    { regex: /<[^>]+class=["'][^"']*_hidden-mirrors[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i, name: 'Hidden Mirror' },
  ];

  for (const block of blocks) {
    const blockMatch = html.match(block.regex);
    if (!blockMatch) continue;
    for (const match of blockMatch[1].matchAll(/data-link=["']([^"']+)["']/g)) {
      const normalized = normalizeMirrorUrl(match[1]);
      if (!normalized) continue;
      if (/mostraguarda/i.test(normalized)) continue;
      if (/streamtape\.com/i.test(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      results.push({ url: normalized, name: block.name });
    }
  }

  if (results.length > 0) return results;

  for (const match of html.matchAll(/data-link=["']([^"']+)["']/g)) {
    const normalized = normalizeMirrorUrl(match[1]);
    if (!normalized) continue;
    if (/mostraguarda/i.test(normalized)) continue;
    if (/streamtape\.com/i.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    results.push({ url: normalized, name: 'Mirror' });
  }

  return results;
}

async function fetchHtmlWithBrowser(url, refererBase) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    if (refererBase) {
      await page.setExtraHTTPHeaders({ Referer: refererBase });
    }
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 25000,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const html = await page.content();
    const finalUrl = page.url();
    await page.close().catch(() => {});
    return { html, finalUrl };
  } catch (error) {
    log.warn('browser html fetch failed', { url, error: error.message });
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

function getStreams(id, type, season, episode, providerContext = null) {
  if (['series', 'tv'].includes(String(type).toLowerCase())) return [];
  return __async(this, null, function* () {
    let cleanId = id.toString();

    if (cleanId.startsWith("tmdb:")) cleanId = cleanId.replace("tmdb:", "");
    let imdbId = cleanId;
    if (!cleanId.startsWith("tt")) {
      const convertedId = yield getImdbId(cleanId, type);
      if (convertedId) imdbId = convertedId;
      else return [];
    }
    
    let metadata = null;
    try {
        metadata = yield getMetadata(cleanId, type);
    } catch (e) {
        console.error("[GuardaHD] Error fetching metadata:", e);
    }

    const normalizedType = String(type).toLowerCase();
    const title = (metadata && (metadata.title || metadata.name || metadata.original_title || metadata.original_name)) 
        ? (metadata.title || metadata.name || metadata.original_title || metadata.original_name) 
        : (normalizedType === "movie" ? "Film Sconosciuto" : "Serie TV");
    
    const baseUrl = getGuardaHdBaseUrl();
    if (normalizedType !== "movie") {
      return [];
    }

    try {
      const primaryUrl = `${baseUrl}/set-movie-a/${imdbId}`;
      const fallbackMovieUrl = `${baseUrl}/movie/${encodeURIComponent(imdbId)}`;
      const proxyUrl = String(providerContext?.proxyUrl || '').trim();

      let html = '';
      let links = [];

      html = yield fetchWithCloudscraper(primaryUrl, {
        referer: baseUrl,
        timeout: 12000,
        retries: 2,
        proxyUrl,
      });
      if (html) {
        links = collectLegacyGuardaHdLinks(html);
        log.info('primary page fetched', {
          imdbId,
          status: 200,
          links: links.length,
        });
      }

      if (!links.length) {
        html = yield fetchWithCloudscraper(fallbackMovieUrl, {
          referer: baseUrl,
          timeout: 12000,
          retries: 2,
          proxyUrl,
        });
        if (html) {
          links = collectStreamvixMovieLinks(html);
          log.info('fallback page fetched', {
            imdbId,
            status: 200,
            links: links.length,
          });
        }
      }

      if (!links.length) {
        const browserPrimary = yield fetchHtmlWithBrowser(primaryUrl, baseUrl);
        if (browserPrimary && browserPrimary.html) {
          html = browserPrimary.html;
          links = collectLegacyGuardaHdLinks(html);
          log.info('browser primary page fetched', {
            imdbId,
            finalUrl: browserPrimary.finalUrl,
            links: links.length,
          });
        }
      }

      if (!links.length) {
        const browserFallback = yield fetchHtmlWithBrowser(fallbackMovieUrl, baseUrl);
        if (browserFallback && browserFallback.html) {
          html = browserFallback.html;
          links = collectStreamvixMovieLinks(html);
          log.info('browser fallback page fetched', {
            imdbId,
            finalUrl: browserFallback.finalUrl,
            links: links.length,
          });
        }
      }

      if (!links.length) return [];

      const streams = [];
      const displayName = title;
      const processUrl = async (link) => {
        let streamUrl = link.url;
        if (streamUrl.startsWith("//")) streamUrl = "https:" + streamUrl;
        
        try {
          const extractedStreams = await extractFromUrl(streamUrl, {
            refererBase: getGuardaHdBaseUrl(),
            proxyUrl: providerContext?.proxyUrl,
            providerContext,
          });
          if (extractedStreams.length === 0) return;

          console.log(`[GuardaHD] Extracted ${extractedStreams.length} stream(s) from ${streamUrl}`);
          for (const extracted of extractedStreams) {
            let quality = "HD";
            const playlistQuality = await checkQualityFromPlaylist(extracted.url, extracted.headers || {});
            if (playlistQuality) quality = playlistQuality;
            else {
              const urlQuality = getQualityFromUrl(extracted.url);
              if (urlQuality) quality = urlQuality;
            }

            const normalizedQuality = getQualityFromName(quality);
            const hasPlaybackHeaders = extracted.headers && Object.keys(extracted.headers).length > 0;
            const behaviorHints = extracted.isExternal
              ? { notWebReady: true }
              : hasPlaybackHeaders
                ? { notWebReady: true, proxyPlaybackDisabled: true }
                : undefined;

            streams.push({
              name: `GuardaHD - ${extracted.name || 'Player'}`,
              title: extracted.isExternal ? `Web Browser - ${displayName}` : displayName,
              url: extracted.url,
              headers: extracted.headers,
              isExternal: extracted.isExternal,
              behaviorHints,
              quality: normalizedQuality,
              type: "direct",
              addonBaseUrl: providerContext?.addonBaseUrl,
              ...(extracted.mfpHandled ? { mfpHandled: true } : {}),
            });
          }
        } catch (e) {
          console.error("[GuardaHD] Process URL error:", e);
        }
      };
      yield Promise.all(links.map((link) => processUrl(link)));
      const uniqueStreams = [];
      const seenUrls = /* @__PURE__ */ new Set();
      for (const s of streams) {
        if (!seenUrls.has(s.url)) {
          seenUrls.add(s.url);
          uniqueStreams.push(s);
        }
      }
      return uniqueStreams.map(s => formatStream(s, "GuardaHD")).filter(s => s !== null);
    } catch (error) {
      console.error("[GuardaHD] Error:", error);
      return [];
    }
  });
}
module.exports = { getStreams };
