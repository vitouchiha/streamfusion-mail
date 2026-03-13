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
 * Extracts ALL available players in parallel (MixDrop, DeltaBit, Turbovid, MaxStream, DL).
 *
 * @param {string} atag   Raw HTML snippet with <a> tags for this episode
 * @param {string} language  "\nITA" or "\nSUB-ITA"
 * @param {string} siteName  e.g. "Eurostreaming"
 * @returns {Promise<Array>}  Array of stream objects
 */
async function scrapingLinks(atag, language, siteName, providerContext = null) {
  const streams = [];
  const langEmoji = language.includes('SUB') ? '🇰🇷' : '🇮🇹';
  const cfBase = (process.env.CF_WORKER_URL || '').trim();
  const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();

  function makeStream(playerName, url, headers, opts = {}) {
    return formatStream({
      url: url,
      headers: headers || undefined,
      name: `Eurostreaming - ${playerName}`,
      title: providerContext?._displayName || siteName,
      quality: opts.quality || 'HD',
      language: langEmoji,
      type: 'direct',
      addonBaseUrl: opts.mfpHandled ? undefined : providerContext?.addonBaseUrl,
      mfpHandled: opts.mfpHandled || undefined,
      behaviorHints: headers ? { proxyHeaders: { request: headers } } : undefined,
    }, 'Eurostreaming');
  }

  // Helper: extract href for a named host from the atag
  function extractHref(hostName) {
    const re = new RegExp(`<a\\s[^>]*href="([^"]+)"[^>]*>\\s*${hostName}\\s*<\\/a>`, 'i');
    const m = re.exec(atag);
    return m ? m[1] : null;
  }

  /**
   * Resolve a clicka.cc URL via Worker es_resolve → returns final player URL.
   * Works for /mix/, /delta/, /tv/ — all go through safego captcha.
   */
  async function workerResolve(clickaUrl) {
    if (!cfBase) return null;
    try {
      const wu = new URL(cfBase.replace(/\/$/, ''));
      wu.searchParams.set('es_resolve', '1');
      wu.searchParams.set('url', clickaUrl);
      if (cfAuth) wu.searchParams.set('auth', cfAuth);
      const resp = await fetch(wu.toString(), {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.url || null;
    } catch { return null; }
  }

  const jobs = [];

  // ── MixDrop ────────────────────────────────────────────────────────────
  if (/MixDrop/i.test(atag)) {
    const href = extractHref('MixDrop');
    if (href) {
      jobs.push((async () => {
        try {
          let mixdropUrl = null;
          if (cfBase && href.includes('clicka.cc')) {
            mixdropUrl = await workerResolve(href);
          }
          if (!mixdropUrl) {
            mixdropUrl = await resolveHostLink(href);
          }
          if (mixdropUrl && (mixdropUrl.includes('mixdrop') || mixdropUrl.includes('m1xdrop'))) {
            const result = await extractMixDrop(mixdropUrl, undefined, providerContext);
            if (result) streams.push(makeStream('MixDrop', result.url, result.headers, { mfpHandled: result.mfpHandled }));
          }
        } catch { /* skip */ }
      })());
    }
  }

  // ── DeltaBit ───────────────────────────────────────────────────────────
  if (/DeltaBit/i.test(atag)) {
    const href = extractHref('DeltaBit');
    if (href) {
      jobs.push((async () => {
        try {
          if (cfBase && href.includes('clicka.cc')) {
            // Worker es_stream: resolves full chain + extracts video → 302 to MP4
            const workerUrl = new URL(cfBase.replace(/\/$/, ''));
            workerUrl.searchParams.set('es_stream', '1');
            workerUrl.searchParams.set('url', href);
            if (cfAuth) workerUrl.searchParams.set('auth', cfAuth);
            streams.push(makeStream('DeltaBit', workerUrl.toString(), null, { mfpHandled: true }));
          } else {
            const resolved = await resolveHostLink(href);
            if (resolved) {
              const result = await extractTurbovidda(resolved);
              if (result) streams.push(makeStream('DeltaBit', result.url));
            }
          }
        } catch { /* skip */ }
      })());
    }
  }

  // ── Turbovid ───────────────────────────────────────────────────────────
  if (/Turbovid/i.test(atag)) {
    const href = extractHref('Turbovid');
    if (href) {
      jobs.push((async () => {
        try {
          if (cfBase && href.includes('clicka.cc')) {
            // Resolve clicka → turbovid URL, then use es_stream for video extraction
            const workerUrl = new URL(cfBase.replace(/\/$/, ''));
            workerUrl.searchParams.set('es_stream', '1');
            workerUrl.searchParams.set('url', href);
            if (cfAuth) workerUrl.searchParams.set('auth', cfAuth);
            streams.push(makeStream('Turbovid', workerUrl.toString(), null, { mfpHandled: true }));
          } else {
            const resolved = await resolveHostLink(href);
            if (resolved) {
              const result = await extractTurbovidda(resolved);
              if (result) streams.push(makeStream('Turbovid', result.url));
            }
          }
        } catch { /* skip */ }
      })());
    }
  }

  // ── DL (download link via uprot.net/msd/) ──────────────────────────────
  // DL links go through uprot.net → MixDrop/download page — skip for now
  // (uprot.net requires captcha bypass which we don't support yet)

  // ── MaxStream (via uprot.net/msf/) ─────────────────────────────────────
  if (/MaxStream/i.test(atag)) {
    const href = extractHref('MaxStream');
    if (href) {
      jobs.push((async () => {
        try {
          const resolved = await resolveHostLink(href);
          const target = resolved || href;
          const result = await extractMaxStream(target);
          if (result) streams.push(makeStream('MaxStream', result.url));
        } catch { /* skip */ }
      })());
    }
  }

  await Promise.allSettled(jobs);
  return streams;
}

/**
 * Find episode matches in a Eurostreaming post HTML and extract streams.
 * Parses spoiler sections to correctly assign ITA vs SUB-ITA language,
 * then finds the episode row within the matching season section.
 */
async function findEpisodeStreams(description, season, episode, providerContext = null) {
  const episodePadded = String(episode).padStart(2, '0');
  const epPattern = `${season}&#215;${episodePadded}`;

  // Parse spoiler sections: each has a title (e.g. "PRIMA STAGIONE 1 ITA") and content
  const sectionRe = /su-spoiler-title[^>]*>(?:<[^>]*>)*\s*([^<]+)<\/(?:span|div)>[\s\S]*?su-spoiler-content[^"]*">([\s\S]*?)<\/div>\s*<\/div>/gi;
  const sections = [...description.matchAll(sectionRe)];

  // Map season number words to digits
  const SEASON_WORDS = {
    'prima': 1, 'seconda': 2, 'terza': 3, 'quarta': 4, 'quinta': 5,
    'sesta': 6, 'settima': 7, 'ottava': 8, 'nona': 9, 'decima': 10,
  };

  const allStreams = [];

  for (const sec of sections) {
    const sectionTitle = (sec[1] || '').trim().toUpperCase();
    const sectionContent = sec[2] || '';

    // Determine season number from section title
    let sectionSeason = null;
    // Try "STAGIONE N" pattern
    const numMatch = /STAGIONE\s+(\d+)/i.exec(sectionTitle);
    if (numMatch) sectionSeason = parseInt(numMatch[1], 10);
    // Try word pattern: "PRIMA STAGIONE", "SECONDA STAGIONE"
    if (!sectionSeason) {
      for (const [word, num] of Object.entries(SEASON_WORDS)) {
        if (sectionTitle.includes(word.toUpperCase())) { sectionSeason = num; break; }
      }
    }

    if (sectionSeason !== season) continue;

    // Determine language from section title
    const isSub = /SUB[\s\-]*ITA/i.test(sectionTitle);
    const language = isSub ? '\nSUB-ITA' : '\nITA';

    // Find the episode in this section
    const epRe = new RegExp(
      `\\b${epPattern}\\s*(.*?)(?=<br\\s*/?>|\\d+&#215;)`,
      'gis'
    );
    const matches = [...sectionContent.matchAll(epRe)];

    for (const m of matches) {
      const matchText = m[1] || '';
      const parts = matchText.split(/\s*[–\-]\s*/u);
      const atag = parts.length > 1 ? parts.slice(1).join(' – ') : matchText;
      if (!atag.includes('href')) continue;

      const streams = await scrapingLinks(atag, language, 'Eurostreaming', providerContext);
      allStreams.push(...streams);
    }
  }

  // Fallback: if no spoiler sections found, use the old flat regex approach
  if (sections.length === 0) {
    const re = new RegExp(
      `\\b${epPattern}\\s*(.*?)(?=<br\\s*/?>)`,
      'gis'
    );
    const matches = [...description.matchAll(re)];
    for (let t = 0; t < matches.length; t++) {
      const matchText = matches[t][1] || '';
      const parts = matchText.split(/\s*[–\-]\s*/u);
      const atag = parts.length > 1 ? parts.slice(1).join(' – ') : matchText;
      if (!atag.includes('href')) continue;
      const language = t === 0 ? '\nITA' : '\nSUB-ITA';
      const streams = await scrapingLinks(atag, language, 'Eurostreaming', providerContext);
      allStreams.push(...streams);
    }
  }

  return allStreams;
}

// ─── KV index-based search (bypasses live WP search API) ─────────────────────

// Load the static titles index (generated by warm-es-cache.js)
let _cachedTitlesIndex = null;
function _loadTitlesIndex() {
  if (_cachedTitlesIndex) return _cachedTitlesIndex;
  try {
    const path = require('path');
    const fs = require('fs');
    const indexPath = path.resolve(__dirname, '..', '..', 'es-titles-index.json');
    if (fs.existsSync(indexPath)) {
      _cachedTitlesIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      console.log(`[Eurostreaming] Loaded titles index: ${Object.keys(_cachedTitlesIndex).length} entries`);
    }
  } catch { /* file not available */ }
  return _cachedTitlesIndex;
}

/**
 * Try to find matching post IDs using the pre-cached titles index.
 * Checks: 1) static JSON file, 2) KV via Worker.
 * @param {string} showname  Title to search for
 * @returns {Promise<Array<{id:number, page:number}>|null>}  Array of matching entries, or null
 */
async function _searchViaKvIndex(showname) {
  // Try static file first (no network call)
  let index = _loadTitlesIndex();

  // Fallback to KV if no static file
  if (!index) {
    const cfBase = (process.env.CF_WORKER_URL || '').trim();
    if (!cfBase) return null;

    try {
      const wUrl = new URL(cfBase.replace(/\/$/, ''));
      wUrl.searchParams.set('es_titles', '1');
      const headers = { 'User-Agent': UA };
      const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();
      if (cfAuth) headers['x-worker-auth'] = cfAuth;

      const resp = await fetch(wUrl.toString(), { headers, signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      index = await resp.json();
      if (!index || typeof index !== 'object') return null;
    } catch (e) {
      console.log(`[Eurostreaming] KV index fetch failed: ${e.message}`);
      return null;
    }
  }

  // Match against index using titleRatio
  const results = [];
  const searchLower = String(showname || '').toLowerCase().trim();
  for (const [title, entries] of Object.entries(index)) {
    const ratio = titleRatio(title, searchLower);
    if (ratio >= 0.6) { // Lower threshold for initial candidate selection
      for (const entry of entries) {
        // entries can be {id, page} objects (new format) or plain numbers (old format)
        const id = typeof entry === 'object' ? entry.id : entry;
        const page = typeof entry === 'object' ? entry.page : null;
        results.push({ id, page, _ratio: ratio, _title: title });
      }
    }
  }

  // Sort by ratio descending, best matches first
  results.sort((a, b) => b._ratio - a._ratio);
  if (results.length === 0) return null;

  console.log(`[Eurostreaming] KV index: found ${results.length} candidate(s) for "${showname}"`);
  return results;
}

/**
 * Fetch a single post's data from the local batch cache files.
 * Falls back to Worker KV if local file not found.
 * @param {number} postId
 * @param {number} pageNum  The page number this post lives in
 * @returns {Promise<{title:{rendered:string}, content:{rendered:string}}|null>}
 */
async function _fetchPostFromKv(postId, pageNum) {
  if (!pageNum) return null;

  // Try local batch file first (deployed with Vercel)
  try {
    const path = require('path');
    const fs = require('fs');
    const zlib = require('zlib');
    const gzPath = path.resolve(__dirname, '..', '..', 'es-cache', `page-${pageNum}.json.gz`);
    if (fs.existsSync(gzPath)) {
      const batch = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)));
      const post = batch.find(p => p.id === postId);
      if (post) return post;
    }
    // Fallback: uncompressed
    const jsonPath = path.resolve(__dirname, '..', '..', 'es-cache', `page-${pageNum}.json`);
    if (fs.existsSync(jsonPath)) {
      const batch = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      const post = batch.find(p => p.id === postId);
      if (post) return post;
    }
  } catch { /* fall through to Worker */ }

  // Fallback: try Worker KV
  const cfBase = (process.env.CF_WORKER_URL || '').trim();
  if (!cfBase) return null;

  try {
    const wUrl = new URL(cfBase.replace(/\/$/, ''));
    wUrl.searchParams.set('es_post_data', String(postId));
    wUrl.searchParams.set('es_page', String(pageNum));
    const headers = { 'User-Agent': UA };
    const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();
    if (cfAuth) headers['x-worker-auth'] = cfAuth;

    const resp = await fetch(wUrl.toString(), { headers, signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Search Eurostreaming WP REST API for a title+year, find the episode, and return streams.
 */
async function searchAndExtract(showname, year, season, episode, providerContext = null) {
  const baseUrl = getEsBaseUrl();
  const allStreams = [];

  // ── Phase 1: Try KV index (works even when CF blocks live API) ──────────
  try {
    const kvResults = await _searchViaKvIndex(showname);
    if (kvResults && kvResults.length > 0) {
      for (const item of kvResults) {
        try {
          const postData = await _fetchPostFromKv(item.id, item.page);
          if (!postData) continue;

          const rawTitle = postData?.title?.rendered || '';
          const description = postData?.content?.rendered || '';
          const postTitle = decodeHtmlEntities(rawTitle);

          const ratio = titleRatio(postTitle, showname);
          let matched = ratio >= 0.96;

          if (!matched && year) {
            const yearMatch = /(?<![\/\-])(19|20)\d{2}(?![\/\-])/.exec(description);
            if (yearMatch) {
              const diff = Math.abs(parseInt(yearMatch[0], 10) - parseInt(year, 10));
              matched = diff <= 1;
            }
          }

          if (!matched) continue;

          const streams = await findEpisodeStreams(description, season, episode, providerContext);
          allStreams.push(...streams);
          if (allStreams.length > 0) break;
        } catch { /* skip this result */ }
      }
      if (allStreams.length > 0) return allStreams;
      console.log('[Eurostreaming] KV index: no streams found, trying live API');
    }
  } catch (e) {
    console.log(`[Eurostreaming] KV index path failed: ${e.message}`);
  }

  // ── Phase 2: Fall back to live WP search API ───────────────────────────
  try {
    const searchUrl = `${baseUrl}/wp-json/wp/v2/search?search=${encodeURIComponent(showname)}&_fields=id,subtype&per_page=10`;
    const searchResp = await _esFetch(searchUrl);
    if (!searchResp) return allStreams;
    const results = await searchResp.json();
    if (!Array.isArray(results) || !results.length) return allStreams;
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
