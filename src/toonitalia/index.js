"use strict";
const cheerio = require("cheerio");
const { getProviderUrl } = require("../provider_urls.js");
const { formatStream } = require("../formatter.js");
const { fetchWithAxios } = require("../utils/fetcher.js");
const { extractFromUrl } = require("../extractors/index.js");

function getBaseUrl() {
  return getProviderUrl("toonitalia") || "https://toonitalia.xyz";
}
function getSearchUrl() {
  return `${getBaseUrl()}/?s=`;
}

let normalizationConfig = {};
try {
  normalizationConfig = require("../config/toonitalia-normalizations.json");
} catch (e) {}

function normalizeTitle(title) {
  if (!title) return "";
  const lower = title.toLowerCase().trim();
  const aliases = normalizationConfig.title_aliases || {};
  return aliases[lower] || lower;
}

function getIdOverride(id) {
  const overrides = normalizationConfig.id_overrides || {};
  return overrides[id] || null;
}

async function getSeriesInfoFromTMDb(imdbId, tmdbId, tmdbApiKey) {
  try {
    const apiKey = tmdbApiKey || "40a9faa1f6741afb2c0c40238d85f8d0";
    let url;
    if (tmdbId) {
      url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}&language=it-IT`;
    } else if (imdbId) {
      url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
    } else {
      return null;
    }
    const response = await fetchWithAxios(url, { responseType: "json" });
    if (!response) return null;
    
    if (tmdbId) {
      const title = response.name || response.original_name;
      const seasonCount = response.number_of_seasons || 1;
      return title ? { title, seasonCount } : null;
    } else {
      const results = response.tv_results || [];
      if (results.length > 0) {
        const title = results[0].name || results[0].original_name;
        const tvId = results[0].id;
        const detailUrl = `https://api.themoviedb.org/3/tv/${tvId}?api_key=${apiKey}&language=it-IT`;
        const detailRes = await fetchWithAxios(detailUrl, { responseType: "json" });
        const seasonCount = detailRes ? detailRes.number_of_seasons || 1 : 1;
        return title ? { title, seasonCount } : null;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function searchContent(query) {
  try {
    const searchQuery = normalizeTitle(query);
    const html = await fetchWithAxios(`${getSearchUrl()}${encodeURIComponent(searchQuery)}`, { responseType: "text" });
    if (!html) return null;

    const $ = cheerio.load(html);
    const normalizeForMatch = (str) => {
      return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
    };
    
    const articles = $("article.post");
    const searchNormalized = normalizeForMatch(searchQuery);

    for (let i = 0; i < articles.length; i++) {
        const article = articles.eq(i);
        const titleLink = article.find(".entry-title a");
        const title = titleLink.text().trim();
        const titleNormalized = normalizeForMatch(title);
        const url = titleLink.attr("href");
        if (titleNormalized.includes(searchNormalized) && url) {
            return url;
        }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function extractEpisodes(contentUrl, tmdbSeasonCount, preferredSection) {
    try {
        const html = await fetchWithAxios(contentUrl, { responseType: "text" });
        if (!html) return [];
        const $ = cheerio.load(html);
        const episodes = [];
        const entryContent = $(".entry-content");
        
        const seasonHeadings = [];
        entryContent.find("h3, h4, strong, b, p").each((_, el) => {
            const text = $(el).text().trim();
            const seasonPattern = /(\\d+)[ªº°]\\s*(?:stagione|season|parte)|(?:stagione|season|parte|серия)\\s*(\\d+)/i;
            const match = text.match(seasonPattern);
            if (match) {
                const seasonNum = parseInt(match[1] || match[2]);
                if (text.length < 100 && seasonNum > 0 && seasonNum < 20) {
                    seasonHeadings.push({ element: $(el), seasonNum, text });
                }
            }
        });
        
        const shouldUseSeasonHeadings = tmdbSeasonCount > 1 && seasonHeadings.length > 0;
        const voeToSeasonMap = new Map();
        
        if (shouldUseSeasonHeadings) {
            seasonHeadings.forEach((seasonHeading, idx) => {
                const seasonNum = seasonHeading.seasonNum.toString().padStart(2, "0");
                let current = seasonHeading.element.next();
                const nextSeasonHeading = seasonHeadings[idx + 1];
                let voeCount = 0;
                while (current.length > 0) {
                    if (nextSeasonHeading && current.is(nextSeasonHeading.element)) break;
                    
                    const isValidVoeToken = (el) => {
                        const href = $(el).attr("href");
                        if (href && (href.includes("voe.sx") || href.includes("voe.") || href.includes("chuckle-tube.com"))) {
                            voeToSeasonMap.set(href, seasonNum);
                            voeCount++;
                        }
                    };
                    
                    if (current.is("a[href*=\"voe.sx\"], a[href*=\"voe.\"], a[href*=\"chuckle-tube.com\"]")) {
                        isValidVoeToken(current);
                    }
                    current.find("a[href*=\"voe.sx\"], a[href*=\"voe.\"], a[href*=\"chuckle-tube.com\"]").each((_, linkEl) => isValidVoeToken(linkEl));
                    current = current.next();
                }
            });
        }
        
        let voeLinks;
        let currentContext = $;
        if (preferredSection) {
            const headings = entryContent.find("h3");
            let targetHeading = null;
            headings.each((_, el) => {
                const headingText = $(el).text().trim();
                if (headingText.includes(preferredSection)) {
                    targetHeading = $(el);
                    return false;
                }
            });
            if (targetHeading) {
                let sectionHtml = "";
                let current = targetHeading.next();
                while (current.length > 0 && !current.is("h3")) {
                    sectionHtml += $.html(current);
                    current = current.next();
                }
                if (sectionHtml) {
                    const sectionScope = cheerio.load(sectionHtml);
                    currentContext = sectionScope;
                    voeLinks = sectionScope("a[href*=\"voe.sx\"], a[href*=\"voe.\"], a[href*=\"chuckle-tube.com\"]");
                } else voeLinks = $();
            } else {
                voeLinks = entryContent.find("a[href*=\"voe.sx\"], a[href*=\"voe.\"], a[href*=\"chuckle-tube.com\"]");
            }
        } else {
            const headings = entryContent.find("h3");
            const sections = [];
            headings.each((_, el) => {
                const headingText = $(el).text().trim();
                const isDvd = /dvd/i.test(headingText);
                sections.push({ heading: $(el), text: headingText, isDvd });
            });
            const nonDvdSections = sections.filter(s => !s.isDvd);
            
            const sectionsToUse = nonDvdSections.length > 0 ? nonDvdSections : sections;
            if (sectionsToUse.length > 0) {
                let combinedHtml = "";
                sectionsToUse.forEach(section => {
                    let current = section.heading.next();
                    while (current.length > 0 && !current.is("h3")) {
                        combinedHtml += $.html(current);
                        current = current.next();
                    }
                });
                if (combinedHtml) {
                    const sectionScope = cheerio.load(combinedHtml);
                    currentContext = sectionScope;
                    voeLinks = sectionScope("a[href*=\"voe.sx\"], a[href*=\"voe.\"], a[href*=\"chuckle-tube.com\"]");
                } else voeLinks = $();
            } else {
                voeLinks = entryContent.find("a[href*=\"voe.sx\"], a[href*=\"voe.\"], a[href*=\"chuckle-tube.com\"]");
            }
        }
        
        console.log("voeLinks count inside index.js:", voeLinks.length);
voeLinks.each((_, el) => {
            const voeUrl = currentContext(el).attr("href");
            if (!voeUrl) /*return*/;
            
            const parent = currentContext(el).parent();
            const parentHtml = parent.html() || "";
            const linkHrefIndex = parentHtml.indexOf(`href="${voeUrl}"`);
            if (linkHrefIndex === -1) return;
            
            const startIndex = Math.max(0, linkHrefIndex - 200);
            const textBeforeLink = parentHtml.substring(startIndex, linkHrefIndex);
            if (/\\bdvd\\b/i.test(textBeforeLink)) return;
            
            const cleanText = textBeforeLink.replace(/<[^>]*>/g, " ").trim();
if (_.valueOf() === 1) console.log("CHARS:", cleanText.split("").map(c => c.charCodeAt(0)));
            let seasonMatch = cleanText.match(/(?:stagione|season|s)?[\\s\\-]*(\\d+)[\\s]*[�x\\-][\\s]*(?:episodio|episode|ep|e)?[\\s]*(\\d+)/i);
            if (seasonMatch) {
                episodes.push({ season: seasonMatch[1].padStart(2, "0"), episode: seasonMatch[2].padStart(2, "0"), voeUrl });
                return;
            }
            const threeDigitMatch = cleanText.match(/\\b(\\d{3})\\b/);
            if (threeDigitMatch) {
                const episode = threeDigitMatch[1];
                const seasonFromMap = voeToSeasonMap.get(voeUrl);
                episodes.push(seasonFromMap ? { season: seasonFromMap, episode, voeUrl } : { episode, voeUrl });
                return;
            }
            const episodeWordMatch = cleanText.match(/(?:episodio|episode|ep|puntata)[- \\s:]*(\\d+)/i);
            if (episodeWordMatch) {
                const episode = episodeWordMatch[1].padStart(3, "0");
                const seasonFromMap = voeToSeasonMap.get(voeUrl);
                episodes.push(seasonFromMap ? { season: seasonFromMap, episode, voeUrl } : { episode, voeUrl });
                return;
            }
            const anyNumberMatch = cleanText.match(/(?:^|\s)(\d{1,3})(?:\s|-|–|$)/);
            if (_.valueOf() === 1) console.log("anyNumberMatch:", anyNumberMatch);
            if (anyNumberMatch) {
                const episode = anyNumberMatch[1].padStart(3, "0");
                const seasonFromMap = voeToSeasonMap.get(voeUrl);
                episodes.push(seasonFromMap ? { season: seasonFromMap, episode, voeUrl } : { episode, voeUrl });
                return;
            }
        });
        
        return episodes;
    } catch (e) {
        return [];
    }
}

async function getStreams(id, type, season, episode, providerContext = null) {
console.log('GET STREAMS', id);
    if (String(type).toLowerCase() === "movie") return [];
    try {
        let cleanId = id.toString();
        if (cleanId.startsWith("tmdb:")) cleanId = cleanId.replace("tmdb:", "");
        
        // Setup initial details
        let seriesName = providerContext?.meta ? (providerContext.meta.name || providerContext.meta.title) : null;
        let imdbId;
        let tmdbId;
        let preferredSection;
        let tmdbSeasonCount = 1;
        let contentUrl;
        
        const contextTmdbId = providerContext && /^\\d+$/.test(String(providerContext.tmdbId || "")) ? String(providerContext.tmdbId) : null;
        const contextImdbId = providerContext && /^tt\\d+$/i.test(String(providerContext.imdbId || "")) ? String(providerContext.imdbId) : null;
        
        if (contextTmdbId) tmdbId = contextTmdbId;
        if (contextImdbId) imdbId = contextImdbId;
        if (cleanId.startsWith("tt")) imdbId = cleanId;
        else if (/^\\d+$/.test(cleanId)) tmdbId = cleanId;

        // Ensure effective season/episode
        let effectiveSeason = Number.parseInt(String(season || ""), 10);
        if (!Number.isInteger(effectiveSeason) || effectiveSeason < 1) effectiveSeason = 1;
        let effectiveEpisode = Number.parseInt(String(episode || ""), 10);
        if (!Number.isInteger(effectiveEpisode) || effectiveEpisode < 1) effectiveEpisode = 1;

        if (imdbId) {
            const override = getIdOverride(imdbId);
            if (override) {
                contentUrl = override.url;
                seriesName = "Override";
                preferredSection = override.section;
            } else if (!seriesName) {
                const seriesInfo = await getSeriesInfoFromTMDb(imdbId, tmdbId);
                if (seriesInfo) { seriesName = seriesInfo.title; tmdbSeasonCount = seriesInfo.seasonCount; }
            }
        } else if (tmdbId) {
            const override = getIdOverride(`tmdb:${tmdbId}`);
            if (override) {
                contentUrl = override.url;
                seriesName = "Override";
                preferredSection = override.section;
            } else if (!seriesName) {
                const seriesInfo = await getSeriesInfoFromTMDb(undefined, tmdbId);
                if (seriesInfo) { seriesName = seriesInfo.title; tmdbSeasonCount = seriesInfo.seasonCount; }
            }
        }
        
        if (!seriesName && !contentUrl) return [];
        
        console.log('seriesName', seriesName, 'contentUrl', contentUrl);
if (!contentUrl) {
            contentUrl = await searchContent(seriesName);
            if (!contentUrl) return [];
        }
        
        console.log('extracting episodes from', contentUrl);
const episodes = await extractEpisodes(contentUrl, tmdbSeasonCount, preferredSection);
console.log('found eps length:', episodes.length);
        if (episodes.length === 0) return [];
        
        const seasonEpisodes = episodes.filter(ep => ep.season !== undefined);
        const sequentialEpisodes = episodes.filter(ep => ep.season === undefined);
        const uniqueSeasonEpisodes = new Set(seasonEpisodes.map(ep => `${ep.season}:${ep.episode}`));
        
        let hasSeasonsInSite;
        if (preferredSection && sequentialEpisodes.length > seasonEpisodes.length) {
            hasSeasonsInSite = false;
        } else {
            hasSeasonsInSite = uniqueSeasonEpisodes.size > 5;
        }
        
        let targetEpisode = null;
        if (hasSeasonsInSite) {
            targetEpisode = episodes.find(ep => ep.season && parseInt(ep.season) === effectiveSeason && parseInt(ep.episode) === effectiveEpisode);
            if (!targetEpisode) {
                const episodesInSeason = episodes.filter(ep => ep.season && parseInt(ep.season) === effectiveSeason);
                if (episodesInSeason.length > 0) {
                    episodesInSeason.sort((a, b) => parseInt(a.episode) - parseInt(b.episode));
                    if (effectiveEpisode - 1 < episodesInSeason.length) {
                        targetEpisode = episodesInSeason[effectiveEpisode - 1];
                    }
                }
            }
        } else {
            targetEpisode = episodes.find(ep => parseInt(ep.episode) === effectiveEpisode);
        }
        
        if (!targetEpisode) return [];
        
        let streamsToReturn = [];
        
        // Toonitalia primarily returns VOE.
        if (targetEpisode.voeUrl) {
            // Extract the actual video URL from VOE
            const voeResults = await extractFromUrl(targetEpisode.voeUrl);
            if (voeResults && voeResults.length > 0) {
                for (const result of voeResults) {
                    streamsToReturn.push(formatStream({
                        name: "ToonItalia (VOE)",
                        title: "VOE Stream",
                        url: result.url,
                        behaviorHints: {
                            notWebReady: true,
                            proxyHeaders: { request: result.headers || {} },
                            bingeGroup: `toonitalia-${seriesName}`,
                        },
                        addonBaseUrl: providerContext?.addonBaseUrl
                    }, "ToonItalia"));
                }
            } else {
                // Fallback: return VOE page URL as external link
                streamsToReturn.push(formatStream({
                    name: "ToonItalia (VOE)",
                    title: "VOE Stream - Requires Web Browser",
                    url: targetEpisode.voeUrl,
                    isExternal: true,
                    behaviorHints: { notWebReady: true, bingeGroup: `toonitalia-${seriesName}` },
                    addonBaseUrl: providerContext?.addonBaseUrl
                }, "ToonItalia"));
            }
        }

        return streamsToReturn.filter(Boolean);
    } catch (error) {
        return [];
    }
}

module.exports = { getStreams };
