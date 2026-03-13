"use strict";

/**
 * Anime ID List — Offline cross-reference index from Fribb/anime-lists.
 *
 * Downloads ~7 MB JSON once, builds in-memory indexes keyed by every ID type,
 * then auto-refreshes periodically (ETag-aware, only re-downloads if changed).
 *
 * Features:
 * - Local file cache: persists across restarts (no redundant 7MB download)
 * - ETag-based: only downloads when remote data has actually changed
 * - Configurable interval: ANIME_LIST_UPDATE_HOURS env var (default 24)
 * - Force refresh: forceRefresh() for manual trigger
 *
 * Usage:
 *   const animeList = require("./anime_list");
 *   await animeList.ensureLoaded();           // warm-up (called once at start)
 *   animeList.findByImdb("tt0409591");        // → { kitsu_id, themoviedb_id, … }
 *   animeList.findByKitsu(12);                // → { imdb_id, themoviedb_id, … }
 */

const fs = require("fs");
const path = require("path");

const LIST_URL =
  "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";

const UPDATE_HOURS = Math.max(1, parseInt(process.env.ANIME_LIST_UPDATE_HOURS, 10) || 24);
const REFRESH_MS = UPDATE_HOURS * 60 * 60 * 1000;

// Local file cache paths — try /tmp first (Vercel), then data/ in project
const CACHE_DIR = fs.existsSync("/tmp") ? "/tmp" : path.join(__dirname, "..", "..", "data");
const CACHE_FILE = path.join(CACHE_DIR, "anime-list-full.json.cache");
const ETAG_FILE  = path.join(CACHE_DIR, "anime-list-etag.txt");

// ─── In-memory indexes ────────────────────────────────────────────────────────
let byKitsu   = new Map(); // kitsu_id (number)  → entry
let byMal     = new Map(); // mal_id   (number)  → entry
let byAnilist = new Map(); // anilist_id (number) → entry
let byImdb    = new Map(); // imdb_id  (string)  → entry[]  (can have dupes)
let byTmdb    = new Map(); // themoviedb_id (num) → entry[]
let byTvdb    = new Map(); // tvdb_id  (number)   → entry[]
let byAnidb   = new Map(); // anidb_id (number)   → entry

let loaded   = false;
let loading  = null;   // dedup promise
let lastEtag = null;
let refreshTimer = null;
let lastUpdateAt  = null;  // Date of last successful update
let totalEntries  = 0;

// ─── Local file cache helpers ─────────────────────────────────────────────────
function loadCachedEtag() {
  try { return fs.existsSync(ETAG_FILE) ? fs.readFileSync(ETAG_FILE, "utf8").trim() : null; }
  catch { return null; }
}

function saveCacheFiles(jsonBuf, etag) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, jsonBuf);
    if (etag) fs.writeFileSync(ETAG_FILE, etag);
  } catch (err) {
    console.error("[AnimeList] Cache write failed:", err.message);
  }
}

function loadFromCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length < 1000) return null;
    return list;
  } catch { return null; }
}

// ─── Build / rebuild indexes ──────────────────────────────────────────────────
function buildIndexes(list) {
  const _byKitsu = new Map(), _byMal = new Map(), _byAnilist = new Map();
  const _byImdb  = new Map(), _byTmdb = new Map(), _byTvdb = new Map();
  const _byAnidb = new Map();

  for (const entry of list) {
    if (entry.kitsu_id)        _byKitsu.set(entry.kitsu_id, entry);
    if (entry.mal_id)          _byMal.set(entry.mal_id, entry);
    if (entry.anilist_id)      _byAnilist.set(entry.anilist_id, entry);
    if (entry.anidb_id)        _byAnidb.set(entry.anidb_id, entry);

    if (entry.imdb_id) {
      const arr = _byImdb.get(entry.imdb_id) || [];
      arr.push(entry); _byImdb.set(entry.imdb_id, arr);
    }
    if (entry.themoviedb_id) {
      const arr = _byTmdb.get(entry.themoviedb_id) || [];
      arr.push(entry); _byTmdb.set(entry.themoviedb_id, arr);
    }
    if (entry.tvdb_id) {
      const arr = _byTvdb.get(entry.tvdb_id) || [];
      arr.push(entry); _byTvdb.set(entry.tvdb_id, arr);
    }
  }

  byKitsu = _byKitsu; byMal = _byMal; byAnilist = _byAnilist;
  byImdb = _byImdb;   byTmdb = _byTmdb; byTvdb = _byTvdb;
  byAnidb = _byAnidb;
  totalEntries = list.length;
}

// ─── Download & refresh ───────────────────────────────────────────────────────
async function download(isScheduled = false) {
  const tag = isScheduled ? "Scheduled update" : "Initial load";
  try {
    const headers = {};
    if (lastEtag) {
      headers["If-None-Match"] = lastEtag;
      console.log(`[AnimeList] ${tag}: Saved ETag: ${lastEtag.slice(0, 20)}… | checking remote…`);
    }

    const res = await fetch(LIST_URL, { headers });

    if (res.status === 304) {
      console.log(`[AnimeList] ${tag}: Not modified (304), skip reload.`);
      lastUpdateAt = new Date();
      return false;
    }
    if (!res.ok) {
      console.error(`[AnimeList] ${tag}: Download failed HTTP ${res.status}`);
      return false;
    }

    const etag = res.headers.get("etag") || null;
    const rawBuf = await res.text();
    const list = JSON.parse(rawBuf);

    if (!Array.isArray(list) || list.length < 1000) {
      console.error(`[AnimeList] ${tag}: Invalid data (length ${list?.length})`);
      return false;
    }

    buildIndexes(list);
    lastEtag = etag;
    loaded = true;
    lastUpdateAt = new Date();

    // Persist to local file cache (async, non-blocking)
    saveCacheFiles(rawBuf, etag);

    console.log(`[AnimeList] ${tag}: Loaded ${list.length} entries, indexes built. ETag: ${etag || "none"}`);
    return true;
  } catch (err) {
    console.error(`[AnimeList] ${tag}: Error — ${err.message}`);
    return false;
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    console.log(`[AnimeList] Running scheduled update (every ${UPDATE_HOURS}h)…`);
    download(true).then(changed => {
      if (changed) console.log("[AnimeList] Scheduled update completed — data refreshed.");
      else console.log("[AnimeList] Scheduled update completed — no changes.");
    }).catch(err => {
      console.error("[AnimeList] Scheduled update failed:", err.message);
    });
  }, REFRESH_MS);
  if (refreshTimer.unref) refreshTimer.unref();
  console.log(`[AnimeList] Scheduled periodic updates every ${UPDATE_HOURS}h.`);
}

async function ensureLoaded() {
  if (loaded) return;
  if (loading) return loading;

  loading = (async () => {
    // 1) Try local file cache first (instant, no network)
    const cachedEtag = loadCachedEtag();
    const cachedList = loadFromCache();
    if (cachedList) {
      buildIndexes(cachedList);
      lastEtag = cachedEtag;
      loaded = true;
      lastUpdateAt = new Date();
      console.log(`[AnimeList] Loaded ${cachedList.length} entries from local cache. ETag: ${cachedEtag || "none"}`);
      // Still schedule a background refresh to pick up any remote changes
      scheduleRefresh();
      // Trigger a background refresh without blocking
      download(true).catch(() => {});
      return;
    }

    // 2) No local cache — download from remote
    await download(false);
    scheduleRefresh();
  })().finally(() => { loading = null; });

  return loading;
}

/** Force an immediate refresh (for manual or API triggers). */
async function forceRefresh() {
  console.log("[AnimeList] Force refresh requested.");
  return download(true);
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/** @returns {object|null} single entry */
function findByKitsu(id)   { return byKitsu.get(Number(id)) || null; }
function findByMal(id)     { return byMal.get(Number(id)) || null; }
function findByAnilist(id) { return byAnilist.get(Number(id)) || null; }
function findByAnidb(id)   { return byAnidb.get(Number(id)) || null; }

/** @returns {object|null} first matching entry */
function findByImdb(id)  { return (byImdb.get(String(id)) || [])[0] || null; }
function findByTmdb(id)  { return (byTmdb.get(Number(id)) || [])[0] || null; }
function findByTvdb(id)  { return (byTvdb.get(Number(id)) || [])[0] || null; }

/** @returns {object[]} all entries sharing same IMDB */
function findAllByImdb(id) { return byImdb.get(String(id)) || []; }
function findAllByTmdb(id) { return byTmdb.get(Number(id)) || []; }
function findAllByTvdb(id) { return byTvdb.get(Number(id)) || []; }

/** Universal lookup: given any ID type, find the entry */
function findByAny(provider, id) {
  const n = Number(id);
  const s = String(id);
  switch (String(provider).toLowerCase()) {
    case "kitsu":   return findByKitsu(n);
    case "mal":     return findByMal(n);
    case "anilist": return findByAnilist(n);
    case "anidb":   return findByAnidb(n);
    case "imdb":    return findByImdb(s);
    case "tmdb":    return findByTmdb(n);
    case "tvdb":    return findByTvdb(n);
    default:        return null;
  }
}

/** Get status info */
function stats() {
  return {
    loaded,
    totalEntries,
    kitsu: byKitsu.size,
    mal: byMal.size,
    anilist: byAnilist.size,
    imdb: byImdb.size,
    tmdb: byTmdb.size,
    tvdb: byTvdb.size,
    anidb: byAnidb.size,
    etag: lastEtag,
    lastUpdateAt: lastUpdateAt ? lastUpdateAt.toISOString() : null,
    refreshIntervalHours: UPDATE_HOURS,
    cacheDir: CACHE_DIR,
    hasCacheFile: fs.existsSync(CACHE_FILE),
  };
}

module.exports = {
  ensureLoaded,
  forceRefresh,
  findByKitsu, findByMal, findByAnilist, findByAnidb,
  findByImdb, findByTmdb, findByTvdb,
  findAllByImdb, findAllByTmdb, findAllByTvdb,
  findByAny,
  stats,
};
