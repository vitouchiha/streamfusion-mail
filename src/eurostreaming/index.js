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
const { formatStream } = require('../formatter.js');
const { fetchWithCloudscraper } = require('../utils/fetcher.js');

const TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function getEsBaseUrl() {
  return (getProviderUrl('eurostreaming') || 'https://eurostreamings.life').replace(/\/+$/, '');
}

// ─── CF Worker bypass ───────────────────────────────────────────────────────

/**
 * Fetch a URL with Cloudflare bypass (cloudscraper → CF Worker → direct).
 * Needed because eurostream.ing has Cloudflare protection that blocks Vercel IPs.
 * @param {string} url  Target URL
 * @param {object} [opts]  { timeout }
 * @returns {Promise<{ok:boolean, url:string, text:()=>Promise<string>, json:()=>Promise<any>}|null>}
 */
async function _esFetch(url, opts = {}) {
  const timeout = opts.timeout || 10000;

  // 1. Try CF Worker first (fastest and most reliable on Vercel)
  const cfBase = (process.env.CF_WORKER_URL || '').trim();
  if (cfBase) {
    try {
      const workerUrl = new URL(cfBase.replace(/\/$/, ''));
      workerUrl.searchParams.set('url', url);
      const headers = { 'User-Agent': UA, 'Accept': opts.accept || 'application/json,text/html,*/*' };
      const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();
      if (cfAuth) headers['x-worker-auth'] = cfAuth;
      const resp = await fetch(workerUrl.toString(), { headers, signal: AbortSignal.timeout(timeout) });
      const body = await resp.text();
      if (resp.ok && !body.includes('Just a moment')) {
        return {
          ok: true, status: resp.status, url: url,
          text: async () => body,
          json: async () => JSON.parse(body),
        };
      }
    } catch (e) {
      console.log(`[Eurostreaming] CF Worker fetch failed: ${e.message}`);
    }
  }

  // 2. Try cloudscraper (handles CF JS challenges — useful locally)
  try {
    const body = await fetchWithCloudscraper(url, {
      retries: 1,
      timeout,
      referer: getEsBaseUrl() + '/',
    });
    if (body && !body.includes('Just a moment')) {
      return {
        ok: true, status: 200, url: url,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    }
  } catch (e) {
    console.log(`[Eurostreaming] cloudscraper failed: ${e.message}`);
  }

  // 3. Direct fallback (works locally)
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': opts.accept || 'application/json,text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return null;
    const body = await resp.text();
    if (body.includes('Just a moment')) return null;
    return {
      ok: true, status: resp.status, url: resp.url,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  } catch {
    return null;
  }
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
 * Follow a single redirect via CF Worker (nofollow mode → returns Location header).
 * Falls back to direct fetch if CF Worker not configured.
 */
async function _followOneRedirect(url) {
  // Try CF Worker with nofollow
  const cfBase = (process.env.CF_WORKER_URL || '').trim();
  if (cfBase) {
    try {
      const workerUrl = new URL(cfBase.replace(/\/$/, ''));
      workerUrl.searchParams.set('url', url);
      workerUrl.searchParams.set('nofollow', '1');
      const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();
      const headers = { 'User-Agent': UA };
      if (cfAuth) headers['x-worker-auth'] = cfAuth;
      const resp = await fetch(workerUrl.toString(), { headers, signal: AbortSignal.timeout(8000) });
      const data = await resp.json().catch(() => null);
      if (data && data.location) return data.location;
    } catch { /* fall through */ }
  }
  // Direct fallback
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Range': 'bytes=0-0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });
    if (resp.status === 200 || resp.status === 206) return null;
    return resp.headers.get('location') || null;
  } catch {
    return null;
  }
}

/**
 * Follow a redirect chain (up to 6 hops) to resolve the final URL.
 * Uses CF Worker for Cloudflare-protected domains (clicka.cc, safego.cc).
 */
async function followRedirectChain(url, maxHops = 6) {
  let current = String(url || '').trim();
  for (let i = 0; i < maxHops; i++) {
    const location = await _followOneRedirect(current);
    if (!location) break;
    current = new URL(location, current).href;
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
async function scrapingLinks(atag, language, siteName, providerContext = null) {
  const streams = [];
  const langEmoji = language.includes('SUB') ? '🇰🇷' : '🇮🇹';

  function makeStream(playerName, url, headers) {
    return formatStream({
      url: url,
      headers: headers || undefined,
      name: `Eurostreaming - ${playerName}`,
      title: providerContext?._displayName || siteName,
      quality: 'HD',
      language: langEmoji,
      type: 'direct',
      addonBaseUrl: providerContext?.addonBaseUrl,
      behaviorHints: headers ? { proxyHeaders: { request: headers } } : undefined,
    }, 'Eurostreaming');
  }

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
          const result = await extractMixDrop(resolved, undefined, providerContext);
          if (result) streams.push(makeStream('MixDrop', result.url, result.headers));
        }
      }
    } catch { /* skip */ }
  }

  if (hasDeltaBit) {
    try {
      const href = extractHref('DeltaBit');
      if (href) {
        // When CF Worker is configured, return a Worker redirect URL.
        // Stremio calls this URL directly → Worker runs at player's edge (not Vercel's)
        // → resolves clicka→safego→captcha→deltabit→video.
        const cfBase = (process.env.CF_WORKER_URL || '').trim();
        const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();
        if (cfBase && href.includes('clicka.cc/delta')) {
          const workerUrl = new URL(cfBase.replace(/\/$/, ''));
          workerUrl.searchParams.set('es_stream', '1');
          workerUrl.searchParams.set('url', href);
          if (cfAuth) workerUrl.searchParams.set('auth', cfAuth);
          streams.push(makeStream('DeltaBit', workerUrl.toString()));
        } else {
          // Fallback: resolve and extract locally (works when sites aren't blocked)
          const resolved = await resolveHostLink(href);
          if (resolved) {
            const result = await extractTurbovidda(resolved);
            if (result) streams.push(makeStream('DeltaBit', result.url));
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
            const result = await extractMixDrop(resolved, undefined, providerContext);
            if (result) streams.push(makeStream('MixDrop', result.url, result.headers));
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
        if (result) streams.push(makeStream('MaxStream', result.url));
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
          if (result) streams.push(makeStream('Turbovid', result.url));
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
async function findEpisodeStreams(description, season, episode, providerContext = null) {
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
    const streams = await scrapingLinks(atag, language, 'Eurostreaming', providerContext);
    allStreams.push(...streams);
  }
  return allStreams;
}

/**
 * Search Eurostreaming WP REST API for a title+year, find the episode, and return streams.
 */
async function searchAndExtract(showname, year, season, episode, providerContext = null) {
  const baseUrl = getEsBaseUrl();
  const allStreams = [];

  try {
    const searchUrl = `${baseUrl}/wp-json/wp/v2/search?search=${encodeURIComponent(showname)}&_fields=id,subtype&per_page=10`;
    const searchResp = await _esFetch(searchUrl);
    if (!searchResp) return [];
    const results = await searchResp.json();
    if (!Array.isArray(results) || !results.length) return [];
    // Use the final URL after redirect as the actual base (domain may redirect)
    const actualBase = new URL(searchResp.url).origin;

    for (const item of results) {
      // Skip pages/custom types — only standard posts have episode content
      if (item.subtype && item.subtype !== 'post') continue;
      try {
        const postUrl = `${actualBase}/wp-json/wp/v2/posts/${item.id}?_fields=content,title`;
        const postResp = await _esFetch(postUrl);
        if (!postResp) continue;
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
                const fullResp = await _esFetch(moreMatch[1], { accept: 'text/html,*/*' });
                const fullHtml = fullResp ? await fullResp.text() : '';
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

        const streams = await findEpisodeStreams(description, season, episode, providerContext);
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

    // Build display name for the formatter (e.g. "Snowpiercer 4x1")
    const displayName = `${showname} ${effectiveSeason}x${effectiveEpisode}`;
    const enrichedContext = { ...providerContext, _displayName: displayName };

    // Try all title candidates to maximise chances
    const candidates = [showname];
    if (providerContext && Array.isArray(providerContext.titleCandidates)) {
      for (const tc of providerContext.titleCandidates) {
        const t = String(tc || '').trim();
        if (t && t !== showname) candidates.push(t);
      }
    }

    for (const title of candidates) {
      const streams = await searchAndExtract(title, year, effectiveSeason, effectiveEpisode, enrichedContext);
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
