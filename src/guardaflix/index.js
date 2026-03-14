'use strict';

const { getProviderUrl } = require('../provider_urls.js');
const { extractFromUrl } = require('../extractors');
const { formatStream } = require('../formatter.js');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const { TMDB_API_KEY } = require('../utils/config');

// WordPress nonce for admin-ajax search action (long-lived on this site)
const SEARCH_NONCE = '20115729b4';

function getBaseUrl() {
  return getProviderUrl('guardaflix') || 'https://guardaplay.space';
}

async function getTitleAndYear(id, type) {
  try {
    let tmdbId = id;
    const normalizedType = String(type || '').toLowerCase();
    const endpoint = normalizedType === 'movie' ? 'movie' : 'tv';

    if (String(id).startsWith('tt')) {
      // Convert IMDB → TMDB
      const findResp = await fetch(
        `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
        { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(5000) }
      );
      if (!findResp.ok) return null;
      const findData = await findResp.json();
      const results = normalizedType === 'movie' ? findData.movie_results : findData.tv_results;
      if (!results || results.length === 0) return null;
      return {
        title: results[0].title || results[0].name || results[0].original_title,
        year: String(results[0].release_date || results[0].first_air_date || '').slice(0, 4),
      };
    }

    // TMDB numeric or tmdb: prefix
    const numericId = String(tmdbId).replace(/^tmdb:/i, '');
    const resp = await fetch(
      `https://api.themoviedb.org/3/${endpoint}/${numericId}?api_key=${TMDB_API_KEY}&language=it-IT`,
      { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      title: data.title || data.name || data.original_title || data.original_name,
      year: String(data.release_date || data.first_air_date || '').slice(0, 4),
    };
  } catch {
    return null;
  }
}

async function searchMovies(title) {
  const base = getBaseUrl();
  try {
    const resp = await fetch(`${base}/wp-admin/admin-ajax.php`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${base}/`,
        'Origin': base,
      },
      body: `action=action_tr_search_suggest&nonce=${SEARCH_NONCE}&term=${encodeURIComponent(title)}`,
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    // Parse <a href="...">Title</a> — only movie entries
    const links = [];
    const regex = /class="type-movies"[^<]*<\/span>([^<]+)<\/a>/g;
    const hrefRegex = /<a\s+href="([^"]+)"/g;
    // Parse blocks: <li class="..."><a href="URL"><span class="type-movies">...</span>TITLE</a></li>
    const blockRegex = /<li[^>]*>\s*<a\s+href="([^"]+)"[^>]*>\s*<span[^>]*class="type-movies"[^>]*>[^<]*<\/span>([^<]+)<\/a>/gi;
    let m;
    while ((m = blockRegex.exec(html)) !== null) {
      links.push({ href: m[1].trim(), text: m[2].trim() });
    }
    return links;
  } catch (e) {
    console.error('[Guardaflix] Search error:', e.message);
    return [];
  }
}

async function getEmbedUrl(pageUrl) {
  try {
    const resp = await fetch(pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': getBaseUrl() + '/',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Check year from the page (span with class containing 'year')
    const yearMatch = html.match(/<span[^>]*class="[^"]*year[^"]*"[^>]*>(\d{4})/i)
      || html.match(/<span[^>]*fa-calendar[^>]*>(\d{4})/i);
    const pageYear = yearMatch ? yearMatch[1] : null;

    // Get iframe with data-src pointing to trembed
    const iframeMatch = html.match(/data-src="([^"]*trembed[^"]*)"/i)
      || html.match(/src="([^"]*trembed[^"]*)"/i);
    if (!iframeMatch) return null;
    const embedUrl = iframeMatch[1].replace(/&#038;/g, '&');
    return { embedUrl, year: pageYear };
  } catch {
    return null;
  }
}

async function getPlayerUrl(embedUrl) {
  try {
    const resp = await fetch(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': getBaseUrl() + '/',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Find iframe or data-src with actual video player URL
    const m = html.match(/<iframe[^>]+src="([^"]+)"/i)
      || html.match(/data-src="([^"]+)"/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function getStreams(id, type, season, episode, providerContext = null) {
  // Guardaflix only has movies
  const normalizedType = String(type || '').toLowerCase();
  if (normalizedType !== 'movie') return [];

  try {
    const meta = await getTitleAndYear(id, type);
    if (!meta || !meta.title) {
      console.warn('[Guardaflix] Could not resolve title for', id);
      return [];
    }

    const { title, year } = meta;
    console.log(`[Guardaflix] Searching for: "${title}" (${year})`);

    const results = await searchMovies(title);
    if (results.length === 0) {
      console.log('[Guardaflix] No search results for:', title);
      return [];
    }

    const streams = [];

    for (const result of results.slice(0, 5)) {
      try {
        const pageData = await getEmbedUrl(result.href);
        if (!pageData) continue;

        const { embedUrl, year: pageYear } = pageData;

        // Year check: if both years are known and differ, skip
        if (year && pageYear && year !== pageYear) {
          console.log(`[Guardaflix] Year mismatch: expected ${year}, got ${pageYear} for ${result.href}`);
          continue;
        }

        const playerUrl = await getPlayerUrl(embedUrl);
        if (!playerUrl) continue;

        console.log(`[Guardaflix] Player URL: ${playerUrl}`);

        const extracted = await extractFromUrl(playerUrl, {
          refererBase: getBaseUrl(),
          proxyUrl: providerContext?.proxyUrl,
          loadmReferer: getBaseUrl(),
        });

        if (extracted.length === 0) continue;

        for (const s of extracted) {
          streams.push(formatStream({
            name: `Guardaflix - ${s.name || 'Player'}`,
            title: title,
            url: s.url,
            headers: s.headers,
            quality: s.quality || 'HD',
            type: 'direct',
            addonBaseUrl: providerContext?.addonBaseUrl,
          }, 'Guardaflix'));
        }

        // Found a working player, stop searching
        if (streams.length > 0) break;
      } catch (e) {
        console.error('[Guardaflix] Error processing result:', e.message);
      }
    }

    return streams.filter(s => s !== null);
  } catch (e) {
    console.error('[Guardaflix] getStreams error:', e.message);
    return [];
  }
}

module.exports = { getStreams };
