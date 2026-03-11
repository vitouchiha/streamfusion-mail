'use strict';

/**
 * CB01 provider — movies and TV series (ITA)
 * Ported from tmp_mammamia/Src/API/cb01.py
 *
 * Searches CB01 for movies or series, resolves episode links via
 * stayonline.pro, and extracts video URLs from MixDrop / MaxStream.
 */

const { getProviderUrl } = require('../provider_urls.js');
const { extractMixDrop } = require('../extractors/mixdrop');
const { extractMaxStream } = require('../extractors/maxstream');
const { extractUprot } = require('../extractors/uprot');
const { fetchWithCloudscraper } = require('../utils/fetcher');

const TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function getCb01BaseUrl() {
  return (getProviderUrl('cb01') || 'https://cb01uno.uno').replace(/\/+$/, '');
}

// ─── TMDB helpers ────────────────────────────────────────────────────────────

async function getTmdbIdFromImdb(imdbId, type) {
  try {
    const resp = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
      { headers: { 'User-Agent': UA } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (type === 'movie' && Array.isArray(data.movie_results) && data.movie_results.length > 0)
      return data.movie_results[0].id;
    if (Array.isArray(data.tv_results) && data.tv_results.length > 0)
      return data.tv_results[0].id;
    return null;
  } catch {
    return null;
  }
}

async function getTitleAndYear(tmdbId, endpoint) {
  try {
    const resp = await fetch(
      `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=it-IT`,
      { headers: { 'User-Agent': UA } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const rawTitle = data.name || data.title || data.original_name || data.original_title || '';
    const rawDate = data.first_air_date || data.release_date || '';
    const year = rawDate.slice(0, 4);
    return rawTitle ? { title: rawTitle, year } : null;
  } catch {
    return null;
  }
}

// ─── Stayonline.pro helper ────────────────────────────────────────────────────

/**
 * Resolve a stayonline.pro link to the actual embed URL.
 * stayonline.pro is an indirection service used by CB01 for MixDrop/MaxStream links.
 */
async function resolveStayOnline(link) {
  try {
    // Extract the ID from stayonline URLs: /e/{id}/ or /l/{id}/ or /{id}/
    const idMatch = /stayonline\.pro\/(?:[el]\/)?([a-zA-Z0-9_-]+)/.exec(link);
    if (!idMatch) return null;
    const id = idMatch[1];

    const resp = await fetch('https://stayonline.pro/ajax/linkEmbedView.php', {
      method: 'POST',
      headers: {
        'Origin': 'https://stayonline.pro',
        'Referer': 'https://stayonline.pro/',
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ id, ref: '' }).toString(),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.data?.value || null;
  } catch {
    return null;
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

/** Normalize a title for URL-safe search query. */
function normalizeForSearch(title) {
  return String(title || '')
    .replace(/'/g, ' ')
    .replace(/[àá]/g, 'a')
    .replace(/[èé]/g, 'e')
    .replace(/[ìí]/g, 'i')
    .replace(/[òó]/g, 'o')
    .replace(/[ùú]/g, 'u')
    .replace(/\s+/g, '+');
}

/**
 * Search CB01 for a movie and return the show page URL.
 * Matches by year embedded in the URL slug.
 */
async function searchMovie(showname, year) {
  try {
    const base = getCb01BaseUrl();
    const query = normalizeForSearch(showname);
    const html = await fetchWithCloudscraper(`${base}/?s=${query}`, { referer: `${base}/` });
    if (!html) return null;
    const yearPattern = /(19|20)\d{2}/;

    // Each result card: <div class="card-content"> ... <h3 class="card-title"><a href="...">
    const cardRe = /<div[^>]+class="card-content"[\s\S]*?<h3[^>]+class="card-title"[^>]*>\s*<a[^>]+href="([^"]+)"/gi;
    for (const m of html.matchAll(cardRe)) {
      const href = m[1];
      const slug = href.split('/').filter(Boolean).pop() || href;
      const yearMatch = yearPattern.exec(slug);
      if (yearMatch && yearMatch[0] === String(year)) return href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Search CB01 for a TV series and return the show page URL.
 * Matches by year in the visible "coloured" span (within ±1).
 */
async function searchSeries(showname, year) {
  try {
    const base = getCb01BaseUrl();
    const query = normalizeForSearch(showname);
    const html = await fetchWithCloudscraper(`${base}/serietv/?s=${query}`, { referer: `${base}/serietv/` });
    if (!html) return null;
    const yearPattern = /(19|20)\d{2}/;

    const cardRe = /<div[^>]+class="card-content"([\s\S]*?)<\/div>/gi;
    for (const card of html.matchAll(cardRe)) {
      const cardHtml = card[1];
      const hrefMatch = /href="([^"]+)"/.exec(cardHtml);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];

      // Year is in a <span style="color..."> element
      const spanMatch = /<span[^>]+style="[^"]*color[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(cardHtml);
      if (!spanMatch) continue;
      const yearMatch = yearPattern.exec(spanMatch[1]);
      if (!yearMatch) continue;
      const diff = Math.abs(parseInt(yearMatch[0], 10) - parseInt(year, 10));
      if (diff <= 1) return href;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Stream extraction ────────────────────────────────────────────────────────

/**
 * Route a resolved stayonline URL to the right extractor.
 * - m1xdrop.net / mixdrop.*  → extractMixDrop
 * - maxstream.*              → extractMaxStream
 * - uprot.net                → skip (captcha required)
 * Returns a stream object or null.
 */
async function extractFromResolvedUrl(resolvedUrl, label) {
  const hasProxy = !!(process.env.PROXY_URL || process.env.PROXY);
  function makeCb01Stream(playerName, url, headers) {
    const obj = {
      name: `CB01`,
      title: `🎬 CB01\n🗣 🇮🇹 [ITA]\n▶️ ${playerName}\n🌐 Proxy (${hasProxy ? 'ON' : 'OFF'})\n🤌 CB01 🎞️`,
      url: url,
    };
    if (headers) obj.behaviorHints = { notWebReady: true, proxyHeaders: { request: headers } };
    return obj;
  }
  try {
    const host = new URL(resolvedUrl).hostname.toLowerCase();
    if (host.includes('mixdrop') || host.includes('m1xdrop')) {
      const result = await extractMixDrop(resolvedUrl);
      if (result) return makeCb01Stream('MixDrop', result.url, result.headers);
    } else if (host.includes('maxstream')) {
      const result = await extractMaxStream(resolvedUrl);
      if (result) return makeCb01Stream('MaxStream', result.url);
    } else if (host.includes('uprot')) {
      const result = await extractUprot(resolvedUrl);
      if (result) return makeCb01Stream('MaxStream via Uprot', result.url, result.headers);
    }
  } catch { /* skip */ }
  return null;
}

/**
 * Extract stream(s) from a CB01 movie page.
 * Both iframen1 and iframen2 go through stayonline.pro.
 * The resolved URL determines which extractor to use (MixDrop or MaxStream).
 */
async function extractMovieStreams(pageUrl) {
  const streams = [];
  try {
    const html = await fetchWithCloudscraper(pageUrl, { referer: getCb01BaseUrl() + '/' });
    if (!html) return streams;

    // Collect all iframen divs with data-src (works for iframen1, iframen2, etc.)
    const iframeRe = /<div[^>]+id="(iframen\d+)"[^>]+data-src="([^"]+)"|<div[^>]+data-src="([^"]+)"[^>]+id="(iframen\d+)"/gi;
    const seen = new Set();
    for (const m of html.matchAll(iframeRe)) {
      const iframeId = m[1] || m[4];
      const stayUrl = m[2] || m[3];
      if (!stayUrl || seen.has(stayUrl)) continue;
      seen.add(stayUrl);

      if (!stayUrl.includes('stayonline')) continue;
      const resolvedUrl = await resolveStayOnline(stayUrl);
      if (!resolvedUrl) continue;

      const label = iframeId ? iframeId.replace('iframen', 'Link') : 'HD';
      const stream = await extractFromResolvedUrl(resolvedUrl, label);
      if (stream) streams.push(stream);
    }
  } catch (err) {
    console.error('[CB01] extractMovieStreams error:', err.message);
  }
  return streams;
}

/**
 * Resolve streams from a specific episode link on CB01.
 * All CB01 episode links go through stayonline.pro.
 */
async function extractEpisodeStreams(link) {
  const streams = [];
  try {
    if (link.includes('stayonline')) {
      const resolvedUrl = await resolveStayOnline(link);
      if (resolvedUrl) {
        const stream = await extractFromResolvedUrl(resolvedUrl, 'HD');
        if (stream) streams.push(stream);
      }
    } else if (link.includes('maxstream')) {
      const result = await extractMaxStream(link);
      if (result) {
        const hasProxy = !!(process.env.PROXY_URL || process.env.PROXY);
        streams.push({
          name: 'CB01',
          title: `🎬 CB01\n🗣 🇮🇹 [ITA]\n▶️ MaxStream\n🌐 Proxy (${hasProxy ? 'ON' : 'OFF'})\n🤌 CB01 🎞️`,
          url: result.url,
        });
      }
    } else if (link.includes('mixdrop') || link.includes('m1xdrop')) {
      const result = await extractMixDrop(link);
      if (result) {
        const hasProxy = !!(process.env.PROXY_URL || process.env.PROXY);
        streams.push({
          name: 'CB01',
          title: `🎬 CB01\n🗣 🇮🇹 [ITA]\n▶️ MixDrop\n🌐 Proxy (${hasProxy ? 'ON' : 'OFF'})\n🤌 CB01 🎞️`,
          url: result.url,
          ...(result.headers ? { behaviorHints: { notWebReady: true, proxyHeaders: { request: result.headers } } } : {}),
        });
      }
    }
  } catch { /* skip */ }
  return streams;
}

/**
 * Extract stream(s) from a CB01 series show page for the given season+episode.
 *
 * CB01 structure:
 *   <div class="sp-head">STAGIONE 2 ITA</div>
 *   Content with patterns: {season}&#215;{ep} or S{ss}E{ep} or {s}x{ep}
 */
async function extractSeriesStreams(pageUrl, season, episode) {
  const streams = [];
  try {
    const html = await fetchWithCloudscraper(pageUrl, { referer: getCb01BaseUrl() + '/' });
    if (!html) return streams;

    const seasonStr = String(season);
    const episodePadded = String(episode).padStart(2, '0');

    // Find all season accordion headers: <div class="sp-head">STAGIONE N</div>
    const spHeadRe = /<div[^>]+class="sp-head"[^>]*>([\s\S]*?)<\/div>/gi;

    // Also try simpler flat episode patterns in the full HTML
    // Pattern 1: {season}&#215;{ep} – <a href='...'
    const flatPattern1 = new RegExp(
      `${seasonStr}&#215;${episodePadded}[\\s\\S]*?href='([^']+)'`,
      'i'
    );
    const flatMatch1 = flatPattern1.exec(html);
    if (flatMatch1 && flatMatch1[1]) {
      const s = await extractEpisodeStreams(flatMatch1[1]);
      if (s.length) return s;
    }

    // Pattern 2: S{ss}E{ep} or {s}x{ep} href
    const epStr = episodePadded;
    const flatPattern2 = new RegExp(
      `(?:S${epStr.padStart(2, '0')}E${epStr}|${seasonStr}x${epStr})[\\s\\S]*?href='([^']+)'`,
      'i'
    );
    const flatMatch2 = flatPattern2.exec(html);
    if (flatMatch2 && flatMatch2[1]) {
      const s = await extractEpisodeStreams(flatMatch2[1]);
      if (s.length) return s;
    }

    // Walk sp-head accordion sections and find the right season
    for (const headMatch of html.matchAll(spHeadRe)) {
      const headText = headMatch[1].replace(/<[^>]+>/g, '').trim();
      if (!headText.includes('STAGIONE')) continue;

      // Check if this season block covers our season number
      const singleSeasonMatch = /STAGIONE\s+(\d+)/i.exec(headText);
      const rangeSeasonMatch = /STAGIONE\s+(\d+)\s+A\s+(\d+)/i.exec(headText);

      let coversOurSeason = false;
      if (rangeSeasonMatch) {
        const lo = parseInt(rangeSeasonMatch[1], 10);
        const hi = parseInt(rangeSeasonMatch[2], 10);
        coversOurSeason = parseInt(seasonStr, 10) >= lo && parseInt(seasonStr, 10) <= hi;
      } else if (singleSeasonMatch) {
        coversOurSeason = singleSeasonMatch[1] === seasonStr;
      }

      if (!coversOurSeason) continue;

      // Find the associated content block. Try fetching the link inside sp-head.
      const hrefInHead = /href="([^"]+)"/.exec(headMatch[0]);
      if (hrefInHead) {
        try {
          const subHtml = await fetchWithCloudscraper(hrefInHead[1], { referer: pageUrl });
          if (subHtml) {
            const epPatterns = [
              new RegExp(`(?:S${epStr.padStart(2, '0')}|${seasonStr}x)${epStr}[\\s\\S]*?href='([^']+)'`, 'i'),
              new RegExp(`${seasonStr}&#215;${epStr}[\\s\\S]*?href='([^']+)'`, 'i'),
            ];
            for (const pat of epPatterns) {
              const m = pat.exec(subHtml);
              if (m && m[1]) {
                const s = await extractEpisodeStreams(m[1]);
                if (s.length) return s;
              }
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    console.error('[CB01] extractSeriesStreams error:', err.message);
  }
  return streams;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main provider entry point.
 * Called by src/index.js with the shared provider context object.
 *
 * @param {string} id             Raw Stremio ID
 * @param {string} type           'movie' | 'series' | 'anime'
 * @param {number} season         Season number (series only)
 * @param {number} episode        Episode number (series only)
 * @param {object} [providerContext]  Shared context with tmdbId, imdbId, primaryTitle, titleCandidates
 * @returns {Promise<Array>}      Array of stream objects
 */
async function getStreams(id, type, season, episode, providerContext = null) {
  try {
    const normalizedType = String(type || '').toLowerCase();
    const isMovie = normalizedType === 'movie';

    const effectiveSeason = !isMovie && Number.isInteger(season) && season > 0 ? season : null;
    const effectiveEpisode = !isMovie && Number.isInteger(episode) && episode > 0 ? episode : null;

    // Resolve title + year
    let showname = '';
    let year = '';

    const contextTmdbId = providerContext && /^\d+$/.test(String(providerContext.tmdbId || ''))
      ? String(providerContext.tmdbId)
      : null;
    const contextImdbId = providerContext && /^tt\d+$/i.test(String(providerContext.imdbId || ''))
      ? String(providerContext.imdbId)
      : null;

    let tmdbId = contextTmdbId;

    // Convert IMDb → TMDB if needed
    if (!tmdbId && contextImdbId) {
      const converted = await getTmdbIdFromImdb(contextImdbId, isMovie ? 'movie' : 'tv');
      if (converted) tmdbId = String(converted);
    }
    if (!tmdbId && String(id).startsWith('tmdb:')) {
      tmdbId = String(id).replace('tmdb:', '').split(':')[0];
    }

    if (tmdbId) {
      const info = await getTitleAndYear(tmdbId, isMovie ? 'movie' : 'tv');
      if (info) {
        // If TMDB it-IT returns a non-Latin title (e.g. Korean), prefer context title
        const isLatin = /[a-zA-Z]/.test(info.title);
        if (isLatin) {
          showname = info.title;
        }
        year = info.year;
      }
    }

    if (!showname && providerContext) {
      showname = String(providerContext.primaryTitle || '').trim();
      if (!showname && Array.isArray(providerContext.titleCandidates)) {
        showname = String(providerContext.titleCandidates[0] || '').trim();
      }
    }

    if (!showname) {
      console.warn('[CB01] Cannot resolve title for', id);
      return [];
    }

    console.log(`[CB01] Searching: "${showname}" (${year}) type=${normalizedType} S${effectiveSeason}E${effectiveEpisode}`);

    // Try title candidates
    const candidates = [showname];
    if (providerContext && Array.isArray(providerContext.titleCandidates)) {
      for (const tc of providerContext.titleCandidates) {
        const t = String(tc || '').trim();
        if (t && t !== showname) candidates.push(t);
      }
    }

    for (const title of candidates) {
      let pageUrl;
      if (isMovie) {
        pageUrl = await searchMovie(title, year);
        if (!pageUrl) continue;
        const streams = await extractMovieStreams(pageUrl);
        if (streams.length) {
          console.log(`[CB01] Found ${streams.length} movie stream(s) for "${title}"`);
          return streams;
        }
      } else {
        pageUrl = await searchSeries(title, year);
        if (!pageUrl) continue;
        const streams = await extractSeriesStreams(pageUrl, effectiveSeason, effectiveEpisode);
        if (streams.length) {
          console.log(`[CB01] Found ${streams.length} series stream(s) for "${title}"`);
          return streams;
        }
      }
    }

    console.log('[CB01] No streams found for', showname);
    return [];
  } catch (err) {
    console.error('[CB01] Error:', err.message);
    return [];
  }
}

module.exports = { getStreams };

