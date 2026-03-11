'use strict';

/**
 * Eurostreaming provider — series only (ITA dub/sub)
 * Ported from tmp_mammamia/Src/API/eurostreaming.py
 *
 * Uses the WordPress REST API to search posts, then parses episode rows
 * of the form "{season}&#215;{episode} – <a href="...">Host</a>"
 * and extracts video URLs via MixDrop / Turbovid / MaxStream extractors.
 */

const { getProviderUrl } = require('../provider_urls.js');
const { extractMixDrop } = require('../extractors/mixdrop');
const { extractMaxStream } = require('../extractors/maxstream');
const { extractTurbovidda, bypassSafego } = require('../extractors/turbovidda');

const TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function getEsBaseUrl() {
  return (getProviderUrl('eurostreaming') || 'https://eurostreamings.life').replace(/\/+$/, '');
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Simple SequenceMatcher-like ratio: 2*LCS / (|a|+|b|).
 * Good enough for 0.96 threshold check (nearly exact title match).
 */
function titleRatio(a, b) {
  const sa = String(a || '').toLowerCase().trim();
  const sb = String(b || '').toLowerCase().trim();
  if (sa === sb) return 1.0;
  if (!sa || !sb) return 0.0;

  // LCS via iterative DP
  const m = sa.length, n = sb.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (sa[i - 1] === sb[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return (2.0 * dp[m][n]) / (m + n);
}

/** Decode common HTML entities in a title string. */
function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ─── TMDB helpers ────────────────────────────────────────────────────────────

async function getTmdbIdFromImdb(imdbId) {
  try {
    const resp = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
      { headers: { 'User-Agent': UA } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (Array.isArray(data.tv_results) && data.tv_results.length > 0) return data.tv_results[0].id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Get { title, year } from TMDB for TV or movie.
 * @param {string} tmdbId
 * @param {'tv'|'movie'} endpoint
 * @returns {Promise<{title:string, year:string}|null>}
 */
async function getTitleAndYear(tmdbId, endpoint = 'tv') {
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

// ─── Link resolution helpers ──────────────────────────────────────────────────

/**
 * Follow a redirect chain (up to 6 hops) to resolve the final URL.
 * Used to go from a safego/intermediate link to the actual video host.
 */
async function followRedirectChain(url, maxHops = 6) {
  let current = String(url || '').trim();
  for (let i = 0; i < maxHops; i++) {
    try {
      const resp = await fetch(current, {
        headers: { 'User-Agent': UA, 'Range': 'bytes=0-0' },
        redirect: 'manual',
      });
      if (resp.status === 200 || resp.status === 206) break; // Already final URL
      const location = resp.headers.get('location');
      if (!location) break;
      current = new URL(location, current).href;
    } catch {
      break;
    }
  }
  return current;
}

/**
 * Resolve a host link through the safego redirect chain.
 * Returns the actual player URL (turbovid / mixdrop / maxstream), or null.
 */
async function resolveHostLink(href) {
  try {
    let current = String(href || '').trim();
    if (!current.startsWith('http')) return null;

    // Follow redirects until safego or a recognisable video host
    for (let i = 0; i < 6; i++) {
      if (
        current.includes('turbovid') ||
        current.includes('deltabit') ||
        current.includes('mixdrop') ||
        current.includes('m1xdrop') ||
        current.includes('maxstream')
      ) {
        return current;
      }
      if (current.includes('safego')) {
        // Try safego bypass
        const resolved = await bypassSafego(current);
        return resolved || null;
      }
      const next = await followRedirectChain(current, 1);
      if (next === current) break;
      current = next;
    }
    return current;
  } catch {
    return null;
  }
}

// ─── Episode extraction ───────────────────────────────────────────────────────

/**
 * Scrape the player links from a raw HTML anchor block.
 * Priority: MixDrop → DeltaBit (Turbovid) → MaxStream.
 *
 * @param {string} atag   Raw HTML snippet with <a> tags for this episode
 * @param {string} language  "\nITA" or "\nSUB-ITA"
 * @param {string} siteName  e.g. "Eurostreaming"
 * @returns {Promise<Array>}  Array of stream objects
 */
async function scrapingLinks(atag, language, siteName) {
  const streams = [];

  const hasMixDrop = /MixDrop/i.test(atag);
  const hasDeltaBit = /DeltaBit/i.test(atag);
  const hasMaxStream = /MaxStream/i.test(atag);
  const hasTurbovid = /Turbovid/i.test(atag);

  // Helper: extract href for a named host from the atag
  function extractHref(hostName) {
    const re = new RegExp(`<a\\s[^>]*href="([^"]+)"[^>]*>\\s*${hostName}\\s*<\\/a>`, 'i');
    const m = re.exec(atag);
    return m ? m[1] : null;
  }

  if (hasMixDrop && !hasDeltaBit) {
    try {
      const href = extractHref('MixDrop');
      if (href) {
        const resolved = await resolveHostLink(href);
        if (resolved && (resolved.includes('mixdrop') || resolved.includes('m1xdrop'))) {
          const result = await extractMixDrop(resolved);
          if (result) {
            streams.push({
              name: `Eurostreaming${language}`,
              title: `🎬 ${siteName}\n▶️ MixDrop`,
              url: result.url,
              ...(result.headers ? { behaviorHints: { proxyHeaders: { request: result.headers } } } : {}),
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  if (hasDeltaBit) {
    try {
      const href = extractHref('DeltaBit');
      if (href) {
        const resolved = await resolveHostLink(href);
        if (resolved) {
          const result = await extractTurbovidda(resolved);
          if (result) {
            streams.push({
              name: `Eurostreaming${language}`,
              title: `🎬 ${siteName}\n▶️ DeltaBit`,
              url: result.url,
            });
          }
        }
      }
    } catch { /* skip */ }
    // MixDrop as fallback if DeltaBit fails and MixDrop is available
    if (streams.length === 0 && hasMixDrop) {
      try {
        const href = extractHref('MixDrop');
        if (href) {
          const resolved = await resolveHostLink(href);
          if (resolved) {
            const result = await extractMixDrop(resolved);
            if (result) {
              streams.push({
                name: `Eurostreaming${language}`,
                title: `🎬 ${siteName}\n▶️ MixDrop`,
                url: result.url,
                ...(result.headers ? { behaviorHints: { proxyHeaders: { request: result.headers } } } : {}),
              });
            }
          }
        }
      } catch { /* skip */ }
    }
  }

  if (streams.length === 0 && hasMaxStream) {
    try {
      const href = extractHref('MaxStream');
      if (href) {
        const resolved = await resolveHostLink(href);
        const target = resolved || href;
        const result = await extractMaxStream(target);
        if (result) {
          streams.push({
            name: `Eurostreaming${language}`,
            title: `🎬 ${siteName}\n▶️ MaxStream`,
            url: result.url,
          });
        }
      }
    } catch { /* skip */ }
  }

  if (streams.length === 0 && hasTurbovid) {
    try {
      const href = extractHref('Turbovid');
      if (href) {
        const resolved = await resolveHostLink(href);
        if (resolved) {
          const result = await extractTurbovidda(resolved);
          if (result) {
            streams.push({
              name: `Eurostreaming${language}`,
              title: `🎬 ${siteName}\n▶️ Turbovid`,
              url: result.url,
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  return streams;
}

/**
 * Find episode matches in a Eurostreaming post HTML and extract streams.
 * Pattern: {season}&#215;{ep} … links … <br>
 */
async function findEpisodeStreams(description, season, episode) {
  const episodePadded = String(episode).padStart(2, '0');
  // &#215; is the "×" multiplication sign used as separator between season/ep
  const re = new RegExp(
    `\\b${season}&#215;${episodePadded}\\s*(.*?)(?=<br\\s*/?>)`,
    'gis'
  );
  const matches = [...description.matchAll(re)];
  if (!matches.length) return [];

  const allStreams = [];
  for (let t = 0; t < matches.length; t++) {
    const matchText = matches[t][1] || '';
    // Split after the first " – " to get only the host links part
    const parts = matchText.split(/\s*[–\-]\s*/u);
    const atag = parts.length > 1 ? parts.slice(1).join(' – ') : matchText;
    if (!atag.includes('href')) continue;

    const language = t === 0 ? '\nITA' : '\nSUB-ITA';
    const streams = await scrapingLinks(atag, language, 'Eurostreaming');
    allStreams.push(...streams);
  }
  return allStreams;
}

/**
 * Search Eurostreaming WP REST API for a title+year, find the episode, and return streams.
 */
async function searchAndExtract(showname, year, season, episode) {
  const baseUrl = getEsBaseUrl();
  const allStreams = [];

  try {
    const searchUrl = `${baseUrl}/wp-json/wp/v2/search?search=${encodeURIComponent(showname)}&_fields=id,subtype&per_page=10`;
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      redirect: 'follow',
    });
    if (!searchResp.ok) return [];
    const results = await searchResp.json();
    if (!Array.isArray(results) || !results.length) return [];
    // Use the final URL after redirect as the actual base (domain may redirect)
    const actualBase = new URL(searchResp.url).origin;

    for (const item of results) {
      // Skip pages/custom types — only standard posts have episode content
      if (item.subtype && item.subtype !== 'post') continue;
      try {
        const postUrl = `${actualBase}/wp-json/wp/v2/posts/${item.id}?_fields=content,title`;
        const postResp = await fetch(postUrl, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json' },
          redirect: 'follow',
        });
        if (!postResp.ok) continue;
        const postData = await postResp.json();
        if (!postData || postData.code === 'rest_post_invalid_id') continue;

        const rawTitle = postData?.title?.rendered || '';
        const description = postData?.content?.rendered || '';
        const postTitle = decodeHtmlEntities(rawTitle);

        // Title similarity check (>= 0.96 means nearly exact)
        const ratio = titleRatio(postTitle, showname);
        let matched = ratio >= 0.96;

        if (!matched && year) {
          // Fallback: year match within ±1
          const yearMatch = /(?<![\/\-])(19|20)\d{2}(?![\/\-])/.exec(description);
          if (yearMatch) {
            const diff = Math.abs(parseInt(yearMatch[0], 10) - parseInt(year, 10));
            matched = diff <= 1;
          }

          // If not in excerpt, try full post if "Continua a leggere" link exists
          if (!matched) {
            const moreMatch = /<a\s+href="([^"]+)"[^>]*>Continua a leggere<\/a>/i.exec(description);
            if (moreMatch) {
              try {
                const fullResp = await fetch(moreMatch[1], { headers: { 'User-Agent': UA } });
                const fullHtml = await fullResp.text();
                const fullYearMatch = /(?<![\/\-])(19|20)\d{2}(?![\/\-])/.exec(fullHtml);
                if (fullYearMatch) {
                  const diff = Math.abs(parseInt(fullYearMatch[0], 10) - parseInt(year, 10));
                  matched = diff <= 1;
                }
              } catch { /* skip */ }
            }
          }
        }

        if (!matched) continue;

        const streams = await findEpisodeStreams(description, season, episode);
        allStreams.push(...streams);

        if (allStreams.length > 0) break; // Found a match — stop searching
      } catch { /* skip this result */ }
    }
  } catch { /* search failed */ }

  return allStreams;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main provider entry point, compatible with StreamFusionMail's provider pattern.
 *
 * @param {string} id             Raw Stremio ID (tmdb:..., tt..., kitsu:...)
 * @param {string} type           'series' | 'movie' | 'anime'
 * @param {number} season         Season number
 * @param {number} episode        Episode number
 * @param {object} [providerContext]  Shared context with tmdbId, imdbId, primaryTitle, titleCandidates
 * @returns {Promise<Array>}      Array of stream objects
 */
async function getStreams(id, type, season, episode, providerContext = null) {
  try {
    // Eurostreaming is series-only
    if (String(type || '').toLowerCase() === 'movie') return [];

    const effectiveSeason = Number.isInteger(season) && season > 0 ? season : 1;
    const effectiveEpisode = Number.isInteger(episode) && episode > 0 ? episode : 1;

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
      tmdbId = String((await getTmdbIdFromImdb(contextImdbId)) || '') || null;
    }
    if (!tmdbId && String(id).startsWith('tmdb:')) {
      tmdbId = String(id).replace('tmdb:', '').split(':')[0];
    }

    // Fetch title + year from TMDB
    if (tmdbId) {
      const info = await getTitleAndYear(tmdbId, 'tv');
      if (info) {
        showname = info.title;
        year = info.year;
      }
    }

    // Fallback to context title candidates
    if (!showname && providerContext) {
      showname = String(providerContext.primaryTitle || '').trim();
      if (!showname && Array.isArray(providerContext.titleCandidates)) {
        showname = String(providerContext.titleCandidates[0] || '').trim();
      }
    }

    if (!showname) {
      console.warn('[Eurostreaming] Cannot resolve title for', id);
      return [];
    }

    console.log(`[Eurostreaming] Searching: "${showname}" (${year}) S${effectiveSeason}E${effectiveEpisode}`);

    // Try all title candidates to maximise chances
    const candidates = [showname];
    if (providerContext && Array.isArray(providerContext.titleCandidates)) {
      for (const tc of providerContext.titleCandidates) {
        const t = String(tc || '').trim();
        if (t && t !== showname) candidates.push(t);
      }
    }

    for (const title of candidates) {
      const streams = await searchAndExtract(title, year, effectiveSeason, effectiveEpisode);
      if (streams.length) {
        console.log(`[Eurostreaming] Found ${streams.length} stream(s) for "${title}"`);
        return streams;
      }
    }

    console.log('[Eurostreaming] No streams found for', showname);
    return [];
  } catch (err) {
    console.error('[Eurostreaming] Error:', err.message);
    return [];
  }
}

module.exports = { getStreams };
