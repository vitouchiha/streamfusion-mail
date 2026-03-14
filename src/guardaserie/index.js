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
const mapping = require("../mapping/index");
function getGuardaserieBaseUrl() {
  return getProviderUrl("guardaserie");
}
const { TMDB_API_KEY } = require('../utils/config');
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

const { extractFromUrl } = require('../extractors');
require('../fetch_helper.js');
const { checkQualityFromPlaylist, checkQualityFromText } = require('../quality_helper.js');
const { formatStream } = require('../formatter.js');
const { createLogger } = require('../utils/logger.js');

const log = createLogger('guardaserie');

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

function normalizeEpisodeLink(rawLink) {
  const value = String(rawLink || '').trim();
  if (!value || value === '#') return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${getGuardaserieBaseUrl()}${value}`;
  if (/^https?:/i.test(value)) return value;
  return null;
}

function normalizeTitleForMatch(rawTitle) {
  return String(rawTitle || '')
    .toLowerCase()
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[^a-z0-9]/g, '');
}

function buildSearchTitleCandidates(showInfo, providerContext, fallbackTitle) {
  const values = [];
  if (fallbackTitle) values.push(fallbackTitle);
  if (showInfo) {
    values.push(showInfo.name, showInfo.original_name, showInfo.title, showInfo.original_title);
  }
  if (providerContext) {
    values.push(providerContext.primaryTitle);
    if (Array.isArray(providerContext.titleCandidates)) {
      values.push(...providerContext.titleCandidates);
    }
  }

  const seen = new Set();
  const output = [];
  for (const value of values) {
    const title = String(value || '').trim();
    if (!title || title.length < 2) continue;
    const normalized = normalizeTitleForMatch(title);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(title);
  }
  return output;
}

function titleMatchesCandidates(foundTitle, candidates) {
  const normalizedFound = normalizeTitleForMatch(foundTitle);
  if (!normalizedFound) return false;
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeTitleForMatch(candidate);
    return normalizedCandidate &&
      (normalizedFound.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedFound));
  });
}

function collectEpisodeLinks(showHtml, season, episode) {
  const links = new Set();
  const episodeIds = [
    `serie-${season}_${episode}`,
    `serie-${season}_${String(episode).padStart(2, '0')}`,
  ];

  for (const episodeId of episodeIds) {
    const blockRegex = new RegExp(`<li[^>]*>[\\s\\S]*?<a[^>]+id="${episodeId}"[\\s\\S]*?<\\/li>`, "i");
    const blockMatch = showHtml.match(blockRegex);
    if (!blockMatch) continue;
    for (const match of blockMatch[0].matchAll(/data-link="([^"]+)"/g)) {
      const normalized = normalizeEpisodeLink(match[1]);
      if (normalized) links.add(normalized);
    }
    if (links.size > 0) return Array.from(links);
  }

  const episodeStr = `${season}x${episode}`;
  const episodeStrPadded = `${season}x${String(episode).padStart(2, '0')}`;
  let episodeRegex = new RegExp(`data-num="${episodeStr}"`, "i");
  let episodeMatch = episodeRegex.exec(showHtml);

  if (!episodeMatch) {
    episodeRegex = new RegExp(`data-num="${episodeStrPadded}"`, "i");
    episodeMatch = episodeRegex.exec(showHtml);
  }

  if (!episodeMatch) return [];

  const searchFromIndex = episodeMatch.index;
  const mirrorsStartIndex = showHtml.indexOf('<div class="mirrors">', searchFromIndex);
  if (mirrorsStartIndex === -1) return [];

  const mirrorsEndIndex = showHtml.indexOf("</div>", mirrorsStartIndex);
  if (mirrorsEndIndex === -1) return [];

  const mirrorsHtml = showHtml.substring(mirrorsStartIndex, mirrorsEndIndex);
  for (const match of mirrorsHtml.matchAll(/data-link="([^"]+)"/g)) {
    const normalized = normalizeEpisodeLink(match[1]);
    if (normalized) links.add(normalized);
  }

  return Array.from(links);
}

function getImdbId(tmdbId, type) {
  return __async(this, null, function* () {
    try {
      const endpoint = type === "movie" ? "movie" : "tv";
      const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
      const response = yield fetch(url);
      if (!response.ok) return null;
      const data = yield response.json();
      if (data.imdb_id) return data.imdb_id;
      const externalUrl = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
      const extResponse = yield fetch(externalUrl);
      if (extResponse.ok) {
        const extData = yield extResponse.json();
        if (extData.imdb_id) return extData.imdb_id;
      }
      return null;
    } catch (e) {
      console.error("[Guardaserie] Conversion error:", e);
      return null;
    }
  });
}
function getShowInfo(tmdbId, type) {
  return __async(this, null, function* () {
    try {
      const endpoint = type === "movie" ? "movie" : "tv";
      const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=it-IT`;
      const response = yield fetch(url);
      if (!response.ok) return null;
      return yield response.json();
    } catch (e) {
      console.error("[Guardaserie] TMDB error:", e);
      return null;
    }
  });
}

function getTmdbIdFromImdb(imdbId, type) {
  return __async(this, null, function* () {
    var _a, _b;
    try {
      const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
      const response = yield fetch(url);
      if (!response.ok) return null;
      const data = yield response.json();
      if (type === "movie" && ((_a = data.movie_results) == null ? void 0 : _a.length) > 0) return data.movie_results[0].id;
      if (type === "tv") {
        if (((_b = data.tv_results) == null ? void 0 : _b.length) > 0) return data.tv_results[0].id;
        if (data.tv_episode_results && data.tv_episode_results.length > 0) return data.tv_episode_results[0].show_id;
        if (data.tv_season_results && data.tv_season_results.length > 0) return data.tv_season_results[0].show_id;
      }
      return null;
    } catch (e) {
      console.error("[Guardaserie] ID conversion error:", e);
      return null;
    }
  });
}

function getIdsFromKitsu(kitsuId, season, episode) {
  return __async(this, null, function* () {
    try {
      if (!kitsuId) return null;
      const parsedEpisode = Number.parseInt(String(episode || ""), 10);
      const parsedSeason = Number.parseInt(String(season || ""), 10);
      const options = {};
      if (Number.isInteger(parsedEpisode) && parsedEpisode > 0) {
        options.episode = parsedEpisode;
      } else {
        options.episode = 1;
      }
      if (Number.isInteger(parsedSeason) && parsedSeason >= 0) {
        options.season = parsedSeason;
      }

      const payload = yield mapping.resolve("kitsu", String(kitsuId).trim(), options);
      if (!payload || !payload.ok) return null;
      const ids = payload && payload.mappings && payload.mappings.ids ? payload.mappings.ids : {};
      const tmdbEpisode =
        (payload && payload.mappings && (payload.mappings.tmdb_episode || payload.mappings.tmdbEpisode)) ||
        (payload && (payload.tmdb_episode || payload.tmdbEpisode)) ||
        null;
      const tmdbId = ids && /^\d+$/.test(String(ids.tmdb || "").trim()) ? String(ids.tmdb).trim() : null;
      const imdbId = ids && /^tt\d+$/i.test(String(ids.imdb || "").trim()) ? String(ids.imdb).trim() : null;
      const mappedSeason = Number.parseInt(String(
        tmdbEpisode && (tmdbEpisode.season || tmdbEpisode.seasonNumber || tmdbEpisode.season_number) || ""
      ), 10);
      const mappedEpisode = Number.parseInt(String(
        tmdbEpisode && (tmdbEpisode.episode || tmdbEpisode.episodeNumber || tmdbEpisode.episode_number) || ""
      ), 10);
      const rawEpisodeNumber = Number.parseInt(String(
        tmdbEpisode && (tmdbEpisode.rawEpisodeNumber || tmdbEpisode.raw_episode_number || tmdbEpisode.rawEpisode) || ""
      ), 10);
      return {
        tmdbId,
        imdbId,
        mappedSeason: Number.isInteger(mappedSeason) && mappedSeason > 0 ? mappedSeason : null,
        mappedEpisode: Number.isInteger(mappedEpisode) && mappedEpisode > 0 ? mappedEpisode : null,
        rawEpisodeNumber: Number.isInteger(rawEpisodeNumber) && rawEpisodeNumber > 0 ? rawEpisodeNumber : null
      };
    } catch (e) {
      console.error("[Guardaserie] Kitsu mapping error:", e);
      return null;
    }
  });
}

function verifyMoviePlayer(url, targetYear) {
  return __async(this, null, function* () {
    try {
      console.log(`[Guardaserie] Verifying via MoviePlayer: ${url}`);
      const response = yield fetch(url, {
        headers: {
          "User-Agent": USER_AGENT
        }
      });
      if (!response.ok) return false;
      const html = yield response.text();
      const yearMatch1 = html.match(/trasmessa dal (\d{4})/i);
      if (yearMatch1) {
        const found = parseInt(yearMatch1[1]);
        if (Math.abs(found - targetYear) <= 1) {
          console.log(`[Guardaserie] MoviePlayer verified year ${found} (Target: ${targetYear})`);
          return true;
        }
      }
      const yearMatch2 = html.match(/Prima messa in onda originale.*?(\d{4})/i);
      if (yearMatch2) {
        const found = parseInt(yearMatch2[1]);
        if (Math.abs(found - targetYear) <= 1) {
          console.log(`[Guardaserie] MoviePlayer verified year ${found} (Target: ${targetYear})`);
          return true;
        }
      }
      const titleMatch = html.match(/<title>.*\(.*(\d{4}).*\).*<\/title>/is);
      if (titleMatch) {
        const found = parseInt(titleMatch[1]);
        if (Math.abs(found - targetYear) <= 2) {
          console.log(`[Guardaserie] MoviePlayer verified title year ${found} (Target: ${targetYear})`);
          return true;
        }
      }
      console.log(`[Guardaserie] MoviePlayer verification failed. Target Year: ${targetYear}`);
      return false;
    } catch (e) {
      console.error("[Guardaserie] MoviePlayer error:", e);
      return false;
    }
  });
}
function getStreams(id, type, season, episode, providerContext = null) {
  if (['movie'].includes(String(type).toLowerCase())) return [];
  return __async(this, null, function* () {
    if (String(type).toLowerCase() === "movie") return [];
    try {
      let tmdbId = id;
      let imdbId = null;
      let effectiveSeason = Number.parseInt(String(season || ""), 10);
      if (!Number.isInteger(effectiveSeason) || effectiveSeason < 1) effectiveSeason = 1;
      let effectiveEpisode = Number.parseInt(String(episode || ""), 10);
      if (!Number.isInteger(effectiveEpisode) || effectiveEpisode < 1) effectiveEpisode = 1;
      const contextTmdbId = providerContext && /^\d+$/.test(String(providerContext.tmdbId || ""))
        ? String(providerContext.tmdbId)
        : null;
      const contextImdbId = providerContext && /^tt\d+$/i.test(String(providerContext.imdbId || ""))
        ? String(providerContext.imdbId)
        : null;
      const contextKitsuId = providerContext && /^\d+$/.test(String(providerContext.kitsuId || ""))
        ? String(providerContext.kitsuId)
        : null;
      const isExplicitKitsuRequest = id.toString().startsWith("kitsu:");
      const shouldIncludeSeasonHintForKitsu =
        providerContext && providerContext.seasonProvided === true;

      if (isExplicitKitsuRequest || contextKitsuId) {
        const kitsuId =
          contextKitsuId ||
          (((id.toString().match(/^kitsu:(\d+)/i) || [])[1]) || null);
        // For IMDB/TMDB requests that resolved a Kitsu ID, use the explicit season
        // from the request URL (it's reliable). For pure Kitsu requests the add-on
        // may always send season=1, so only pass it when seasonProvided is true.
        const seasonHintForKitsu = isExplicitKitsuRequest
          ? (shouldIncludeSeasonHintForKitsu ? season : null)
          : (effectiveSeason >= 1 ? effectiveSeason : null);
        const mapped = kitsuId ? (yield getIdsFromKitsu(kitsuId, seasonHintForKitsu, episode)) : null;
        if (mapped) {
          if (mapped.tmdbId) {
            tmdbId = mapped.tmdbId;
            console.log(`[Guardaserie] Kitsu ${kitsuId} mapped to TMDB ID ${tmdbId}`);
          }
          if (mapped.imdbId) {
            imdbId = mapped.imdbId;
            console.log(`[Guardaserie] Kitsu ${kitsuId} mapped to IMDb ID ${imdbId}`);
          }
          if (mapped.mappedSeason && mapped.mappedEpisode) {
            effectiveSeason = mapped.mappedSeason;
            effectiveEpisode = mapped.mappedEpisode;
            console.log(`[Guardaserie] Using TMDB episode mapping ${effectiveSeason}x${effectiveEpisode} (raw=${mapped.rawEpisodeNumber || "n/a"})`);
          } else if (mapped.rawEpisodeNumber) {
            effectiveEpisode = mapped.rawEpisodeNumber;
            console.log(`[Guardaserie] Using mapped raw episode number ${effectiveEpisode}`);
          }
        } else {
          console.log(`[Guardaserie] No Kitsu mapping found for ${kitsuId}`);
        }
      } else if (id.toString().startsWith("tt")) {
        const imdbCore = (id.toString().match(/tt\d{7,8}/) || [])[0] || id.toString();
        imdbId = imdbCore;
        if (contextTmdbId) {
          tmdbId = contextTmdbId;
          console.log(`[Guardaserie] Using prefetched TMDB ID ${tmdbId} for ${id}`);
        } else {
          tmdbId = yield getTmdbIdFromImdb(imdbCore, type);
          if (!tmdbId) {
            console.log(`[Guardaserie] Could not convert ${id} to TMDB ID. Continuing with IMDb ID.`);
          } else {
            console.log(`[Guardaserie] Converted ${id} to TMDB ID: ${tmdbId}`);
          }
        }
      } else if (id.toString().startsWith("tmdb:")) {
        tmdbId = id.toString().replace("tmdb:", "");
      }

      if ((!tmdbId || String(tmdbId).startsWith("kitsu:")) && imdbId) {
        const byImdb = yield getTmdbIdFromImdb(imdbId, type);
        if (byImdb) {
          tmdbId = byImdb;
          console.log(`[Guardaserie] Resolved IMDb ${imdbId} to TMDB ${tmdbId}`);
        }
      }

      // Resolve IMDb ID for verification if we don't have it yet
      if (!imdbId && tmdbId) {
        if (contextImdbId) {
          imdbId = contextImdbId;
          console.log(`[Guardaserie] Using prefetched IMDb ID ${imdbId} for verification`);
        } else {
        try {
          const resolvedImdb = yield getImdbId(tmdbId, type);
          if (resolvedImdb) {
            imdbId = resolvedImdb;
            console.log(`[Guardaserie] Resolved TMDB ID ${tmdbId} to IMDb ID ${imdbId} for verification`);
          }
        } catch (e) {
          console.log(`[Guardaserie] Failed to resolve IMDb ID for verification: ${e.message}`);
        }
        }
      }

      let showInfo = null;
      try {
        if (tmdbId) showInfo = yield getShowInfo(tmdbId, type);
      } catch (e) {
        console.error("[Guardaserie] Error fetching show info:", e);
      }

      if (!showInfo && !imdbId) return [];
      let title = "Serie TV";
      if (showInfo) {
        title = showInfo.name || showInfo.original_name || showInfo.title || showInfo.original_title || "Serie TV";
      } else if (imdbId) {
        title = imdbId;
      }
      const candidateTitles = buildSearchTitleCandidates(showInfo, providerContext, title);
      if (candidateTitles.length > 0) {
        title = candidateTitles[0];
      }

      const year = (showInfo && showInfo.first_air_date) ? showInfo.first_air_date.split("-")[0] : "";
      const metaYear = year ? parseInt(year) : null;
      let showUrl = null;
      let showHtml = null;

      // 1. Attempt Search by IMDb ID (Preferred)
      if (imdbId) {
        console.log(`[Guardaserie] Searching by IMDb ID: ${imdbId}`);
        try {
          const params = new URLSearchParams();
          params.append("do", "search");
          params.append("subaction", "search");
          params.append("story", imdbId);
          const searchUrl = `${getGuardaserieBaseUrl()}/index.php?${params.toString()}`;

          const searchResponse = yield fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Referer": getGuardaserieBaseUrl()
            }
          });

          if (searchResponse.ok) {
            const searchHtml = yield searchResponse.text();
            // Match ALL results, not just the first — iterate to find the one whose page contains our IMDb ID
            const resultRegex = /<div class="mlnh-2">\s*<h2>\s*<a href="([^"]+)" title="([^"]+)">/gi;
            let match;
            while ((match = resultRegex.exec(searchHtml)) !== null) {
              let foundUrl = match[1];
              const foundTitle = match[2];

              // Filter out titles with [SUB ITA]
              if (foundTitle.toUpperCase().includes("[SUB ITA]")) {
                console.log(`[Guardaserie] Filtering out subbed result from IMDb search: ${foundTitle}`);
                continue;
              }

              if (foundUrl.startsWith('/')) foundUrl = `${getGuardaserieBaseUrl()}${foundUrl}`;
              console.log(`[Guardaserie] Checking IMDb search result: ${foundTitle} → ${foundUrl}`);

              const pageResponse = yield fetch(foundUrl, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                  "Referer": getGuardaserieBaseUrl()
                }
              });

              if (pageResponse.ok) {
                const candidateHtml = yield pageResponse.text();

                // Verify: page must contain our exact IMDb ID (show_imdb var, IMDb link, or raw text)
                const imdbVarMatch = candidateHtml.match(/show_imdb\s*=\s*'([^']+)'/i);
                const pageImdbMatches = candidateHtml.match(/tt\d{7,8}/g) || [];
                const hasExactImdb = (imdbVarMatch && imdbVarMatch[1] === imdbId) || pageImdbMatches.includes(imdbId);

                if (hasExactImdb) {
                  console.log(`[Guardaserie] Verified IMDb match on page: ${foundTitle} (${imdbId})`);
                  showHtml = candidateHtml;
                  showUrl = foundUrl;
                  break;
                } else {
                  // Also accept if title matches AND no conflicting IMDb ID exists
                  const otherImdbIds = pageImdbMatches.filter(id => id !== imdbId);
                  if (titleMatchesCandidates(foundTitle, candidateTitles) && otherImdbIds.length === 0) {
                    console.log(`[Guardaserie] Accepted IMDb search result by title match (no conflicting IMDb): ${foundTitle}`);
                    showHtml = candidateHtml;
                    showUrl = foundUrl;
                    break;
                  }
                  console.log(`[Guardaserie] Rejected IMDb search result: ${foundTitle} (IMDb on page: ${pageImdbMatches.join(', ') || 'none'}, expected: ${imdbId})`);
                }
              }
            }
          }
        } catch (e) {
          console.error(`[Guardaserie] Error searching by IMDb ID:`, e);
        }
      }

      // 2. Fallback to Title Search (Legacy)
      if (!showUrl) {
        let candidates = [];
        console.log(`[Guardaserie] Searching by Title candidates: ${candidateTitles.join(" | ")} (${year})`);
        const resultRegex = /<div class="mlnh-2">\s*<h2>\s*<a href="([^"]+)" title="([^"]+)">[\s\S]*?<\/div>\s*<div class="mlnh-3 hdn">([^<]*)<\/div>/g;
        const candidateMap = new Map();
        for (const searchTitle of candidateTitles) {
          const params = new URLSearchParams();
          params.append("do", "search");
          params.append("subaction", "search");
          params.append("story", searchTitle);
          const searchUrl = `${getGuardaserieBaseUrl()}/index.php?${params.toString()}`;
          const searchResponse = yield fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Referer": getGuardaserieBaseUrl()
            }
          });
          const searchHtml = yield searchResponse.text();
          let match;
          while ((match = resultRegex.exec(searchHtml)) !== null) {
            const foundUrl = match[1];
            const foundTitle = match[2];
            const foundYearStr = match[3];

            if (foundTitle.toUpperCase().includes("[SUB ITA]")) {
              console.log(`[Guardaserie] Filtering out subbed result: ${foundTitle}`);
              continue;
            }

            if (titleMatchesCandidates(foundTitle, candidateTitles)) {
              candidateMap.set(foundUrl, {
                url: foundUrl,
                title: foundTitle,
                year: foundYearStr
              });
            }
          }
          resultRegex.lastIndex = 0;
        }
        candidates = Array.from(candidateMap.values());

        // Filter candidates
        for (const candidate of candidates) {
          let matchesYear = true;
          if (metaYear) {
            const yearMatch = candidate.year.match(/(\d{4})/);
            if (yearMatch) {
              const foundYear = parseInt(yearMatch[1]);
              if (Math.abs(foundYear - metaYear) > 2) {
                matchesYear = false;
              }
            }
          }

          if (matchesYear) {
            console.log(`[Guardaserie] Verifying candidate: ${candidate.title} (${candidate.year})`);
            try {
              const candidateRes = yield fetch(candidate.url, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                  "Referer": getGuardaserieBaseUrl()
                }
              });
              if (!candidateRes.ok) continue;
              const candidateHtml = yield candidateRes.text();
              let verifiedByLinks = false;
              let verifiedByVars = false;
              let imdbVarVal = null;
              try {
                const titleVarMatch = candidateHtml.match(/show_title\s*=\s*'([^']+)'/i);
                const imdbVarMatch = candidateHtml.match(/show_imdb\s*=\s*'([^']+)'/i);
                if (imdbVarMatch) imdbVarVal = imdbVarMatch[1];
                if (imdbVarVal && imdbId && imdbVarVal === imdbId) {
                  console.log(`[Guardaserie] Verified ${candidate.url} via show_imdb variable.`);
                  verifiedByVars = true;
                } else if (titleVarMatch) {
                  if (titleMatchesCandidates(titleVarMatch[1], candidateTitles)) {
                    console.log(`[Guardaserie] Tentatively verified ${candidate.url} via show_title variable.`);
                    verifiedByVars = true;
                  }
                }
              } catch (e) { }
              if (imdbId && imdbVarVal && imdbVarVal !== imdbId) {
                console.log(`[Guardaserie] Rejected ${candidate.url} due to show_imdb mismatch (${imdbVarVal} != ${imdbId}).`);
                continue;
              }
              if (!verifiedByVars) {
                try {
                  const tmdbLinkMatches = candidateHtml.match(/themoviedb\.org\/(?:tv|movie)\/(\d+)/g);
                  if (tmdbLinkMatches && tmdbLinkMatches.length > 0 && tmdbId) {
                    const foundIds = tmdbLinkMatches.map(l => {
                      const m = l.match(/\/(\d+)/);
                      return m ? m[1] : null;
                    }).filter(Boolean);
                    if (foundIds.includes(String(tmdbId))) {
                      console.log(`[Guardaserie] Verified ${candidate.url} via TMDB link.`);
                      verifiedByLinks = true;
                    } else {
                      console.log(`[Guardaserie] Rejected ${candidate.url} due to TMDB mismatch.`);
                      continue;
                    }
                  }
                  if (!verifiedByLinks) {
                    const mpLinkMatch = candidateHtml.match(/href=["'](https?:\/\/(?:www\.)?movieplayer\.it\/serietv\/[^"']+)["']/i);
                    if (mpLinkMatch && metaYear) {
                      const mpUrl = mpLinkMatch[1];
                      const ok = yield verifyMoviePlayer(mpUrl, metaYear);
                      if (ok) {
                        verifiedByLinks = true;
                        console.log(`[Guardaserie] Verified ${candidate.url} via MoviePlayer link.`);
                      } else {
                        console.log(`[Guardaserie] Rejected ${candidate.url} via MoviePlayer year mismatch.`);
                        continue;
                      }
                    }
                  }
                  if (!verifiedByLinks && imdbId) {
                    const imdbLinkMatches = candidateHtml.match(/imdb\.com\/title\/(tt\d{7,8})/g);
                    if (imdbLinkMatches && imdbLinkMatches.length > 0) {
                      const foundImdb = imdbLinkMatches.map(l => {
                        const m = l.match(/(tt\d{7,8})/);
                        return m ? m[1] : null;
                      }).filter(Boolean);
                      if (foundImdb.includes(imdbId)) {
                        console.log(`[Guardaserie] Verified ${candidate.url} via IMDb link.`);
                        verifiedByLinks = true;
                      } else {
                        console.log(`[Guardaserie] Rejected ${candidate.url} due to IMDb link mismatch.`);
                        continue;
                      }
                    }
                  }
                } catch (e) { }
              }
              if (!verifiedByLinks && !verifiedByVars && imdbId) {
                const imdbMatches = candidateHtml.match(/tt\d{7,8}/g);
                if (imdbMatches && imdbMatches.length > 0) {
                  const targetId = imdbId;
                  const hasTarget = imdbMatches.includes(targetId);
                  const otherIds = imdbMatches.filter(m => m !== targetId);

                  if (!hasTarget && otherIds.length > 0) {
                    // Special case for One Piece alias/dub
                    if (title.includes("One Piece") && candidate.title.includes("All'arrembaggio")) {
                      console.log(`[Guardaserie] Accepting "All'arrembaggio" despite IMDb mismatch (known alias).`);
                    } else {
                      console.log(`[Guardaserie] Rejected ${candidate.url} due to IMDb mismatch. Found: ${otherIds.join(", ")}`);
                      continue;
                    }
                  }
                  if (hasTarget) {
                    console.log(`[Guardaserie] Verified ${candidate.url} with IMDb match.`);
                  }
                }
              }

              if (verifiedByLinks || verifiedByVars) {
                showUrl = candidate.url;
                showHtml = candidateHtml;
                break;
              } else {
                showUrl = candidate.url;
                showHtml = candidateHtml;
                break;
              }
            } catch (e) {
              console.error(`[Guardaserie] Error verifying candidate ${candidate.url}:`, e);
            }
          }
        }
      }

      if (!showUrl) {
        console.log("[Guardaserie] No candidate matched criteria.");
      }
      if (!showUrl || !showHtml) {
        console.log("[Guardaserie] Show not found");
        return [];
      }
      console.log(`[Guardaserie] Found show URL: ${showUrl}`);
      season = effectiveSeason;
      episode = effectiveEpisode;
      const episodeStr = `${season}x${episode}`;
      const links = collectEpisodeLinks(showHtml, season, episode);
      if (!links.length) {
        console.log(`[Guardaserie] Episode ${episodeStr} not found`);
        return [];
      }
      console.log(`[Guardaserie] Found ${links.length} potential links`);
      // Separate SuperVideo mirrors from other extractors.
      // SuperVideo links are tried SEQUENTIALLY — if one mirror is Cloudflare-
      // blocked, we fall back to the next.  De-duplicate first.
      const svLinksUnique = [];
      const svSeen = new Set();
      const otherLinks = [];
      for (const link of links) {
        if (/supervideo/i.test(link)) {
          if (!svSeen.has(link)) { svSeen.add(link); svLinksUnique.push(link); }
        } else {
          otherLinks.push(link);
        }
      }
      log.warn('link split', { svCount: svLinksUnique.length, otherCount: otherLinks.length });

      const displayName = `${title} ${season}x${episode}`;

      // Try SuperVideo mirrors sequentially (browser extraction is heavy)
      let svStreams = [];
      for (const svLink of svLinksUnique) {
        try {
          const extracted = yield extractFromUrl(svLink, {
            refererBase: getGuardaserieBaseUrl(),
            proxyUrl: providerContext?.proxyUrl,
          });
          log.warn('supervideo extracted streams', {
            link: svLink,
            count: extracted.length,
            streams: extracted.map((s) => ({ url: s.url, name: s.name, isExternal: s.isExternal })),
          });
          if (extracted.length > 0) {
            svStreams = extracted;
            break; // got a working mirror, stop
          }
        } catch (e) {
          log.warn('supervideo mirror failed, trying next', { link: svLink, error: e.message });
        }
      }

      // Process other links concurrently
      const otherStreamPromises = otherLinks.map((link) => __async(null, null, function* () {
        try {
          const extractedStreams = yield extractFromUrl(link, {
            refererBase: getGuardaserieBaseUrl(),
            proxyUrl: providerContext?.proxyUrl,
          });
          if (!extractedStreams.length) return [];

          return extractedStreams.map((extracted) => __async(null, null, function* () {
            let quality = "HD";
            if (extracted.manifestBody) {
              const detected = checkQualityFromText(extracted.manifestBody);
              if (detected) quality = detected;
            } else if (extracted.url.includes('.m3u8')) {
              const detected = yield checkQualityFromPlaylist(extracted.url, extracted.headers || {}, extracted.proxyUrl);
              if (detected) quality = detected;
            } else {
              const lowerUrl = extracted.url.toLowerCase();
              if (lowerUrl.includes("4k") || lowerUrl.includes("2160")) quality = "4K";
              else if (lowerUrl.includes("1080") || lowerUrl.includes("fhd")) quality = "1080p";
              else if (lowerUrl.includes("720") || lowerUrl.includes("hd")) quality = "720p";
              else if (lowerUrl.includes("480") || lowerUrl.includes("sd")) quality = "480p";
              else if (lowerUrl.includes("360")) quality = "360p";
            }

            const normalizedQuality = getQualityFromName(quality);
            const hasPlaybackHeaders = extracted.headers && Object.keys(extracted.headers).length > 0;
            const behaviorHints = extracted.isExternal
              ? { notWebReady: true, bingeGroup: `guardaserie-${title}` }
              : hasPlaybackHeaders
                ? {
                    notWebReady: true,
                    bingeGroup: `guardaserie-${title}`,
                  }
                : { bingeGroup: `guardaserie-${title}` };
            return {
              url: extracted.url,
              headers: extracted.headers,
              proxyUrl: extracted.proxyUrl,
              manifestBody: extracted.manifestBody,
              name: `Guardaserie - ${extracted.name || 'Player'}`,
              title: extracted.isExternal ? `Web Browser - ${displayName}` : displayName,
              quality: normalizedQuality,
              isExternal: extracted.isExternal,
              behaviorHints,
              type: "direct",
              addonBaseUrl: providerContext?.addonBaseUrl
            };
          }));
        } catch (e) {
          console.error(`[Guardaserie] Error extracting link ${link}:`, e);
        }
        return [];
      }));

      // Build stream objects from successful SuperVideo extraction
      const svStreamObjs = [];
      for (const extracted of svStreams) {
        let quality = "HD";
        if (extracted.manifestBody) {
          const detected = checkQualityFromText(extracted.manifestBody);
          if (detected) quality = detected;
        } else if (extracted.url && /serversicuro\.cc.*\.urlset\/master\.m3u8/i.test(extracted.url)) {
          // serversicuro.cc multi-variant playlists always include 1080p as highest quality
          quality = '1080p';
        } else if (extracted.url && extracted.url.includes('.m3u8')) {
          const detected = yield checkQualityFromPlaylist(extracted.url, extracted.headers || {}, extracted.proxyUrl);
          if (detected) quality = detected;
        } else if (extracted.url.includes('.m3u8')) {
          const detected = yield checkQualityFromPlaylist(extracted.url, extracted.headers || {}, extracted.proxyUrl);
          if (detected) quality = detected;
        } else {
          const lowerUrl = extracted.url.toLowerCase();
          if (lowerUrl.includes("4k") || lowerUrl.includes("2160")) quality = "4K";
          else if (lowerUrl.includes("1080") || lowerUrl.includes("fhd")) quality = "1080p";
          else if (lowerUrl.includes("720") || lowerUrl.includes("hd")) quality = "720p";
          else if (lowerUrl.includes("480") || lowerUrl.includes("sd")) quality = "480p";
          else if (lowerUrl.includes("360")) quality = "360p";
        }
        const normalizedQuality = getQualityFromName(quality);
        const hasPlaybackHeaders = extracted.headers && Object.keys(extracted.headers).length > 0;
        // serversicuro.cc tokens are IP-locked to the server that extracted them.
        // Let the internal HLS proxy handle playback so the same IP is used.
        const behaviorHints = extracted.isExternal
          ? { notWebReady: true, bingeGroup: `guardaserie-${title}` }
          : hasPlaybackHeaders
            ? { notWebReady: true, bingeGroup: `guardaserie-${title}` }
            : { bingeGroup: `guardaserie-${title}` };
        svStreamObjs.push({
          url: extracted.url,
          headers: extracted.headers,
          proxyUrl: extracted.proxyUrl,
          manifestBody: extracted.manifestBody,
          name: `Guardaserie - ${extracted.name || 'Player'}`,
          title: extracted.isExternal ? `Web Browser - ${displayName}` : displayName,
          quality: normalizedQuality,
          isExternal: extracted.isExternal,
          behaviorHints,
          type: "direct",
          addonBaseUrl: providerContext?.addonBaseUrl
        });
      }

      const nestedResults = yield Promise.all(otherStreamPromises);
      let results = [...svStreamObjs, ...(yield Promise.all(nestedResults.flat())).filter(Boolean)];

      // Always filter out external fallbacks – SuperVideo embed URLs are useless
      // as "Web Browser" entries in Stremio; only keep direct playback streams.
      results = results.filter((stream) => stream && !stream.isExternal);

      // Deduplicate streams by provider name + quality to avoid duplicate SuperVideo/Mixdrop mirrors
      const uniqueKeys = new Set();
      results = results.filter(s => {
          const key = `${s.name}-${s.quality}`;
          if (uniqueKeys.has(key)) return false;
          uniqueKeys.add(key);
          return true;
      });

      return results
        .map(s => formatStream(s, "Guardaserie"))
        .filter(s => s !== null);
    } catch (e) {
      console.error("[Guardaserie] Error:", e);
      return [];
    }
  });
}
module.exports = { getStreams };
