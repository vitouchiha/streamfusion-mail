"use strict";
const cheerio = require("cheerio");
const { getProviderUrl } = require("../provider_urls.js");
const { formatStream } = require("../formatter.js");
const { fetchWithAxios } = require("../utils/fetcher.js");
const { getLoonexTitle } = require("../config/loonexTitleMap.js");

function getBaseUrl() {
  return getProviderUrl("loonex") || "https://loonex.eu";
}

function normalizeTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEpisodeNumber(title) {
  if (!title) return null;
  const t = title.trim();
  let m = t.match(/(?:^|\s|[xXeE])\d+[xX](\d+)/);
  if (m) return parseInt(m[1]);
  m = t.match(/[Ss]\d+[Ee](\d+)/);
  if (m) return parseInt(m[1]);
  m = t.match(/(?:episodio|puntata|ep\.?)\s*(\d+)/i);
  if (m) return parseInt(m[1]);
  m = t.match(/^(\d+)\s*[-\ï¿½]/);
  if (m) return parseInt(m[1]);
  m = t.match(/^(\d+)(?:\s|$)/);
  if (m) return parseInt(m[1]);
  return null;
}

function extractSeasonNumber(seasonTitle) {
  if (!seasonTitle) return null;
  const t = seasonTitle.toLowerCase();
  if (/extra|special|speciali|hype|bonus/.test(t)) return -1;
  const m = t.match(/(?:stagione|season)\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

async function getTitleFromTMDb(imdbId, tmdbId, tmdbApiKey) {
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
      return response.name || response.original_name || null;
    } else {
      const results = response.tv_results || [];
      if (results.length > 0) {
        return results[0].name || results[0].original_name || null;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function searchSeries(searchTitle, imdbId, tmdbId) {
  let targetTitle = searchTitle;
  const mappedTitle = getLoonexTitle(imdbId, tmdbId);
  if (mappedTitle) targetTitle = mappedTitle;
  if (!targetTitle) return null;

  const normalizedSearch = normalizeTitle(targetTitle);
  const catUrl = getBaseUrl() + "/cartoni/";
  const html = await fetchWithAxios(catUrl, { responseType: "text" });
  if (!html) return null;

  const $ = cheerio.load(html);
  const series = [];
  $("[data-title]").each((_, el) => {
    const $item = $(el);
    const title = ($item.attr("data-title") || "").trim();
    const rawHref = $item.find("a[href]").attr("href") || "";
    if (!title || !rawHref) return;

    let href;
    if (rawHref.startsWith("http")) href = rawHref;
    else if (rawHref.startsWith("?")) href = catUrl + rawHref;
    else href = getBaseUrl() + (rawHref.startsWith("/") ? "" : "/") + rawHref;

    if (
      normalizeTitle(title).includes(normalizedSearch) ||
      normalizedSearch.includes(normalizeTitle(title))
    ) {
      series.push({ title, url: href, normalizedTitle: normalizeTitle(title) });
    }
  });

  return series.length > 0 ? series[0] : null;
}

async function getEpisodes(seriesUrl) {
  const html = await fetchWithAxios(seriesUrl, { responseType: "text" });
  if (!html) return [];
  const $ = cheerio.load(html);
  const episodes = [];

  $("button[data-bs-target]").each((_, btn) => {
    const $btn = $(btn);
    const seasonTitle = $btn.text().trim().replace(/\s+/g, " ");
    const target = $btn.attr("data-bs-target");
    if (!target) return;

    const $container = $(target);
    $container.find('a[href*="/guarda/"]').each((_, linkEl) => {
      const $link = $(linkEl);
      const episodeUrl = $link.attr("href") || "";
      const episodeTitle =
        $link.text().trim() ||
        $link.closest("div").find("span").first().text().trim() ||
        "Episodio";

      if (episodeUrl) {
        const absUrl = episodeUrl.startsWith("http")
          ? episodeUrl
          : getBaseUrl() + (episodeUrl.startsWith("/") ? "" : "/") + episodeUrl;
        episodes.push({ title: episodeTitle, episodeUrl: absUrl, seasonTitle });
      }
    });
  });
  return episodes;
}

async function getM3U8Url(episodeUrl) {
  const html = await fetchWithAxios(episodeUrl, { responseType: "text" });
  if (!html) return null;

  const b64Match = html.match(
    /var\s+encodedStr\s*=\s*[\"&apos;]([A-Za-z0-9+/=]+)[\"&apos;]/,
  );
  if (b64Match) {
    try {
      let decoded = Buffer.from(b64Match[1], "base64").toString("utf-8");
      if (decoded.includes("%3A") || decoded.includes("%2F")) {
        try {
          decoded = decodeURIComponent(decoded);
        } catch {}
      }
      if (
        decoded &&
        decoded.startsWith("http") &&
        !decoded.includes("nontrovato")
      ) {
        return decoded
          .split("/")
          .map((seg, i) => (i < 3 ? seg : encodeURIComponent(seg)))
          .join("/");
      }
    } catch {}
  }

  const $ = cheerio.load(html);
  let m3u8Url =
    $("#video-source").attr("src") ||
    $('source[type="application/x-mpegURL"]').attr("src") ||
    $("source")
      .filter((_, el) => ($(el).attr("src") || "").includes(".m3u8"))
      .attr("src");
  if (m3u8Url && !m3u8Url.includes("1-second-blank-video")) return m3u8Url;

  const rawMatch = html.match(
    /https?:\/\/[^\s\"&apos;<>]+?\.m3u8[^\s\"&apos;<>]*/,
  );
  if (rawMatch && !rawMatch[0].includes("1-second-blank-video"))
    return rawMatch[0];

  return null;
}

async function getStreams(id, type, season, episode, providerContext = null) {
  try {
    let cleanId = id.toString();
    if (cleanId.startsWith("tmdb:")) cleanId = cleanId.replace("tmdb:", "");
    let tmdbId = cleanId;
    let imdbId = null;

    const contextTmdbId =
      providerContext && /^\d+$/.test(String(providerContext.tmdbId || ""))
        ? String(providerContext.tmdbId)
        : null;
    const contextImdbId =
      providerContext && /^tt\d+$/i.test(String(providerContext.imdbId || ""))
        ? String(providerContext.imdbId)
        : null;
    if (contextTmdbId) tmdbId = contextTmdbId;
    if (contextImdbId) imdbId = contextImdbId;
    if (cleanId.startsWith("tt")) {
      imdbId = cleanId;
      tmdbId = contextTmdbId;
    }

    let effectiveSeason = Number.parseInt(String(season || ""), 10);
    if (!Number.isInteger(effectiveSeason) || effectiveSeason < 1)
      effectiveSeason = 1;
    let effectiveEpisode = Number.parseInt(String(episode || ""), 10);
    if (!Number.isInteger(effectiveEpisode) || effectiveEpisode < 1)
      effectiveEpisode = 1;

    let titleToSearch =
      providerContext && providerContext.meta
        ? providerContext.meta.name || providerContext.meta.title
        : null;
    if (!titleToSearch) {
      titleToSearch = await getTitleFromTMDb(imdbId, tmdbId);
    }
    if (!titleToSearch) return [];

    const serie = await searchSeries(titleToSearch, imdbId, tmdbId);
    if (!serie) return [];

    const allEpisodes = await getEpisodes(serie.url);
    if (!allEpisodes.length) return [];

    const hasSeasons = allEpisodes.some(
      (ep) => extractSeasonNumber(ep.seasonTitle) > 1,
    );
    let target = null;
    for (const ep of allEpisodes) {
      let epNum = extractEpisodeNumber(ep.title);
      if (epNum === null) {
        const m = ep.episodeUrl.match(/_\d+x(\d+)/);
        if (m) epNum = parseInt(m[1], 10);
      }
      if (epNum === effectiveEpisode) {
        if (!hasSeasons) {
          target = ep;
          break;
        }
        const sNum = extractSeasonNumber(ep.seasonTitle);
        if (sNum === effectiveSeason) {
          target = ep;
          break;
        }
      }
    }
    
    if (!target) return [];
    
    const m3u8 = await getM3U8Url(target.episodeUrl);
    if (!m3u8) return [];

    const stream = {
      name: "Loonex",
      title: `Loonex - S${effectiveSeason} E${effectiveEpisode}`,
      type: "direct",
      url: m3u8,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Origin': 'https://loonex.eu',
        'Referer': 'https://loonex.eu/',
      },
      behaviorHints: { notWebReady: true, bingeGroup: `loonex-${serie.normalizedTitle}` },
      addonBaseUrl: providerContext?.addonBaseUrl,
    };
    return [formatStream(stream, "Loonex")].filter(Boolean);
  } catch (error) {
    return [];
  }
}
module.exports = { getStreams };
