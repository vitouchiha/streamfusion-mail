"use strict";

/**
 * Internal Anime Mapping Module
 * Replaces external dependency on animemapping.stremio.dpdns.org
 *
 * Provides:
 *   resolve(provider, externalId, options) → mapping payload
 *
 * Supports providers: "kitsu", "tmdb", "imdb", "mal", "anilist", "tvdb", "anidb"
 * Uses: Kitsu API, TMDB API, Fribb offline list, provider site search
 */

const { createTimeoutSignal } = require("../fetch_helper.js");
const { getProviderUrl } = require("../provider_urls.js");
const cloudscraper = require("cloudscraper");
const animeList = require("./anime_list.js");

const TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// ─── Cache ────────────────────────────────────────────────────────────────────
const CACHE_TTL = 10 * 60 * 1000; // 10 min
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { cache.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cache) { if (v.expiresAt <= now) cache.delete(k); }
  }
  return value;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function fetchJson(url, timeoutMs = 8000) {
  const tc = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, { signal: tc.signal, headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { if (typeof tc.cleanup === "function") tc.cleanup(); }
}

async function fetchHtml(url, timeoutMs = 8000) {
  const tc = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, { signal: tc.signal, headers: { "User-Agent": UA } });
    if (!res.ok) return "";
    return await res.text();
  } catch { return ""; }
  finally { if (typeof tc.cleanup === "function") tc.cleanup(); }
}

// ─── Kitsu API ────────────────────────────────────────────────────────────────

async function fetchKitsuAnime(kitsuId) {
  const key = `kitsu:anime:${kitsuId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const data = await fetchJson(`https://kitsu.io/api/edge/anime/${kitsuId}`);
  if (!data?.data?.attributes) return cacheSet(key, null);

  const attr = data.data.attributes;
  const result = {
    id: String(kitsuId),
    slug: attr.slug || "",
    subtype: (attr.subtype || "TV").toUpperCase(),
    status: attr.status || "unknown",
    canonicalTitle: attr.canonicalTitle || "",
    titles: {
      ...(attr.titles?.en ? { en: attr.titles.en } : {}),
      ...(attr.titles?.en_jp ? { en_jp: attr.titles.en_jp } : {}),
      ...(attr.titles?.en_us ? { en_us: attr.titles.en_us } : {}),
      ...(attr.titles?.ja_jp ? { ja_jp: attr.titles.ja_jp } : {}),
    },
    startDate: attr.startDate || null,
    endDate: attr.endDate || null,
    episodeCount: attr.episodeCount || null,
  };
  return cacheSet(key, result);
}

async function fetchKitsuMappings(kitsuId) {
  const key = `kitsu:mappings:${kitsuId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // 1) Try offline list first (instant, no API call)
  await animeList.ensureLoaded();
  const offlineEntry = animeList.findByKitsu(kitsuId);
  if (offlineEntry) {
    const ids = {};
    if (offlineEntry.mal_id) ids.mal = String(offlineEntry.mal_id);
    if (offlineEntry.anilist_id) ids.anilist = String(offlineEntry.anilist_id);
    if (offlineEntry.tvdb_id) ids.tvdb = String(offlineEntry.tvdb_id);
    if (offlineEntry.imdb_id) ids.imdb = offlineEntry.imdb_id;
    if (offlineEntry.anidb_id) ids.anidb = String(offlineEntry.anidb_id);
    if (offlineEntry.themoviedb_id) ids.tmdb = String(offlineEntry.themoviedb_id);
    return cacheSet(key, ids, 30 * 60 * 1000); // cache 30 min for offline data
  }

  // 2) Fallback: Kitsu API
  const data = await fetchJson(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`);
  if (!data?.data || !Array.isArray(data.data)) return cacheSet(key, {});

  const ids = {};
  for (const m of data.data) {
    const site = String(m?.attributes?.externalSite || "").toLowerCase();
    const extId = String(m?.attributes?.externalId || "").trim();
    if (!extId) continue;

    if (site.includes("myanimelist")) ids.mal = extId;
    else if (site.includes("anilist")) ids.anilist = extId;
    else if (site === "thetvdb" || site === "thetvdb/series") ids.tvdb = extId;
    else if (site.includes("imdb")) ids.imdb = extId;
    else if (site.includes("anidb")) ids.anidb = extId;
    else if (site.includes("thetvdb")) ids.tvdb = ids.tvdb || extId;
  }
  return cacheSet(key, ids);
}

// ─── Reverse lookups: TMDB/IMDB → Kitsu ──────────────────────────────────────

async function findKitsuIdByExternalId(externalSite, externalId) {
  const key = `reverse:${externalSite}:${externalId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // 1) Try offline list first (instant)
  await animeList.ensureLoaded();
  let offlineEntry = null;
  if (externalSite === "imdb") offlineEntry = animeList.findByImdb(externalId);
  else if (externalSite === "tvdb") offlineEntry = animeList.findByTvdb(Number(externalId));
  else if (externalSite === "tmdb") offlineEntry = animeList.findByTmdb(Number(externalId));
  else if (externalSite === "mal") offlineEntry = animeList.findByMal(Number(externalId));
  else if (externalSite === "anilist") offlineEntry = animeList.findByAnilist(Number(externalId));
  else if (externalSite === "anidb") offlineEntry = animeList.findByAnidb(Number(externalId));
  if (offlineEntry?.kitsu_id) return cacheSet(key, String(offlineEntry.kitsu_id), 30 * 60 * 1000);

  // 2) Fallback: Kitsu mappings filter API
  const sites = [];
  if (externalSite === "imdb") {
    sites.push("imdb/series", "imdb/movie", "imdb");
  } else if (externalSite === "tmdb") {
    // TMDB isn't directly in Kitsu mappings; we use TMDB API to get IMDB/TVDB first
    return cacheSet(key, null);
  } else if (externalSite === "tvdb") {
    sites.push("thetvdb/series", "thetvdb", "thetvdb/movie");
  }

  for (const site of sites) {
    const url = `https://kitsu.io/api/edge/mappings?filter[externalSite]=${encodeURIComponent(site)}&filter[externalId]=${encodeURIComponent(externalId)}&include=item&fields[anime]=id`;
    const data = await fetchJson(url, 10000);
    if (data?.included && Array.isArray(data.included)) {
      for (const item of data.included) {
        if (item?.type === "anime" && item?.id) {
          return cacheSet(key, String(item.id));
        }
      }
    }
    // Also try via relationship link
    if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
      const itemLink = data.data[0]?.relationships?.item?.links?.related;
      if (itemLink) {
        const itemData = await fetchJson(itemLink, 8000);
        if (itemData?.data?.id && itemData?.data?.type === "anime") {
          return cacheSet(key, String(itemData.data.id));
        }
      }
    }
  }
  return cacheSet(key, null);
}

async function resolveKitsuIdFromTmdb(tmdbId) {
  const key = `reverse:tmdb:${tmdbId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // 1) Try offline list first
  await animeList.ensureLoaded();
  const offlineEntry = animeList.findByTmdb(Number(tmdbId));
  if (offlineEntry?.kitsu_id) return cacheSet(key, String(offlineEntry.kitsu_id), 30 * 60 * 1000);

  // 2) Fallback: get IMDB/TVDB from TMDB, then look up Kitsu
  const tmdbData = await fetchJson(
    `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
  );

  if (tmdbData) {
    // Try TVDB first (more reliable - Kitsu stores thetvdb/series mappings)
    if (tmdbData.tvdb_id) {
      const kitsuId = await findKitsuIdByExternalId("tvdb", String(tmdbData.tvdb_id));
      if (kitsuId) return cacheSet(key, kitsuId);
    }
    if (tmdbData.imdb_id) {
      const kitsuId = await findKitsuIdByExternalId("imdb", tmdbData.imdb_id);
      if (kitsuId) return cacheSet(key, kitsuId);
    }
  }

  // Also try movie external IDs
  const movieData = await fetchJson(
    `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
  );
  if (movieData?.imdb_id) {
    const kitsuId = await findKitsuIdByExternalId("imdb", movieData.imdb_id);
    if (kitsuId) return cacheSet(key, kitsuId);
  }

  // Fallback: search Kitsu by TMDB title
  const kitsuIdByTitle = await searchKitsuByTmdbTitle(tmdbId);
  if (kitsuIdByTitle) return cacheSet(key, kitsuIdByTitle);

  return cacheSet(key, null);
}

// ─── Kitsu title search (fallback when external ID mappings don't exist) ──────

async function searchKitsuByTmdbTitle(tmdbId) {
  const key = `kitsu:title_search:tmdb:${tmdbId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // Get title from TMDB
  const tvData = await fetchJson(
    `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`
  );
  const movieData = !tvData?.name ? await fetchJson(
    `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
  ) : null;

  const titles = new Set();
  if (tvData?.name) titles.add(tvData.name);
  if (tvData?.original_name) titles.add(tvData.original_name);
  if (movieData?.title) titles.add(movieData.title);
  if (movieData?.original_title) titles.add(movieData.original_title);
  if (titles.size === 0) return cacheSet(key, null);

  for (const title of titles) {
    const searchUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&fields[anime]=id,canonicalTitle,titles,slug,subtype&page[limit]=5`;
    const result = await fetchJson(searchUrl, 8000);
    if (!result?.data?.length) continue;

    // Match by title similarity
    const normalizedSearch = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
    for (const anime of result.data) {
      const attrs = anime.attributes || {};
      const candidateTitles = [
        attrs.canonicalTitle,
        attrs.titles?.en, attrs.titles?.en_jp, attrs.titles?.ja_jp,
        attrs.slug?.replace(/-/g, " ")
      ].filter(Boolean).map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, ""));

      for (const cand of candidateTitles) {
        if (cand === normalizedSearch || cand.includes(normalizedSearch) || normalizedSearch.includes(cand)) {
          return cacheSet(key, String(anime.id));
        }
      }
    }
  }
  return cacheSet(key, null);
}

// ─── TMDB helpers ─────────────────────────────────────────────────────────────

async function findTmdbIdFromExternal(externalId, source) {
  const key = `tmdb:find:${source}:${externalId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(externalId)}?api_key=${TMDB_API_KEY}&external_source=${source}`;
  const data = await fetchJson(url);
  if (!data) return cacheSet(key, null);

  const tvResult = data.tv_results?.[0];
  const movieResult = data.movie_results?.[0];
  const result = tvResult?.id || movieResult?.id || null;
  return cacheSet(key, result ? String(result) : null);
}

async function resolveTmdbEpisode(tmdbId, requestedEpisode, requestedSeason) {
  if (!tmdbId || !requestedEpisode) return null;

  const key = `tmdb:ep:${tmdbId}:s${requestedSeason}:e${requestedEpisode}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const season = Number.isInteger(requestedSeason) && requestedSeason >= 0
    ? requestedSeason
    : 1;

  // Try direct season/episode lookup
  const epData = await fetchJson(
    `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${requestedEpisode}?api_key=${TMDB_API_KEY}`
  );

  if (epData && epData.episode_number) {
    const result = {
      id: String(tmdbId),
      season: epData.season_number ?? season,
      episode: epData.episode_number,
      rawEpisodeNumber: requestedEpisode,
      absoluteEpisode: null,
      matchedBy: "season_episode",
      episodeUrl: `https://www.themoviedb.org/tv/${tmdbId}/season/${epData.season_number ?? season}/episode/${epData.episode_number}`,
    };
    return cacheSet(key, result);
  }

  // If direct lookup fails and season = 1, try mapping as absolute episode
  if (season <= 1) {
    const showData = await fetchJson(
      `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=seasons`
    );
    if (showData?.seasons) {
      const seasons = showData.seasons
        .filter(s => s.season_number > 0)
        .sort((a, b) => a.season_number - b.season_number);

      let total = 0;
      for (const s of seasons) {
        if (requestedEpisode <= total + s.episode_count) {
          const resolvedEp = requestedEpisode - total;
          const result = {
            id: String(tmdbId),
            season: s.season_number,
            episode: resolvedEp,
            rawEpisodeNumber: requestedEpisode,
            absoluteEpisode: requestedEpisode,
            matchedBy: "absolute_to_season",
            episodeUrl: `https://www.themoviedb.org/tv/${tmdbId}/season/${s.season_number}/episode/${resolvedEp}`,
          };
          return cacheSet(key, result);
        }
        total += s.episode_count;
      }
    }
  }

  // Fallback: just return what we have
  const fallback = {
    id: String(tmdbId),
    season,
    episode: requestedEpisode,
    rawEpisodeNumber: requestedEpisode,
    absoluteEpisode: null,
    matchedBy: "fallback",
    episodeUrl: `https://www.themoviedb.org/tv/${tmdbId}/season/${season}/episode/${requestedEpisode}`,
  };
  return cacheSet(key, fallback);
}

// ─── Kitsu episode airdate ────────────────────────────────────────────────────

async function fetchKitsuEpisodeAirdate(kitsuId, episodeNumber) {
  if (!kitsuId || !episodeNumber) return null;

  const key = `kitsu:airdate:${kitsuId}:${episodeNumber}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const url = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?filter[number]=${episodeNumber}&fields[episodes]=airdate`;
  const data = await fetchJson(url, 6000);
  const airdate = data?.data?.[0]?.attributes?.airdate || null;
  return cacheSet(key, airdate);
}

// ─── Provider path search ─────────────────────────────────────────────────────

function getProviderBase(providerKey) {
  try { return getProviderUrl(providerKey).replace(/\/+$/, ""); }
  catch { return ""; }
}

async function searchAnimeWorld(titles) {
  const base = getProviderBase("animeworld");
  if (!base) return [];

  const allPaths = new Set();
  for (const title of titles.slice(0, 3)) {
    if (!title) continue;
    const key = `aw:search:${title.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached !== undefined) { cached.forEach(p => allPaths.add(p)); continue; }

    const html = await fetchHtml(`${base}/search?keyword=${encodeURIComponent(title)}`);
    const allLinks = [];
    const regex = /href="(\/play\/[^"]+)"/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const p = m[1].split("?")[0];
      if (p && !allLinks.includes(p)) allLinks.push(p);
    }

    // Filter by title similarity: /play/slug.ID → extract slug part
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
    // Skip non-Latin titles that normalize to empty
    if (!normalizedTitle) { cacheSet(key, []); continue; }
    const paths = allLinks.filter(p => {
      // Extract slug from /play/SLUG.ID or /play/SLUG-subita.ID etc.
      const slug = p.replace(/^\/play\//, "").replace(/\.[^.]+$/, ""); // remove .ID suffix
      const normalizedSlug = slug.toLowerCase().replace(/[-_]+/g, "").replace(/[^a-z0-9]/g, "");
      if (normalizedSlug.includes(normalizedTitle) || normalizedTitle.includes(normalizedSlug)) return true;
      // Word-based matching
      const slugWords = slug.toLowerCase().split(/[-_]+/).filter(w => w.length > 2);
      const titleWords = title.toLowerCase().split(/[\s:,.-]+/).filter(w => w.length > 2);
      const matchingWords = titleWords.filter(tw => slugWords.some(sw => sw.includes(tw) || tw.includes(sw)));
      return matchingWords.length >= Math.max(1, Math.ceil(titleWords.length * 0.5));
    });

    cacheSet(key, paths);
    paths.forEach(p => allPaths.add(p));
    if (allPaths.size >= 10) break;
  }
  return [...allPaths].slice(0, 20);
}

async function searchAnimeSaturn(titles) {
  const base = getProviderBase("animesaturn");
  if (!base) return [];

  const allPaths = new Set();
  for (const title of titles.slice(0, 3)) {
    if (!title) continue;
    const key = `as:search:${title.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached !== undefined) { cached.forEach(p => allPaths.add(p)); continue; }

    const html = await fetchHtml(`${base}/animelist?search=${encodeURIComponent(title)}`);
    const paths = [];

    // AnimeSaturn search results are inside <div class="item-archivio"> blocks
    const resultBlockRegex = /class="[^"]*item-archivio[^"]*"[\s\S]*?<\/(?:div|li)>/gi;
    const blocks = html.match(resultBlockRegex);
    
    if (blocks && blocks.length > 0) {
      for (const block of blocks) {
        const linkMatch = block.match(/href="(?:https?:\/\/[^"]*)?\/anime\/([^"?#]+)"/i);
        if (linkMatch) {
          const slug = linkMatch[1];
          if (!slug.includes("${") && !slug.includes("{{")) {
            const path = `/anime/${slug}`;
            if (!paths.includes(path)) paths.push(path);
          }
        }
      }
    }
    
    // Fallback: extract from list-group-item blocks
    if (paths.length === 0) {
      const listBlockRegex = /class="[^"]*list-group-item[^"]*"[\s\S]*?<\/li>/gi;
      const listBlocks = html.match(listBlockRegex);
      if (listBlocks) {
        for (const block of listBlocks) {
          const linkMatch = block.match(/href="(?:https?:\/\/[^"]*)?\/anime\/([^"?#]+)"/i);
          if (linkMatch) {
            const slug = linkMatch[1];
            if (!slug.includes("${") && !slug.includes("{{")) {
              const path = `/anime/${slug}`;
              if (!paths.includes(path)) paths.push(path);
            }
          }
        }
      }
    }

    // Last fallback: regex with title filtering
    if (paths.length === 0) {
      const regex = /href="(?:https?:\/\/[^"]*)?\/anime\/([^"?#]+)"/gi;
      let m;
      const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!normalizedTitle) { cacheSet(key, []); continue; } // Skip non-Latin titles
      while ((m = regex.exec(html)) !== null) {
        const slug = m[1];
        if (slug.includes("${") || slug.includes("{{")) continue;
        // Check if slug matches the searched title (slug uses hyphens as separators)
        const normalizedSlug = slug.toLowerCase().replace(/[-_]+/g, "").replace(/[^a-z0-9]/g, "");
        // Accept if slug contains the normalized title or title contains the slug's main part
        const slugWords = slug.toLowerCase().replace(/[-_]+/g, " ").split(/\s+/).filter(w => w.length > 2);
        const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const matchingWords = titleWords.filter(tw => slugWords.some(sw => sw.includes(tw) || tw.includes(sw)));
        if (normalizedSlug.includes(normalizedTitle) || normalizedTitle.includes(normalizedSlug) || matchingWords.length >= Math.max(1, Math.ceil(titleWords.length * 0.5))) {
          const path = `/anime/${slug}`;
          if (!paths.includes(path)) paths.push(path);
        }
      }
    }

    cacheSet(key, paths);
    paths.forEach(p => allPaths.add(p));
    if (allPaths.size >= 10) break;
  }
  return [...allPaths].slice(0, 20);
}

// ─── AnimeUnity search (POST /archivio/get-animes) ───────────────────────────
let auSession = null;   // { csrf, cookies, expiresAt }
const AU_SESSION_TTL = 30 * 60 * 1000; // 30 min

async function getAnimeUnitySession(base) {
  if (auSession && auSession.expiresAt > Date.now()) return auSession;
  try {
    // Try direct fetch first (fast path for non-CF environments)
    let html = null;
    let rawCookies = [];
    try {
      const tc = createTimeoutSignal(8000);
      const res = await fetch(base, { signal: tc.signal, headers: { "User-Agent": UA } });
      if (typeof tc.cleanup === "function") tc.cleanup();
      if (res.ok) {
        const txt = await res.text();
        if (!txt.includes("Just a moment") || txt.length > 50000) {
          html = txt;
          rawCookies = res.headers.getSetCookie?.() || [];
        }
      }
    } catch { /* direct fetch failed, try cloudscraper */ }

    // Fallback: use cloudscraper to bypass CF challenge
    let csJar = null;
    if (!html) {
      console.log("[Mapping] AnimeUnity: direct fetch failed or CF-challenged, trying cloudscraper...");
      try {
        csJar = cloudscraper.jar();
        const csResp = await cloudscraper.get({
          uri: base,
          jar: csJar,
          headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7" },
          resolveWithFullResponse: true,
          timeout: 10000,
        });
        if (csResp.statusCode >= 200 && csResp.statusCode < 300) {
          html = csResp.body;
          const jarCookies = csJar.getCookieString(base);
          if (jarCookies) rawCookies = [jarCookies];
          console.log("[Mapping] AnimeUnity: cloudscraper succeeded, CSRF found:", !!html.match(/csrf-token/));
        }
      } catch (csErr) {
        console.log("[Mapping] AnimeUnity: cloudscraper also failed:", csErr.message);
      }
    }

    if (!html) return null;
    const csrf = (html.match(/name="csrf-token"\s+content="([^"]+)"/) || [])[1] || null;
    const cookies = rawCookies.length > 0
      ? rawCookies.map(c => c.split(";")[0]).join("; ")
      : "";
    if (!csrf || !cookies) return null;
    auSession = { csrf, cookies, jar: csJar, expiresAt: Date.now() + AU_SESSION_TTL };
    return auSession;
  } catch { return null; }
}

async function searchAnimeUnity(titles, anilistId) {
  const base = getProviderBase("animeunity");
  if (!base) return [];

  // Build cache key from inputs
  const cacheId = anilistId ? `au:anilist:${anilistId}` : `au:title:${(titles[0] || "").toLowerCase()}`;
  const cached = cacheGet(cacheId);
  if (cached !== undefined) return cached;

  const session = await getAnimeUnitySession(base);

  // Search using each title via POST /archivio/get-animes
  const allPaths = new Set();
  for (const title of titles.slice(0, 3)) {
    if (!title) continue;
    const key = `au:search:${title.toLowerCase()}`;
    const cachedPaths = cacheGet(key);
    if (cachedPaths !== undefined) { cachedPaths.forEach(p => allPaths.add(p)); continue; }

    try {
      let records = null;

      // Try direct fetch POST first (works locally / non-CF-blocked environments)
      if (session) {
        try {
          const tc = createTimeoutSignal(8000);
          const res = await fetch(`${base}/archivio/get-animes`, {
            method: "POST",
            signal: tc.signal,
            headers: {
              "User-Agent": UA,
              "Content-Type": "application/json",
              "X-Requested-With": "XMLHttpRequest",
              "X-CSRF-TOKEN": session.csrf,
              "Cookie": session.cookies,
              "Accept": "application/json",
            },
            body: JSON.stringify({ title }),
          });
          if (typeof tc.cleanup === "function") tc.cleanup();
          if (res.ok) {
            const json = await res.json();
            const raw = json.records || json.data || json || [];
            if (Array.isArray(raw) && raw.length > 0) records = raw;
          }
        } catch { /* direct POST failed */ }

        // Fallback: use cloudscraper POST with the shared cookie jar
        if (!records && session.jar) {
          try {
            const csResp = await cloudscraper.post({
              uri: `${base}/archivio/get-animes`,
              jar: session.jar,
              json: { title },
              headers: {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": session.csrf,
                "Accept": "application/json",
              },
              resolveWithFullResponse: true,
              timeout: 10000,
            });
            if (csResp.statusCode >= 200 && csResp.statusCode < 300) {
              const data = typeof csResp.body === "string" ? JSON.parse(csResp.body) : csResp.body;
              const raw = data.records || data.data || data || [];
              if (Array.isArray(raw) && raw.length > 0) records = raw;
            }
          } catch { /* cloudscraper POST also failed */ }
        }
      }

      // Fallback: CF Worker proxy (handles session+CSRF internally)
      if (!records) {
        try {
          const cfWorkerUrl = process.env.CF_WORKER_URL || "https://kisskh-proxy.vitobsfm.workers.dev";
          const cfAuth = process.env.CF_WORKER_AUTH || "PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3";
          const params = new URLSearchParams({
            url: `${base}/archivio/get-animes`,
            au_search: "1",
            title,
            auth: cfAuth,
          });
          if (anilistId) params.set("anilist_id", String(anilistId));
          const tc2 = createTimeoutSignal(15000);
          const workerResp = await fetch(`${cfWorkerUrl}?${params}`, {
            signal: tc2.signal,
            headers: { "User-Agent": UA },
          });
          if (typeof tc2.cleanup === "function") tc2.cleanup();
          if (workerResp.ok) {
            const workerData = await workerResp.json();
            if (Array.isArray(workerData.paths) && workerData.paths.length > 0) {
              console.log("[Mapping] AnimeUnity: CF Worker found", workerData.paths.length, "paths for", title);
              cacheSet(key, workerData.paths);
              workerData.paths.forEach(p => allPaths.add(p));
              continue;
            }
          }
        } catch (cfErr) {
          console.log("[Mapping] AnimeUnity: CF Worker fallback failed:", cfErr.message);
        }
      }

      if (!records || records.length === 0) { cacheSet(key, []); continue; }

      const paths = [];

      // If we have an AniList ID, match by ID first (most accurate)
      if (anilistId) {
        const match = records.find(r => r.anilist_id === Number(anilistId));
        if (match && match.id && match.slug) {
          paths.push(`/anime/${match.id}-${match.slug}`);
        }
      }

      // Also match by title similarity (always, even if anilist matched)
      const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
        if (normalizedTitle) {
          for (const r of records) {
            if (!r.id || !r.slug) continue;
            const candidates = [r.title, r.title_eng, r.title_it].filter(Boolean);
            for (const c of candidates) {
              const norm = c.toLowerCase().replace(/[^a-z0-9]+/g, "");
              if (norm.includes(normalizedTitle) || normalizedTitle.includes(norm)) {
                const path = `/anime/${r.id}-${r.slug}`;
                if (!paths.includes(path)) paths.push(path);
                break;
              }
            }
            if (paths.length >= 5) break;
          }
        }

      cacheSet(key, paths);
      paths.forEach(p => allPaths.add(p));
      if (allPaths.size >= 10) break;
    } catch {
      cacheSet(key, []);
    }
  }

  const result = [...allPaths].slice(0, 20);
  return cacheSet(cacheId, result);
}

// ─── Main resolution ──────────────────────────────────────────────────────────

// Season-specific Kitsu ID from Fribb offline list (different seasons = different Kitsu entries)
async function findSeasonSpecificKitsuId(imdbId, tvdbId, requestedSeason) {
  if (!Number.isInteger(requestedSeason) || requestedSeason < 1) return null;
  await animeList.ensureLoaded();
  if (imdbId) {
    const entry = animeList.findByImdbSeason(imdbId, requestedSeason);
    if (entry?.kitsu_id) return String(entry.kitsu_id);
  }
  if (tvdbId) {
    const entry = animeList.findByTvdbSeason(Number(tvdbId), requestedSeason);
    if (entry?.kitsu_id) return String(entry.kitsu_id);
  }
  return null;
}

// Filter provider paths by season: prefer season-specific paths (e.g. slug ending in "-2")
function filterPathsBySeason(paths, requestedSeason) {
  if (!Array.isArray(paths) || paths.length <= 1) return paths;
  if (!Number.isInteger(requestedSeason) || requestedSeason < 1) return paths;

  // Extract the "clean slug" from a provider path, stripping:
  //   AnimeUnity numeric prefix (/anime/4851-...),
  //   AnimeWorld hash suffix (.JvOQx),
  //   common language tags (-ita, -sub-ita, -ita-sub, etc.)
  function cleanSlug(p) {
    let slug = p.split('/').pop() || '';
    slug = slug.replace(/^\d+-/, '');          // AnimeUnity ID prefix
    slug = slug.replace(/\.[a-zA-Z0-9]{4,8}$/, ''); // AnimeWorld hash suffix
    slug = slug.replace(/-(ita|sub-ita|ita-sub|sub|eng|raw|jp|dub)$/i, ''); // language tag
    return slug.toLowerCase();
  }

  if (requestedSeason >= 2) {
    const num = String(requestedSeason);
    const seasonPaths = paths.filter(p => {
      const slug = cleanSlug(p);
      return slug.endsWith('-' + num) || slug.includes('-' + num + '-') ||
             new RegExp(`[-_](season-?${num}|s${num})$`, 'i').test(slug);
    });
    if (seasonPaths.length > 0) return seasonPaths;
  } else {
    // Season 1: exclude paths whose clean slug contains a trailing season number (2-20)
    const s1Paths = paths.filter(p => {
      const slug = cleanSlug(p);
      return !/-([2-9]|1\d|20)$/.test(slug) && !/[-_]season-?\d+$/i.test(slug);
    });
    if (s1Paths.length > 0) return s1Paths;
  }
  return paths;
}

async function resolveByKitsu(kitsuId, options = {}) {
  const id = String(kitsuId).replace(/^kitsu:/i, "").trim();
  if (!id || !/^\d+$/.test(id)) return { ok: false, error: "invalid_kitsu_id" };

  const cacheKey = `resolve:kitsu:${id}:ep${options.episode || ""}:s${options.season ?? ""}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // Parallel: Fetch Kitsu anime details + mappings
  const [kitsuAnime, externalIds] = await Promise.all([
    fetchKitsuAnime(id),
    fetchKitsuMappings(id),
  ]);

  if (!kitsuAnime) return cacheSet(cacheKey, { ok: false, error: "not_found" });

  // Season-specific override: if a season is requested and the Fribb list has
  // a different Kitsu entry for that season, re-resolve with the correct one.
  const requestedSeason = Number.isInteger(parseInt(String(options.season ?? ""), 10))
    ? parseInt(String(options.season), 10) : null;
  if (requestedSeason >= 1 && !options._seasonResolved) {
    const seasonKitsu = await findSeasonSpecificKitsuId(
      externalIds.imdb || null,
      externalIds.tvdb ? Number(externalIds.tvdb) : null,
      requestedSeason
    );
    if (seasonKitsu && seasonKitsu !== id) {
      return resolveByKitsu(seasonKitsu, { ...options, _seasonResolved: true });
    }
  }

  // Resolve TMDB ID — offline list now provides tmdb directly
  let tmdbId = externalIds.tmdb || null;
  let imdbId = externalIds.imdb || null;

  // Only hit TMDB API if offline list didn't have TMDB
  if (!tmdbId && externalIds.tvdb) {
    tmdbId = await findTmdbIdFromExternal(externalIds.tvdb, "tvdb_id");
  }
  if (!tmdbId && imdbId) {
    tmdbId = await findTmdbIdFromExternal(imdbId, "imdb_id");
  }

  // If still no TMDB, try title search
  if (!tmdbId) {
    tmdbId = await searchTmdbByTitles(kitsuAnime, externalIds);
  }

  // If we found TMDB but no IMDB, get IMDB from TMDB external IDs
  if (tmdbId && !imdbId) {
    const extIds = await fetchJson(
      `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );
    if (extIds?.imdb_id) imdbId = extIds.imdb_id;
  }

  const ids = {
    ...(externalIds.mal ? { mal: externalIds.mal } : {}),
    ...(externalIds.anilist ? { anilist: externalIds.anilist } : {}),
    ...(imdbId ? { imdb: imdbId } : {}),
    ...(tmdbId ? { tmdb: tmdbId } : {}),
    ...(externalIds.tvdb ? { tvdb: externalIds.tvdb } : {}),
    ...(externalIds.anidb ? { anidb: externalIds.anidb } : {}),
  };

  // Build episode data
  const requestedEpisode = parseInt(String(options.episode || ""), 10) || null;

  // Episode airdate
  let episodeAirdate = null;
  if (requestedEpisode) {
    episodeAirdate = await fetchKitsuEpisodeAirdate(id, requestedEpisode);
  }

  // TMDB episode mapping
  let tmdbEpisode = null;
  if (tmdbId && requestedEpisode) {
    tmdbEpisode = await resolveTmdbEpisode(tmdbId, requestedEpisode, requestedSeason);
  }

  // Provider path search (parallel)
  const searchTitles = buildSearchTitles(kitsuAnime);
  let [animeWorldPaths, animeSaturnPaths, animeUnityPaths] = await Promise.all([
    searchAnimeWorld(searchTitles),
    searchAnimeSaturn(searchTitles),
    searchAnimeUnity(searchTitles, externalIds.anilist),
  ]);

  // Filter paths by season to avoid S1 results when S2 is requested (and vice versa)
  if (requestedSeason >= 1) {
    animeWorldPaths = filterPathsBySeason(animeWorldPaths, requestedSeason);
    animeSaturnPaths = filterPathsBySeason(animeSaturnPaths, requestedSeason);
    animeUnityPaths = filterPathsBySeason(animeUnityPaths, requestedSeason);
  }

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    requested: {
      id: `kitsu:${id}`,
      numericId: id,
      ...(requestedEpisode ? { episode: requestedEpisode } : {}),
    },
    kitsu: {
      ...kitsuAnime,
      episode_airdate: episodeAirdate,
      ...(requestedEpisode ? { episode: requestedEpisode } : {}),
    },
    mappings: {
      ids,
      ...(animeWorldPaths.length > 0 ? { animeworld: animeWorldPaths } : {}),
      ...(animeSaturnPaths.length > 0 ? { animesaturn: animeSaturnPaths } : {}),
      ...(animeUnityPaths.length > 0 ? { animeunity: animeUnityPaths } : {}),
      ...(tmdbEpisode ? { tmdb_episode: tmdbEpisode } : {}),
    },
  };

  return cacheSet(cacheKey, payload);
}

async function searchTmdbByTitles(kitsuAnime, externalIds) {
  const titles = buildSearchTitles(kitsuAnime);
  const type = kitsuAnime.subtype === "MOVIE" ? "movie" : "tv";
  const year = kitsuAnime.startDate ? kitsuAnime.startDate.substring(0, 4) : null;

  for (const title of titles.slice(0, 4)) {
    if (!title) continue;

    let yearParam = "";
    if (year) {
      yearParam = type === "movie" ? `&primary_release_year=${year}` : `&first_air_date_year=${year}`;
    }

    // Try with year first
    let data = null;
    if (year) {
      data = await fetchJson(
        `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(title)}&api_key=${TMDB_API_KEY}${yearParam}`
      );
    }

    // Without year if no results
    if (!data?.results?.length) {
      data = await fetchJson(
        `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(title)}&api_key=${TMDB_API_KEY}`
      );
    }

    if (data?.results?.length > 0) {
      // Prefer year-matched result
      if (year) {
        const match = data.results.find(r => {
          const date = type === "movie" ? r.release_date : r.first_air_date;
          return date && date.startsWith(year);
        });
        if (match) return String(match.id);
      }
      return String(data.results[0].id);
    }
  }
  return null;
}

function buildSearchTitles(kitsuAnime) {
  if (!kitsuAnime) return [];
  const titles = new Set();
  if (kitsuAnime.titles?.en) titles.add(kitsuAnime.titles.en);
  if (kitsuAnime.titles?.en_jp) titles.add(kitsuAnime.titles.en_jp);
  if (kitsuAnime.canonicalTitle) titles.add(kitsuAnime.canonicalTitle);
  if (kitsuAnime.titles?.en_us) titles.add(kitsuAnime.titles.en_us);

  // Strip season suffixes to create base titles (so S2-specific titles also find S1/S2 results)
  // Added BEFORE ja_jp so they're within the slice(0,3) search limit
  const originals = [...titles];
  for (const t of originals) {
    for (const pat of [
      /\s*(season\s*\d+|\d+(st|nd|rd|th)\s*season|part\s*\d+|第[\d０-９]+期)\s*$/i,
      /\s+\d+\s*$/,  // trailing number like "Naruto 2"
    ]) {
      const stripped = t.replace(pat, "").trim();
      if (stripped && stripped !== t && stripped.length > 3) titles.add(stripped);
    }
  }

  if (kitsuAnime.titles?.ja_jp) titles.add(kitsuAnime.titles.ja_jp);
  return [...titles].filter(Boolean);
}

async function resolveByTmdb(tmdbId, options = {}) {
  const id = String(tmdbId).replace(/^tmdb:/i, "").trim();
  if (!id || !/^\d+$/.test(id)) return { ok: false, error: "invalid_tmdb_id" };

  const kitsuId = await resolveKitsuIdFromTmdb(id);
  if (kitsuId) {
    const result = await resolveByKitsu(kitsuId, options);
    if (result?.ok) {
      result.requested = {
        provider: "tmdb",
        externalId: id,
        id: `tmdb:${id}`,
        resolvedKitsuId: kitsuId,
        ...(options.episode ? { episode: parseInt(String(options.episode), 10) } : {}),
      };
      return result;
    }
  }

  // Fallback: build minimal response with TMDB data only
  return buildMinimalTmdbResponse(id, options);
}

async function resolveByImdb(imdbId, options = {}) {
  const id = String(imdbId).trim();
  if (!id || !/^tt\d+$/i.test(id)) return { ok: false, error: "invalid_imdb_id" };

  // Try direct Kitsu IMDB lookup (rarely works - Kitsu seldom stores IMDB mappings)
  let kitsuId = await findKitsuIdByExternalId("imdb", id);

  // If direct fails, chain: IMDB → TMDB → TVDB → Kitsu
  let resolvedTmdbId = null;
  if (!kitsuId) {
    resolvedTmdbId = await findTmdbIdFromExternal(id, "imdb_id");
    if (resolvedTmdbId) {
      // Get TVDB from TMDB external_ids
      const extIds = await fetchJson(
        `https://api.themoviedb.org/3/tv/${resolvedTmdbId}/external_ids?api_key=${TMDB_API_KEY}`
      );
      if (extIds?.tvdb_id) {
        kitsuId = await findKitsuIdByExternalId("tvdb", String(extIds.tvdb_id));
      }
      // If still no Kitsu, try movie external_ids
      if (!kitsuId) {
        const movieExt = await fetchJson(
          `https://api.themoviedb.org/3/movie/${resolvedTmdbId}/external_ids?api_key=${TMDB_API_KEY}`
        );
        if (movieExt?.tvdb_id) {
          kitsuId = await findKitsuIdByExternalId("tvdb", String(movieExt.tvdb_id));
        }
      }
      // Last resort: search Kitsu by TMDB title
      if (!kitsuId) {
        kitsuId = await searchKitsuByTmdbTitle(resolvedTmdbId);
      }
    }
  }

  if (kitsuId) {
    const result = await resolveByKitsu(kitsuId, options);
    if (result?.ok) {
      result.requested = {
        provider: "imdb",
        externalId: id,
        id: `imdb:${id}`,
        resolvedKitsuId: kitsuId,
        ...(options.episode ? { episode: parseInt(String(options.episode), 10) } : {}),
      };
      return result;
    }
  }

  // Fallback: get TMDB from IMDB, build minimal response with provider search
  const fallbackTmdbId = resolvedTmdbId || await findTmdbIdFromExternal(id, "imdb_id");
  if (fallbackTmdbId) {
    return buildMinimalTmdbResponse(fallbackTmdbId, options, id);
  }

  return { ok: false, error: "not_found" };
}

async function resolveByExternalProvider(providerName, externalId, options = {}) {
  const id = String(externalId).trim();
  if (!id) return { ok: false, error: `invalid_${providerName}_id` };

  const kitsuId = await findKitsuIdByExternalId(providerName, id);
  if (kitsuId) {
    const result = await resolveByKitsu(kitsuId, options);
    if (result?.ok) {
      result.requested = {
        provider: providerName,
        externalId: id,
        id: `${providerName}:${id}`,
        resolvedKitsuId: kitsuId,
        ...(options.episode ? { episode: parseInt(String(options.episode), 10) } : {}),
      };
      return result;
    }
  }

  return { ok: false, error: "not_found" };
}

async function buildMinimalTmdbResponse(tmdbId, options = {}, imdbOverride = null) {
  // Get show details + external IDs from TMDB in parallel
  const [tvData, extIds] = await Promise.all([
    fetchJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`),
    fetchJson(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`),
  ]);

  const ids = { tmdb: tmdbId };
  if (imdbOverride) ids.imdb = imdbOverride;
  else if (extIds?.imdb_id) ids.imdb = extIds.imdb_id;
  if (extIds?.tvdb_id) ids.tvdb = String(extIds.tvdb_id);

  const requestedEpisode = parseInt(String(options.episode || ""), 10) || null;
  const requestedSeason = Number.isInteger(parseInt(String(options.season ?? ""), 10))
    ? parseInt(String(options.season), 10)
    : null;

  let tmdbEpisode = null;
  if (requestedEpisode) {
    tmdbEpisode = await resolveTmdbEpisode(tmdbId, requestedEpisode, requestedSeason);
  }

  // Search provider sites by TMDB title
  const searchTitles = [];
  if (tvData?.name) searchTitles.push(tvData.name);
  if (tvData?.original_name && tvData.original_name !== tvData.name) searchTitles.push(tvData.original_name);

  let animeWorldPaths = [], animeSaturnPaths = [], animeUnityPaths = [];
  if (searchTitles.length > 0) {
    [animeWorldPaths, animeSaturnPaths, animeUnityPaths] = await Promise.all([
      searchAnimeWorld(searchTitles),
      searchAnimeSaturn(searchTitles),
      searchAnimeUnity(searchTitles, null),
    ]);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    requested: {
      provider: imdbOverride ? "imdb" : "tmdb",
      externalId: imdbOverride || tmdbId,
      id: imdbOverride ? `imdb:${imdbOverride}` : `tmdb:${tmdbId}`,
      resolvedKitsuId: null,
      ...(requestedEpisode ? { episode: requestedEpisode } : {}),
    },
    kitsu: null,
    mappings: {
      ids,
      ...(animeWorldPaths.length > 0 ? { animeworld: animeWorldPaths } : {}),
      ...(animeSaturnPaths.length > 0 ? { animesaturn: animeSaturnPaths } : {}),
      ...(animeUnityPaths.length > 0 ? { animeunity: animeUnityPaths } : {}),
      ...(tmdbEpisode ? { tmdb_episode: tmdbEpisode } : {}),
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main entry point. Resolves anime mapping by provider type and external ID.
 *
 * @param {string} provider - "kitsu", "tmdb", "imdb", "mal", "anilist", "tvdb", or "anidb"
 * @param {string} externalId - The external ID (e.g., "12", "tt0388629", "37854")
 * @param {object} options - { episode?: number, season?: number }
 * @returns {Promise<object>} Mapping payload compatible with external API format
 */
async function resolve(provider, externalId, options = {}) {
  const p = String(provider || "").trim().toLowerCase();
  const id = String(externalId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  switch (p) {
    case "kitsu": return resolveByKitsu(id, options);
    case "tmdb": return resolveByTmdb(id, options);
    case "imdb": return resolveByImdb(id, options);
    case "mal":
    case "anilist":
    case "tvdb":
    case "anidb": return resolveByExternalProvider(p, id, options);
    default: return { ok: false, error: "unsupported_provider" };
  }
}

/**
 * Resolve for the /mapping/{kitsuId} route used by tmdb_helper.js.
 * Returns a simplified format: { tmdbId, season, imdbId, source, seasonName, titleHints, ... }
 */
async function resolveForTmdbHelper(kitsuId) {
  const result = await resolveByKitsu(kitsuId, {});
  if (!result?.ok || !result.mappings?.ids) return null;

  const ids = result.mappings.ids;
  const kitsu = result.kitsu;

  // Build title hints from Kitsu titles
  const titleHints = buildSearchTitles(kitsu);

  // Determine season heuristically from title
  let season = null;
  const title = kitsu?.titles?.en || kitsu?.titles?.en_jp || kitsu?.canonicalTitle || "";
  if (title) {
    const seasonMatch = title.match(/Season\s*(\d+)/i) || title.match(/(\d+)(?:st|nd|rd|th)\s*Season/i);
    if (seasonMatch) season = parseInt(seasonMatch[1]);
    else if (title.match(/\s(\d+)$/)) season = parseInt(title.match(/\s(\d+)$/)[1]);
    else if (title.match(/\sII$/)) season = 2;
    else if (title.match(/\sIII$/)) season = 3;
    else if (title.match(/\sIV$/)) season = 4;
    else if (title.match(/\sV$/)) season = 5;
    else if (title.match(/\sVI$/)) season = 6;
    if (/\b(special|recap|ova|oav)\b/i.test(title)) season = 0;
  }

  return {
    tmdbId: ids.tmdb || null,
    season,
    imdbId: ids.imdb || null,
    source: "internal",
    seasonName: null,
    titleHints,
    longSeries: false,
    episodeMode: null,
    mappedSeasons: [],
    seriesSeasonCount: null,
  };
}

module.exports = { resolve, resolveForTmdbHelper, resolveByKitsu, resolveByTmdb, resolveByImdb };
