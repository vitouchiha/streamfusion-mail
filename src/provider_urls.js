"use strict";

function safeRequire(moduleName) {
  try {
    // eslint-disable-next-line global-require
    return require(moduleName);
  } catch {
    return null;
  }
}

const fs = safeRequire("fs");
const path = safeRequire("path");

let embeddedProviderUrls = {};
try {
  // Bootstrap defaults from JSON (bundled in provider builds, RN-safe).
  // eslint-disable-next-line global-require
  embeddedProviderUrls = require("../provider_urls.json");
} catch {
  embeddedProviderUrls = {};
}

const defaultProviderUrlsFile =
  path && typeof __dirname !== "undefined"
    ? path.resolve(__dirname, "..", "provider_urls.json")
    : "";

const PROVIDER_URLS_FILE = defaultProviderUrlsFile;
const RELOAD_INTERVAL_MS = 1500;
const PROVIDER_URLS_URL = "https://raw.githubusercontent.com/realbestia1/easystreams/refs/heads/main/provider_urls.json";
const CF_WORKER_DOMAINS_URL = "https://kisskh-proxy.vitobsfm.workers.dev/?provider_urls=1";
const REMOTE_RELOAD_INTERVAL_MS = 10000;
const CF_WORKER_RELOAD_INTERVAL_MS = 60000; // check CF Worker every 60s
const REMOTE_FETCH_TIMEOUT_MS = 5000;

const ALIASES = {
  animeunity: ["animeunuty", "anime_unity"],
  animeworld: ["anime_world"],
  animesaturn: ["anime_saturn"],
  streamingcommunity: ["streaming_community"],
  guardahd: ["guarda_hd"],
  guardaserie: ["guarda_serie"],
  guardoserie: ["guardo_serie"],
  mapping_api: ["mappingapi", "mapping_api_url", "mapping_url"]
};

let lastCheckAt = 0;
let lastMtimeMs = -1;
let localOverrides = {};   // from local provider_urls.json (highest priority)
let cfWorkerData = {};     // from our CF Worker domain resolver (high priority)
let remoteData = {};       // from remote GitHub URL (baseline)
let lastData = {};         // merged: remoteData < cfWorkerData < localOverrides
let lastRemoteCheckAt = 0;
let lastCfWorkerCheckAt = 0;
let remoteInFlight = null;
let cfWorkerInFlight = null;

function rebuildMergedData() {
  lastData = { ...remoteData, ...cfWorkerData, ...localOverrides };
}

function normalizeKey(key) {
  return String(key || "").trim().toLowerCase();
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/\/+$/, "");
}

function toNormalizedMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeKey(key);
    const normalizedValue = normalizeUrl(value);
    if (!normalizedKey || !normalizedValue) continue;
    out[normalizedKey] = normalizedValue;
  }
  return out;
}

function reloadProviderUrlsIfNeeded(force = false) {
  if (!fs || !PROVIDER_URLS_FILE) return;

  const now = Date.now();
  if (!force && now - lastCheckAt < RELOAD_INTERVAL_MS) return;
  lastCheckAt = now;

  let stat;
  try {
    stat = fs.statSync(PROVIDER_URLS_FILE);
  } catch {
    if (lastMtimeMs !== -1) {
      lastMtimeMs = -1;
      localOverrides = {};
      rebuildMergedData();
    }
    return;
  }

  if (!force && stat.mtimeMs === lastMtimeMs) return;

  try {
    const raw = fs.readFileSync(PROVIDER_URLS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    localOverrides = toNormalizedMap(parsed);
    rebuildMergedData();
    lastMtimeMs = stat.mtimeMs;
  } catch {
    localOverrides = {};
    rebuildMergedData();
    lastMtimeMs = stat.mtimeMs;
  }
}

function getFetchImpl() {
  if (typeof fetch === "function") return fetch.bind(globalThis);
  return null;
}

function createTimeoutSignal(timeoutMs) {
  const parsed = Number.parseInt(String(timeoutMs), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { signal: undefined, cleanup: null };
  }

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(parsed), cleanup: null };
  }

  if (typeof AbortController !== "undefined" && typeof setTimeout === "function") {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), parsed);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timeoutId)
    };
  }

  return { signal: undefined, cleanup: null };
}

async function refreshProviderUrlsFromRemoteIfNeeded(force = false) {
  if (!PROVIDER_URLS_URL) return;
  if (remoteInFlight) return;

  const now = Date.now();
  if (!force && now - lastRemoteCheckAt < REMOTE_RELOAD_INTERVAL_MS) return;
  lastRemoteCheckAt = now;

  const fetchImpl = getFetchImpl();
  if (!fetchImpl) return;

  remoteInFlight = (async () => {
    const timeoutConfig = createTimeoutSignal(REMOTE_FETCH_TIMEOUT_MS);

    try {
      const response = await fetchImpl(PROVIDER_URLS_URL, {
        signal: timeoutConfig.signal,
        headers: {
          "accept": "application/json"
        }
      });
      if (!response || !response.ok) return;
      const payload = await response.json();
      const parsed = toNormalizedMap(payload);
      if (Object.keys(parsed).length > 0) {
        remoteData = parsed;
        rebuildMergedData();
      }
    } catch {
      // Ignore remote refresh errors: keep last known values.
    } finally {
      if (typeof timeoutConfig.cleanup === "function") timeoutConfig.cleanup();
      remoteInFlight = null;
    }
  })();
}

function findFromJson(providerKey) {
  reloadProviderUrlsIfNeeded(false);
  refreshProviderUrlsFromRemoteIfNeeded(false);
  refreshFromCfWorkerIfNeeded(false);
  const key = normalizeKey(providerKey);
  const candidates = [key, ...(ALIASES[key] || [])].map(normalizeKey);
  for (const candidate of candidates) {
    const value = normalizeUrl(lastData[candidate]);
    if (value) return value;
  }
  return "";
}

function getProviderUrl(providerKey) {
  const fromJson = findFromJson(providerKey);
  return fromJson || "";
}

function getProviderUrlsFilePath() {
  return PROVIDER_URLS_FILE;
}

function getProviderUrlsSourceUrl() {
  return PROVIDER_URLS_URL;
}

module.exports = {
  getProviderUrl,
  reloadProviderUrlsIfNeeded,
  getProviderUrlsFilePath,
  getProviderUrlsSourceUrl
};

// Initialize from embedded JSON immediately.
localOverrides = toNormalizedMap(embeddedProviderUrls);
rebuildMergedData();

// ── CF Worker domain resolver fetch ─────────────────────────────────────────
async function refreshFromCfWorkerIfNeeded(force = false) {
  if (!CF_WORKER_DOMAINS_URL) return;
  if (cfWorkerInFlight) return;

  const now = Date.now();
  if (!force && now - lastCfWorkerCheckAt < CF_WORKER_RELOAD_INTERVAL_MS) return;
  lastCfWorkerCheckAt = now;

  const fetchImpl = getFetchImpl();
  if (!fetchImpl) return;

  cfWorkerInFlight = (async () => {
    const timeoutConfig = createTimeoutSignal(REMOTE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(CF_WORKER_DOMAINS_URL, {
        signal: timeoutConfig.signal,
        headers: { "accept": "application/json" },
      });
      if (!response || !response.ok) return;
      const payload = await response.json();
      // Strip internal metadata keys
      const clean = {};
      for (const [k, v] of Object.entries(payload)) {
        if (k.startsWith('_')) continue;
        clean[k] = v;
      }
      const parsed = toNormalizedMap(clean);
      if (Object.keys(parsed).length > 0) {
        cfWorkerData = parsed;
        rebuildMergedData();
      }
    } catch {
      // Ignore — keep last known CF Worker data
    } finally {
      if (typeof timeoutConfig.cleanup === "function") timeoutConfig.cleanup();
      cfWorkerInFlight = null;
    }
  })();
}
