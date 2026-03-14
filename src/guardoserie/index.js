const { USER_AGENT } = require('../extractors/common');
const { extractLoadm, extractUqload, extractDropLoad } = require('../extractors');
const { formatStream } = require('../formatter');
const { checkQualityFromPlaylist } = require('../quality_helper');
const { getProviderUrl } = require('../provider_urls.js');
const { CookieJar } = require('tough-cookie');
const { launchBrowser } = require('../utils/browser.js');
const mapping = require('../mapping/index');

function getGuardoserieBaseUrl() {
    return getProviderUrl('guardoserie');
}
const { TMDB_API_KEY } = require('../utils/config');

// ── Proxy + CookieJar helper (like StreamVix) ─────────────────────────────
const _cookieJar = new CookieJar();

function _getProxyUrl() {
    return (process.env.PROXY_URL || process.env.PROXY || '').trim() || null;
}

function _makeAgent() {
    const proxyUrl = _getProxyUrl();
    if (!proxyUrl) return null;
    if (proxyUrl.startsWith('socks')) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        return new SocksProxyAgent(proxyUrl);
    }
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
}

let _cachedAgent = undefined; // undefined = not yet created
function _getAgent() {
    if (_cachedAgent === undefined) _cachedAgent = _makeAgent();
    return _cachedAgent;
}

const BROWSER_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
};

/**
 * Fetch via Cloudflare Worker proxy (bypasses CF bot detection on guardoserie).
 * Returns a fetch-like response or null if CF Worker is not configured / fails.
 */
async function _cfWorkerFetch(url) {
    const cfBase = (process.env.CF_WORKER_URL || '').trim();
    if (!cfBase) return null;
    const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();
    try {
        // Use .digital domain (already in CF Worker's ALLOWED_HOSTS, auto-redirects to .best)
        const cfTargetUrl = url.replace('guardoserie.best', 'guardoserie.digital');
        const workerUrl = new URL(cfBase.replace(/\/$/, ''));
        workerUrl.searchParams.set('url', cfTargetUrl);
        const headers = { 'Accept': 'text/html, */*' };
        if (cfAuth) headers['x-worker-auth'] = cfAuth;
        const resp = await fetch(workerUrl.toString(), { headers, signal: AbortSignal.timeout(8000) });
        const body = await resp.text();
        if (!resp.ok || body.includes('Just a moment')) return null;
        return {
            ok: true, status: resp.status, statusCode: resp.status,
            headers: {
                get: (name) => resp.headers.get(name),
                getSetCookie: () => resp.headers.getSetCookie?.() || [],
            },
            text: async () => body, json: async () => JSON.parse(body),
        };
    } catch (e) {
        console.warn(`[Guardoserie] CF Worker fetch failed: ${e.message}`);
        return null;
    }
}

/**
 * Fetch via headless browser (Browserless.io or local Chromium).
 * Solves Cloudflare JS challenges via puppeteer-stealth.
 */
let _sharedBrowser = null;
async function _browserFetch(url) {
    try {
        if (!_sharedBrowser || !_sharedBrowser.isConnected()) {
            _sharedBrowser = await launchBrowser();
        }
        const page = await _sharedBrowser.newPage();
        // Authenticate if browser has proxy auth
        if (_sharedBrowser._proxyAuth) {
            await page.authenticate(_sharedBrowser._proxyAuth);
        }
        try {
            await page.setUserAgent(USER_AGENT);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
            // Wait for Cloudflare challenge to resolve (if present)
            const isCF = await page.evaluate(() => document.title.includes('Just a moment'));
            if (isCF) {
                console.log(`[Guardoserie] Cloudflare challenge detected, waiting...`);
                await page.waitForFunction(
                    () => !document.title.includes('Just a moment'),
                    { timeout: 15000 }
                );
            }
            const body = await page.content();
            console.log(`[Guardoserie] Browser fetch OK: ${url.substring(0, 80)} (${body.length} bytes)`);
            return {
                ok: true, status: 200, statusCode: 200,
                headers: { get: () => null, getSetCookie: () => [] },
                text: async () => body, json: async () => JSON.parse(body),
            };
        } finally {
            await page.close().catch(() => {});
        }
    } catch (e) {
        console.warn(`[Guardoserie] Browser fetch failed: ${e.message}`);
        return null;
    }
}

/**
 * Pick a random Webshare residential proxy.
 */
function _getWebshareProxy() {
    const raw = (process.env.WEBSHARE_PROXIES || '').trim();
    if (!raw) return null;
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

/**
 * Fetch via WEBSHARE residential proxy (better for Cloudflare bypass).
 */
async function _webshareFetch(url, mergedHeaders) {
    const proxyUrl = _getWebshareProxy();
    if (!proxyUrl) return null;
    try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const agent = new HttpsProxyAgent(proxyUrl);
        const https = require('https');
        const http = require('http');
        const { URL } = require('url');
        const zlib = require('zlib');
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;

        return await new Promise((resolve, reject) => {
            const reqOpts = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: { ...mergedHeaders, Host: parsed.host },
                agent,
                timeout: 10000,
            };
            const req = mod.request(reqOpts, (res) => {
                // Follow redirects
                if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                    resolve(_webshareFetch(res.headers.location, mergedHeaders));
                    return;
                }
                const chunks = [];
                const encoding = (res.headers['content-encoding'] || '').toLowerCase();
                let stream = res;
                if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
                else if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
                else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    if (res.statusCode === 403 && body.includes('Just a moment')) {
                        resolve(null); // Cloudflare blocked
                        return;
                    }
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode, statusCode: res.statusCode,
                        headers: {
                            get: (name) => res.headers[name.toLowerCase()] || null,
                            getSetCookie: () => { const sc = res.headers['set-cookie']; return Array.isArray(sc) ? sc : sc ? [sc] : []; }
                        },
                        text: async () => body, json: async () => JSON.parse(body),
                    });
                });
                stream.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        });
    } catch (e) {
        console.warn(`[Guardoserie] WEBSHARE fetch failed: ${e.message}`);
        return null;
    }
}

/**
 * Circuit-breaker: after first CF block for guardoserie, skip all subsequent calls.
 * Resets after 5 minutes (allows retry in next cold start).
 */
let _cfBlockedUntil = 0;

/**
 * Fetch with multiple proxy strategies for guardoserie domains:
 * 1. CF Worker (CF-to-CF bypass) — raced in parallel with Webshare
 * 2. WEBSHARE residential proxy (bypasses Cloudflare) — raced in parallel with CF Worker
 * 3. Browser (only if BROWSERLESS_URL is configured)
 * 4. PROXY_URL / direct fetch (fallback)
 *
 * Circuit-breaker: if CF blocks the first request, all subsequent requests
 * within the same invocation return null immediately.
 */
async function proxyFetch(url, opts = {}) {
    const isGuardoserie = url.includes('guardoserie');

    // Circuit-breaker: skip immediately if guardoserie was already CF-blocked
    if (isGuardoserie && _cfBlockedUntil > Date.now()) {
        console.warn(`[Guardoserie] Circuit-breaker: skipping ${url.substring(0, 80)}`);
        return null;
    }

    // Inject cookies from jar
    let cookies = '';
    try { cookies = _cookieJar.getCookieStringSync(url); } catch { /* ignore */ }
    const mergedHeaders = { ...BROWSER_HEADERS, ...opts.headers };
    if (cookies) mergedHeaders['Cookie'] = cookies;

    if (isGuardoserie) {
        // Race CF Worker and Webshare in parallel (both are fast-fail)
        const racers = [];
        const hasCfWorker = !!(process.env.CF_WORKER_URL || '').trim();
        const hasWebshare = !!(process.env.WEBSHARE_PROXIES || '').trim();
        const hasBrowserless = !!(process.env.BROWSERLESS_URL || '').trim();

        if (hasCfWorker) racers.push(_cfWorkerFetch(url).catch(() => null));
        if (hasWebshare) racers.push(_webshareFetch(url, mergedHeaders).catch(() => null));

        if (racers.length > 0) {
            // Use Promise.any-like: resolve on first non-null result
            const result = await new Promise((resolve) => {
                let pending = racers.length;
                for (const p of racers) {
                    p.then(r => { if (r) resolve(r); else if (--pending === 0) resolve(null); })
                     .catch(() => { if (--pending === 0) resolve(null); });
                }
            });
            if (result) {
                const setCookieHeaders = result.headers.getSetCookie?.() || [];
                for (const c of setCookieHeaders) { try { _cookieJar.setCookieSync(c, url); } catch {} }
                return result;
            }
        }

        // Strategy 3: Headless browser — only if BROWSERLESS_URL is configured
        if (hasBrowserless) {
            const brResp = await _browserFetch(url);
            if (brResp) return brResp;
        }

        console.warn(`[Guardoserie] All proxy strategies failed for ${url}, trying direct`);
    }

    // Strategy 4: PROXY_URL agent or direct
    const agent = _getAgent();
    const fetchOpts = { ...opts, headers: mergedHeaders };
    if (agent) fetchOpts.agent = agent;

    try {
        const resp = await _doFetch(url, fetchOpts);

        // Check if CF blocked (403 + "Just a moment") — trip the circuit breaker
        if (isGuardoserie && resp.status === 403) {
            const body = await resp.text();
            if (body.includes('Just a moment')) {
                console.warn(`[Guardoserie] CF blocked — circuit breaker tripped for 5m`);
                _cfBlockedUntil = Date.now() + 5 * 60_000;
                return null;
            }
            // Non-CF 403, return as-is
            return {
                ...resp,
                text: async () => body,
                json: async () => JSON.parse(body),
            };
        }

        // Store set-cookie headers
        const setCookieHeaders = resp.headers.getSetCookie?.() || [];
        for (const c of setCookieHeaders) {
            try { _cookieJar.setCookieSync(c, url); } catch { /* ignore */ }
        }

        return resp;
    } catch (e) {
        // Network error or timeout — trip circuit breaker for guardoserie
        if (isGuardoserie) {
            console.warn(`[Guardoserie] Fetch error — circuit breaker tripped: ${e.message}`);
            _cfBlockedUntil = Date.now() + 5 * 60_000;
        }
        throw e;
    }
}

/**
 * Perform the actual HTTP request, using proxy agent if available.
 */
async function _doFetch(url, opts) {
    const agent = opts.agent;
    delete opts.agent;

    if (!agent) return fetch(url, opts);

    // Use http/https module with agent for proxy support
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');
    const zlib = require('zlib');
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: opts.method || 'GET',
            headers: { ...opts.headers, Host: parsed.host },
            agent,
            timeout: 10000,
        };

        const req = mod.request(reqOpts, (res) => {
            const chunks = [];
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            else if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                // Build a fetch-like response
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    statusCode: res.statusCode,
                    headers: {
                        get: (name) => res.headers[name.toLowerCase()] || null,
                        getSetCookie: () => {
                            const sc = res.headers['set-cookie'];
                            return Array.isArray(sc) ? sc : sc ? [sc] : [];
                        }
                    },
                    text: async () => body,
                    json: async () => JSON.parse(body),
                });
            });
            stream.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        if (opts.body) req.write(opts.body);
        req.end();
    });
}
// ────────────────────────────────────────────────────────────────────────────

async function getIdsFromKitsu(kitsuId, season, episode) {
    try {
        if (!kitsuId) return null;
        const parsedEpisode = Number.parseInt(String(episode || ''), 10);
        const parsedSeason = Number.parseInt(String(season || ''), 10);
        const options = {};
        if (Number.isInteger(parsedEpisode) && parsedEpisode > 0) {
            options.episode = parsedEpisode;
        } else {
            options.episode = 1;
        }
        if (Number.isInteger(parsedSeason) && parsedSeason >= 0) {
            options.season = parsedSeason;
        }

        const payload = await mapping.resolve('kitsu', String(kitsuId).trim(), options);
        if (!payload || !payload.ok) return null;
        const ids = payload && payload.mappings && payload.mappings.ids ? payload.mappings.ids : {};
        const tmdbEpisode =
            (payload && payload.mappings && (payload.mappings.tmdb_episode || payload.mappings.tmdbEpisode)) ||
            (payload && (payload.tmdb_episode || payload.tmdbEpisode)) ||
            null;
        const tmdbId = ids && /^\d+$/.test(String(ids.tmdb || '').trim()) ? String(ids.tmdb).trim() : null;
        const imdbId = ids && /^tt\d+$/i.test(String(ids.imdb || '').trim()) ? String(ids.imdb).trim() : null;
        const mappedSeason = Number.parseInt(String(
            tmdbEpisode && (tmdbEpisode.season || tmdbEpisode.seasonNumber || tmdbEpisode.season_number) || ''
        ), 10);
        const mappedEpisode = Number.parseInt(String(
            tmdbEpisode && (tmdbEpisode.episode || tmdbEpisode.episodeNumber || tmdbEpisode.episode_number) || ''
        ), 10);
        const rawEpisodeNumber = Number.parseInt(String(
            tmdbEpisode && (tmdbEpisode.rawEpisodeNumber || tmdbEpisode.raw_episode_number || tmdbEpisode.rawEpisode) || ''
        ), 10);
        return {
            tmdbId,
            imdbId,
            mappedSeason: Number.isInteger(mappedSeason) && mappedSeason > 0 ? mappedSeason : null,
            mappedEpisode: Number.isInteger(mappedEpisode) && mappedEpisode > 0 ? mappedEpisode : null,
            rawEpisodeNumber: Number.isInteger(rawEpisodeNumber) && rawEpisodeNumber > 0 ? rawEpisodeNumber : null
        };
    } catch (e) {
        console.error('[Guardoserie] Kitsu mapping error:', e);
        return null;
    }
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode) {
    if (!pageHtml) return null;

    const seasonIndex = parseInt(season, 10) - 1;
    const episodeIndex = parseInt(episode, 10) - 1;
    if (!Number.isInteger(seasonIndex) || !Number.isInteger(episodeIndex) || seasonIndex < 0 || episodeIndex < 0) {
        return null;
    }

    // Main pattern used by Guardoserie season tabs.
    const seasonBlocks = pageHtml.split(/class=['"]les-content['"]/i);
    if (seasonBlocks.length > seasonIndex + 1) {
        const targetSeasonBlock = seasonBlocks[seasonIndex + 1];
        const blockEnd = targetSeasonBlock.indexOf('</div>');
        const cleanBlock = blockEnd !== -1 ? targetSeasonBlock.substring(0, blockEnd) : targetSeasonBlock;

        const episodeRegex = /<a[^>]+href=['"]([^'"]+)['"][^>]*>/g;
        const episodes = [];
        let eMatch;
        while ((eMatch = episodeRegex.exec(cleanBlock)) !== null) {
            if (eMatch[1] && /\/episodio\//i.test(eMatch[1])) {
                episodes.push(eMatch[1]);
            }
        }

        if (episodes.length > episodeIndex) {
            return episodes[episodeIndex];
        }
    }

    // Fallback: direct episode URL pattern on full page.
    const explicitEpisodeRegex = new RegExp(`https?:\\/\\/[^"'\\s]+\\/episodio\\/[^"'\\s]*stagione-${season}-episodio-${episode}[^"'\\s]*`, 'i');
    const explicitMatch = pageHtml.match(explicitEpisodeRegex);
    if (explicitMatch && explicitMatch[0]) {
        return explicitMatch[0];
    }

    return null;
}

function normalizePlayerLink(link) {
    if (!link) return null;
    let normalized = String(link)
        .trim()
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/');

    if (!normalized || normalized.startsWith('data:')) return null;

    if (normalized.startsWith('//')) {
        normalized = `https:${normalized}`;
    } else if (normalized.startsWith('/')) {
        normalized = `${getGuardoserieBaseUrl()}${normalized}`;
    } else if (!/^https?:\/\//i.test(normalized) && /(loadm|uqload|dropload)/i.test(normalized)) {
        normalized = `https://${normalized.replace(/^\/+/, '')}`;
    }

    return /^https?:\/\//i.test(normalized) ? normalized : null;
}

function normalizeTitleForMatch(value) {
    return String(value || '')
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace('iltronodispade', 'gameofthrones');
}

function buildSearchTitleCandidates(providerContext, ...titles) {
    const values = [...titles];
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

/**
 * Extract ALL player links from the episode HTML (multi-tab support).
 * Guardoserie uses `#player2 > div[id^="tab"]` tabs for ITA / SUB / different hosts.
 * Returns an array of { url, label } objects.
 */
function extractAllPlayerLinksFromHtml(html) {
    if (!html) return [];

    const players = [];

    // ── 1. Try extracting from numbered tabs (#tab1, #tab2, …) ──
    const tabRegex = /<div[^>]+id="tab(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]+id="tab\d+"|<\/div>\s*<\/div>\s*$)/gi;
    let tabMatch;
    while ((tabMatch = tabRegex.exec(html)) !== null) {
        const tabContent = tabMatch[2];
        const links = extractLinksFromBlock(tabContent);
        // Try to find a label for this tab (e.g., ITA, SUB, Loadm, Uqload)
        const labelMatch = html.match(new RegExp(`<a[^>]+href="#tab${tabMatch[1]}"[^>]*>([^<]+)<`, 'i'));
        const label = labelMatch ? labelMatch[1].trim() : null;
        for (const url of links) {
            players.push({ url, label });
        }
    }

    // ── 2. Fallback: extract ALL iframes from the full HTML ──
    if (players.length === 0) {
        const links = extractLinksFromBlock(html);
        for (const url of links) {
            players.push({ url, label: null });
        }
    }

    // Deduplicate by URL
    const seen = new Set();
    return players.filter(p => {
        if (seen.has(p.url)) return false;
        seen.add(p.url);
        return true;
    });
}

/** Extract player URLs from a block of HTML (iframes + direct regex) */
function extractLinksFromBlock(block) {
    const results = [];
    const iframeTags = block.match(/<iframe\b[^>]*>/ig) || [];
    for (const tag of iframeTags) {
        const attrRegex = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(tag)) !== null) {
            const candidate = normalizePlayerLink(attrMatch[2]);
            if (candidate) results.push(candidate);
        }
    }
    // Direct URL fallback (loadm, uqload, dropload outside iframes)
    if (results.length === 0) {
        const directRegexes = [
            /https?:\/\/(?:www\.)?(?:loadm|uqload|dropload)[^"'<\s]+/ig,
            /https?:\\\/\\\/(?:www\\.)?(?:loadm|uqload|dropload)[^"'<\s]+/ig
        ];
        for (const regex of directRegexes) {
            const matches = block.match(regex) || [];
            for (const raw of matches) {
                const candidate = normalizePlayerLink(raw);
                if (candidate) results.push(candidate);
            }
        }
    }
    return results;
}

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

async function getShowInfo(tmdbId, type) {
    try {
        const endpoint = type === 'movie' ? 'movie' : 'tv';
        const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=it-IT`;
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        console.error('[Guardoserie] TMDB error:', e);
        return null;
    }
}

async function getStreams(id, type, season, episode, providerContext = null) {
    try {
        let tmdbId = id;
        let effectiveSeason = Number.parseInt(String(season || ''), 10);
        if (!Number.isInteger(effectiveSeason) || effectiveSeason < 1) effectiveSeason = 1;
        let effectiveEpisode = Number.parseInt(String(episode || ''), 10);
        if (!Number.isInteger(effectiveEpisode) || effectiveEpisode < 1) effectiveEpisode = 1;
        const contextTmdbId = providerContext && /^\d+$/.test(String(providerContext.tmdbId || ''))
            ? String(providerContext.tmdbId)
            : null;
        const contextKitsuId = providerContext && /^\d+$/.test(String(providerContext.kitsuId || ''))
            ? String(providerContext.kitsuId)
            : null;
        const isExplicitKitsuRequest = id.toString().startsWith('kitsu:');
        const shouldIncludeSeasonHintForKitsu =
            providerContext && providerContext.seasonProvided === true;

        if (isExplicitKitsuRequest || contextKitsuId) {
            const kitsuId =
                contextKitsuId ||
                (((id.toString().match(/^kitsu:(\d+)/i) || [])[1]) || null);
            const seasonHintForKitsu = isExplicitKitsuRequest
                ? (shouldIncludeSeasonHintForKitsu ? season : null)
                : (effectiveSeason >= 1 ? effectiveSeason : null);
            const mapped = kitsuId ? await getIdsFromKitsu(kitsuId, seasonHintForKitsu, episode) : null;
            if (mapped && mapped.tmdbId) {
                tmdbId = mapped.tmdbId;
                console.log(`[Guardoserie] Kitsu ${kitsuId} mapped to TMDB ID ${tmdbId}`);
                if (mapped.mappedSeason && mapped.mappedEpisode) {
                    effectiveSeason = mapped.mappedSeason;
                    effectiveEpisode = mapped.mappedEpisode;
                    console.log(`[Guardoserie] Using TMDB episode mapping ${effectiveSeason}x${effectiveEpisode} (raw=${mapped.rawEpisodeNumber || 'n/a'})`);
                } else if (mapped.rawEpisodeNumber) {
                    effectiveEpisode = mapped.rawEpisodeNumber;
                    console.log(`[Guardoserie] Using mapped raw episode number ${effectiveEpisode}`);
                }
            } else {
                console.log(`[Guardoserie] No Kitsu->TMDB mapping found for ${kitsuId}`);
            }
        } else if (id.toString().startsWith('tt')) {
            if (contextTmdbId) {
                tmdbId = contextTmdbId;
                console.log(`[Guardoserie] Using prefetched TMDB ID ${tmdbId} for ${id}`);
            } else {
                // Need to convert IMDb to TMDB for title/year info
                const url = `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
                const response = await fetch(url);
                if (response.ok) {
                    const data = await response.json();
                    if (type === 'movie' && data.movie_results?.length > 0) tmdbId = data.movie_results[0].id;
                    else if ((type === 'series' || type === 'tv') && data.tv_results?.length > 0) tmdbId = data.tv_results[0].id;
                }
            }
        } else if (id.toString().startsWith('tmdb:')) {
            tmdbId = id.toString().replace('tmdb:', '');
        }

        const showInfo = await getShowInfo(tmdbId, type === 'movie' ? 'movie' : 'tv');
        if (!showInfo) return [];

        const title = showInfo.name || showInfo.original_name || showInfo.title || showInfo.original_title;
        const originalTitle = showInfo.original_title || showInfo.original_name;
        const year = (showInfo.first_air_date || showInfo.release_date || '').split('-')[0];
        const searchTitles = buildSearchTitleCandidates(providerContext, title, originalTitle);

        console.log(`[Guardoserie] Searching for: ${searchTitles.join(' / ')} (${year})`);

        // ── Strategy 0: Direct episode/movie URL construction ──────────────
        // DooPlay themes use predictable URL patterns. Try constructing the URL
        // directly to avoid the multi-step search→serie→episode chain.
        // This is crucial for Vercel where the CF Worker may be CF-blocked.
        const _buildSlugs = (titles) => {
            const seen = new Set();
            const slugs = [];
            for (const t of titles) {
                const slug = String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                if (slug && slug.length > 1 && !seen.has(slug)) {
                    seen.add(slug);
                    slugs.push(slug);
                }
            }
            return slugs;
        };
        const slugCandidates = _buildSlugs(searchTitles);

        let directEpisodeUrl = null;
        if ((type === 'tv' || type === 'series') && slugCandidates.length > 0) {
            const s = effectiveSeason;
            const e = effectiveEpisode;
            for (const slug of slugCandidates.slice(0, 3)) {
                const candidateUrl = `${getGuardoserieBaseUrl()}/episodio/${slug}-stagione-${s}-episodio-${e}/`;
                try {
                    const resp = await proxyFetch(candidateUrl, { headers: {
                        'User-Agent': USER_AGENT,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Referer': `${getGuardoserieBaseUrl()}/`
                    } });
                    if (!resp) continue; // circuit-breaker tripped
                    if (resp.ok) {
                        const html = await resp.text();
                        const players = extractAllPlayerLinksFromHtml(html);
                        if (players.length > 0) {
                            directEpisodeUrl = candidateUrl;
                            console.log(`[Guardoserie] Direct URL hit: ${candidateUrl} (${players.length} players)`);
                            // Extract streams directly from this page
                            const displayName = `${title} ${s}x${e}`;
                            let streams = [];
                            for (const { url: playerLink, label: tabLabel } of players) {
                                const langTag = tabLabel ? ` [${tabLabel}]` : '';
                                if (playerLink.includes('loadm')) {
                                    const domain = 'guardoserie.horse';
                                    const extracted = await extractLoadm(playerLink, domain);
                                    for (const st of (extracted || [])) {
                                        let quality = "HD";
                                        if (st.url.includes('.m3u8')) {
                                            const detected = await checkQualityFromPlaylist(st.url, st.headers || {});
                                            if (detected) quality = detected;
                                        }
                                        streams.push(formatStream({ url: st.url, headers: st.headers, name: `Guardoserie - Loadm${langTag}`, title: displayName, quality: getQualityFromName(quality), type: "direct", addonBaseUrl: providerContext?.addonBaseUrl, behaviorHints: st.behaviorHints }, 'Guardoserie'));
                                    }
                                } else if (playerLink.includes('uqload')) {
                                    const extracted = await extractUqload(playerLink);
                                    if (extracted?.url) {
                                        streams.push(formatStream({ url: extracted.url, headers: extracted.headers, name: `Guardoserie - Uqload${langTag}`, title: displayName, quality: getQualityFromName("HD"), type: "direct", addonBaseUrl: providerContext?.addonBaseUrl }, 'Guardoserie'));
                                    }
                                } else if (playerLink.includes('dropload')) {
                                    const extracted = await extractDropLoad(playerLink);
                                    if (extracted?.url) {
                                        let quality = "HD";
                                        if (extracted.url.includes('.m3u8')) {
                                            const detected = await checkQualityFromPlaylist(extracted.url, extracted.headers || {});
                                            if (detected) quality = detected;
                                        }
                                        streams.push(formatStream({ url: extracted.url, headers: extracted.headers, name: `Guardoserie - DropLoad${langTag}`, title: displayName, quality: getQualityFromName(quality), type: "direct", addonBaseUrl: providerContext?.addonBaseUrl }, 'Guardoserie'));
                                    }
                                }
                            }
                            if (streams.length > 0) {
                                const uniqueKeys = new Set();
                                return streams.filter(s => { const key = `${s.name}-${s.qualityTag || s.quality || 'HD'}`; if (uniqueKeys.has(key)) return false; uniqueKeys.add(key); return true; });
                            }
                        }
                    }
                } catch { /* direct URL miss */ }
            }
        }

        // Search helper – uses GET /?s= (the admin-ajax.php endpoint is broken)
        const searchProvider = async (query) => {
            const searchUrl = `${getGuardoserieBaseUrl()}/?s=${encodeURIComponent(query)}`;

            const response = await proxyFetch(searchUrl, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Referer': `${getGuardoserieBaseUrl()}/`
                }
            });

            if (!response || !response.ok) return [];
            const searchHtml = await response.text();
            const results = [];
            let match;

            // Pattern 0: <a> tags with title="" attr pointing to /serie/ (DooPlay poster/card links)
            const titleAttrRegex = /<a[^>]+href="(https?:\/\/[^"]*\/serie\/[^"]+)"[^>]+title="([^"]+)"[^>]*>/gi;
            while ((match = titleAttrRegex.exec(searchHtml)) !== null) {
                const rTitle = match[2].trim();
                if (rTitle) results.push({ url: match[1], title: rTitle });
            }

            // Pattern 1: links pointing to /serie/ pages (most common layout)
            // Also grab `title` attribute as fallback (inner text often contains quality badges or junk)
            const serieRegex = /<a[^>]+href="(https?:\/\/[^"]*\/serie\/[^"]+)"([^>]*)>(.*?)<\/a>/gi;
            while ((match = serieRegex.exec(searchHtml)) !== null) {
                let rTitle = match[3].replace(/<[^>]+>/g, '').trim();
                // Strip quality badges that get concatenated with the title
                rTitle = rTitle.replace(/^(?:FULL\s*HD|HD|SD|4K|CAM)\s*/i, '').trim();
                if (!rTitle) {
                    // Fallback: use title="" attribute from the <a> tag
                    const titleAttr = (match[2].match(/\btitle\s*=\s*"([^"]+)"/i) || [])[1];
                    if (titleAttr) rTitle = titleAttr.trim();
                }
                if (rTitle) results.push({ url: match[1], title: rTitle });
            }

            // Pattern 2: article titles with links (result-item or search-result blocks)
            if (results.length === 0) {
                const articleRegex = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*(?:ss-title|result-title|entry-title)[^"]*"[^>]*>(.*?)<\/a>/gi;
                while ((match = articleRegex.exec(searchHtml)) !== null) {
                    const rTitle = match[2].replace(/<[^>]+>/g, '').trim();
                    if (rTitle) results.push({ url: match[1], title: rTitle });
                }
            }

            // Pattern 3: any heading link inside known result containers
            if (results.length === 0) {
                const headingRegex = /<h[23][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
                while ((match = headingRegex.exec(searchHtml)) !== null) {
                    const rTitle = match[2].replace(/<[^>]+>/g, '').trim();
                    if (rTitle) results.push({ url: match[1], title: rTitle });
                }
            }

            // Deduplicate by URL within this single search call
            const seen = new Set();
            return results.filter(r => {
                if (seen.has(r.url)) return false;
                seen.add(r.url);
                return true;
            });
        };

        let allResults = [];
        const queries = searchTitles.filter(q => q && q.length > 2);
        for (const q of queries) {
            const res = await searchProvider(q);
            allResults.push(...res);
        }

        // Deduplicate results by URL (keep first occurrence — usually the featured result)
        const seenUrls = new Set();
        allResults = allResults.filter(r => {
            if (seenUrls.has(r.url)) return false;
            seenUrls.add(r.url);
            return true;
        });

        const decodeEntities = (str) => {
            return str.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
                      .replace(/&quot;/g, '"')
                      .replace(/&amp;/g, '&')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&#8211;/g, '-')
                      .replace(/&#8217;/g, "'");
        };

        // Sort results: exact matches first
        const norm = (s) => normalizeTitleForMatch(decodeEntities(s));
        const normalizedSearchTitles = searchTitles
            .map((value) => norm(value))
            .filter(Boolean);

        allResults.sort((a, b) => {
            const nA = norm(a.title);
            const nB = norm(b.title);
            const exactA = normalizedSearchTitles.includes(nA);
            const exactB = normalizedSearchTitles.includes(nB);
            if (exactA && !exactB) return -1;
            if (!exactA && exactB) return 1;
            return 0;
        });

        let targetUrl = null;
        // Limit to top 3 results to avoid Vercel timeout (each needs a proxyFetch)
        for (const result of allResults.slice(0, 3)) {
            // Check title match first to avoid unnecessary fetches
            const nResult = norm(result.title);

            const isExactMatch = normalizedSearchTitles.includes(nResult);
            const isPartialMatch = normalizedSearchTitles.some((candidate) =>
                candidate && (nResult.includes(candidate) || candidate.includes(nResult))
            );

            if (isExactMatch || isPartialMatch) {
                // Verify year in the page
                try {
                    const pageRes = await proxyFetch(result.url, { headers: { 
                        'User-Agent': USER_AGENT,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Referer': `${getGuardoserieBaseUrl()}/`
                    } });
                    if (!pageRes || !pageRes.ok) continue;
                    const pageHtml = await pageRes.text();

                    // Target the year specifically using regex
                    let foundYear = null;

                    // 1. Try "pubblicazione" link in page
                    const pubYearMatch = pageHtml.match(/pubblicazione.*?release-year\/(\d{4})/i);
                    if (pubYearMatch) {
                        foundYear = pubYearMatch[1];
                    }

                    // 2. Try meta tags (ISO date)
                    if (!foundYear) {
                        const metaDateMatch = pageHtml.match(/property="og:updated_time" content="(20\d{2})/i) || 
                                             pageHtml.match(/itemprop="datePublished" content="(20\d{2})/i) ||
                                             pageHtml.match(/content="(20\d{2})-\d{2}-\d{2}"/i);
                        if (metaDateMatch) {
                            foundYear = metaDateMatch[1];
                        }
                    }

                    // 3. Last resort: ANY release-year link
                    if (!foundYear) {
                        const anyYearMatch = pageHtml.match(/release-year\/(\d{4})/i);
                        if (anyYearMatch) {
                            foundYear = anyYearMatch[1];
                        }
                    }

                    if (foundYear) {
                        const targetYear = parseInt(year);
                        const fYear = parseInt(foundYear);
                        // If exact title match, be very lenient with year (sites often have wrong metadata)
                        const maxDiff = isExactMatch ? 10 : 1; 
                        if (fYear === targetYear || Math.abs(fYear - targetYear) <= maxDiff) {
                            targetUrl = result.url;
                            break;
                        }
                    } else {
                        // If no year found at all, accept if it's an exact title match
                        if (isExactMatch) {
                            targetUrl = result.url;
                            break;
                        }
                    }
                } catch (e) {
                    // If fetch fails, but title matches, we can still try it as fallback
                    targetUrl = result.url;
                    break;
                }
            }
        }

        if (!targetUrl) {
            // Fallback: try direct URL when search is blocked (e.g. Cloudflare challenge from datacenter IPs).
            // Guardoserie uses the slug pattern: /serie/{slug}/
            for (const q of queries) {
                const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                if (!slug) continue;
                const directUrl = `${getGuardoserieBaseUrl()}/serie/${slug}/`;
                try {
                    const directRes = await proxyFetch(directUrl, { headers: {
                        'User-Agent': USER_AGENT,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Referer': `${getGuardoserieBaseUrl()}/`
                    } });
                    if (directRes && directRes.ok) {
                        targetUrl = directUrl;
                        console.log(`[Guardoserie] Direct URL fallback matched: ${directUrl}`);
                        break;
                    }
                } catch { /* direct URL not found */ }
            }
        }

        if (!targetUrl) {
            console.log(`[Guardoserie] No matching result found for ${title}`);
            return [];
        }

        let episodeUrl = targetUrl;
        if (type === 'tv' || type === 'series') {
            season = effectiveSeason;
            episode = effectiveEpisode;
            const pageRes = await proxyFetch(targetUrl, { headers: { 
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': `${getGuardoserieBaseUrl()}/`
            } });
            if (!pageRes) return []; // circuit-breaker
            const pageHtml = await pageRes.text();
            const resolvedEpisodeUrl = extractEpisodeUrlFromSeriesPage(pageHtml, season, episode);
            if (resolvedEpisodeUrl) {
                episodeUrl = resolvedEpisodeUrl;
            } else {
                console.log(`[Guardoserie] Episode ${episode} not found in Season ${season} at ${targetUrl}`);
                return [];
            }
        }

        console.log(`[Guardoserie] Found episode/movie URL: ${episodeUrl}`);
        const finalRes = await proxyFetch(episodeUrl, { headers: { 
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': `${getGuardoserieBaseUrl()}/`
        } });
        if (!finalRes) return []; // circuit-breaker
        const finalHtml = await finalRes.text();

        let playerLinks = extractAllPlayerLinksFromHtml(finalHtml);

        // Safety fallback: if we are still on a /serie/ page, derive the episode URL and retry extraction.
        if (playerLinks.length === 0 && /\/serie\//i.test(episodeUrl)) {
            const fallbackEpisodeUrl = extractEpisodeUrlFromSeriesPage(finalHtml, season, episode);
            if (fallbackEpisodeUrl && fallbackEpisodeUrl !== episodeUrl) {
                console.log(`[Guardoserie] Fallback to derived episode URL: ${fallbackEpisodeUrl}`);
                const retryRes = await proxyFetch(fallbackEpisodeUrl, { headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Referer': `${getGuardoserieBaseUrl()}/`
                } });
                if (retryRes) {
                    const retryHtml = await retryRes.text();
                    const fallbackPlayerLinks = extractAllPlayerLinksFromHtml(retryHtml);
                    if (fallbackPlayerLinks.length > 0) {
                        playerLinks = fallbackPlayerLinks;
                        episodeUrl = fallbackEpisodeUrl;
                    }
                }
            }
        }

        if (playerLinks.length === 0) {
            console.log(`[Guardoserie] No player iframe found`);
            return [];
        }

        console.log(`[Guardoserie] Found ${playerLinks.length} player link(s): ${playerLinks.map(p => p.url).join(', ')}`);
        const displayName = (type === 'tv' || type === 'series') ? `${title} ${season}x${episode}` : title;
        let streams = [];

        for (const { url: playerLink, label: tabLabel } of playerLinks) {
            const langTag = tabLabel ? ` [${tabLabel}]` : '';

            if (playerLink.includes('loadm')) {
                const domain = 'guardoserie.horse';
                console.log(`[Guardoserie] Extracting Loadm: ${playerLink}`);
                const extracted = await extractLoadm(playerLink, domain);
                console.log(`[Guardoserie] Loadm extraction results: ${extracted?.length || 0}`);
                for (const s of (extracted || [])) {
                    const directLoadmUrl = s.url;
                    let quality = "HD";
                    if (s.url.includes('.m3u8')) {
                        const detected = await checkQualityFromPlaylist(directLoadmUrl, s.headers || {});
                        if (detected) quality = detected;
                    }
                    const normalizedQuality = getQualityFromName(quality);
                    streams.push(formatStream({
                        url: directLoadmUrl,
                        headers: s.headers,
                        name: `Guardoserie - Loadm${langTag}`,
                        title: displayName,
                        quality: normalizedQuality,
                        type: "direct",
                        addonBaseUrl: providerContext?.addonBaseUrl,
                        behaviorHints: s.behaviorHints
                    }, 'Guardoserie'));
                }
            } else if (playerLink.includes('uqload')) {
                const extracted = await extractUqload(playerLink);
                if (extracted && extracted.url) {
                    let quality = "HD";
                    const normalizedQuality = getQualityFromName(quality);
                    streams.push(formatStream({
                        url: extracted.url,
                        headers: extracted.headers,
                        name: `Guardoserie - Uqload${langTag}`,
                        title: displayName,
                        quality: normalizedQuality,
                        type: "direct",
                        addonBaseUrl: providerContext?.addonBaseUrl
                    }, 'Guardoserie'));
                }
            } else if (playerLink.includes('dropload')) {
                const extracted = await extractDropLoad(playerLink);
                if (extracted && extracted.url) {
                    let quality = "HD";
                    if (extracted.url.includes('.m3u8')) {
                        const detected = await checkQualityFromPlaylist(extracted.url, extracted.headers || {});
                        if (detected) quality = detected;
                    }
                    const normalizedQuality = getQualityFromName(quality);
                    streams.push(formatStream({
                        url: extracted.url,
                        headers: extracted.headers,
                        name: `Guardoserie - DropLoad${langTag}`,
                        title: displayName,
                        quality: normalizedQuality,
                        type: "direct",
                        addonBaseUrl: providerContext?.addonBaseUrl
                    }, 'Guardoserie'));
                }
            }
        }

        // Deduplicate streams by provider name + quality to avoid duplicate mirrors
        const uniqueKeys = new Set();
        return streams.filter(s => {
            const key = `${s.name}-${s.qualityTag || s.quality || 'HD'}`;
            if (uniqueKeys.has(key)) return false;
            uniqueKeys.add(key);
            return true;
        });
    } catch (e) {
        console.error(`[Guardoserie] Error:`, e);
        return [];
    } finally {
        // Close shared browser to free resources
        if (_sharedBrowser) {
            _sharedBrowser.close().catch(() => {});
            _sharedBrowser = null;
        }
    }
}

module.exports = { getStreams };
