const {
  USER_AGENT,
  extractPackedValue,
  getProxiedUrl,
  getRefererBase,
  normalizeExtractorUrl,
} = require('./common');
const { fetchWithCloudscraper, makeProxyAgent } = require('../utils/fetcher');
const { launchBrowser } = require('../utils/browser');
const { createLogger } = require('../utils/logger');
const axios = require('axios');

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const log = createLogger('supervideo');
const SHOULD_PREFER_BROWSER = !!(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NETLIFY ||
  String(process.env.BROWSERLESS_URL || '').trim()
);

// Only one browser session at a time – concurrent callers queue up
let _activeBrowserPromise = null;

/**
 * Pick a random Webshare proxy from WEBSHARE_PROXIES env var.
 * Format: comma-separated http://user:pass@host:port URLs
 */
function getWebshareProxy() {
  const raw = (process.env.WEBSHARE_PROXIES || '').trim();
  if (!raw) {
    log.warn('WEBSHARE_PROXIES not set');
    return null;
  }
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return null;
  const selected = list[Math.floor(Math.random() * list.length)];
  log.warn('selected webshare proxy', { proxy: selected.replace(/:[^:@]+@/, ':***@') });
  return selected;
}

/**
 * Quick HEAD check to verify a manifest URL is reachable from this server.
 * Browser-extracted URLs from Browserless carry IP-bound tokens that may 403
 * when the HLS proxy (running on a different Vercel IP) tries to fetch them.
 */
async function verifyManifestReachable(manifestUrl, headers) {
  try {
    const resp = await fetch(manifestUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': (headers && headers['User-Agent']) || USER_AGENT,
        ...(headers && headers['Referer'] ? { 'Referer': headers['Referer'] } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(6_000),
    });
    if (resp.ok || resp.status === 206) return true;
    log.warn('manifest verification failed', { manifestUrl, status: resp.status });
    return false;
  } catch (err) {
    log.warn('manifest verification error', { manifestUrl, error: err.message });
    return false;
  }
}

function buildSuperVideoEmbedUrl(url) {
  const normalized = normalizeExtractorUrl(url);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    let id = parts[parts.length - 1];
    const markerIndex = parts.findIndex((part) => part === 'e' || part === 'y');
    if (markerIndex !== -1 && parts[markerIndex + 1]) {
      id = parts[markerIndex + 1];
    }

    id = String(id || '').trim();
    if (!id) return null;
    return `https://supervideo.tv/e/${id}`;
  } catch {
    return null;
  }
}

function extractDirectManifestUrl(html) {
  if (!html) return null;

  const patterns = [
    /sources\s*:\s*\[\s*\{\s*file\s*:\s*"([^"]+master\.m3u8[^"]*)"/i,
    /sources\s*:\s*\[\s*\{\s*file\s*:\s*'([^']+master\.m3u8[^']*)'/i,
    /["'`](https?:\/\/[^"'`\s]+master\.m3u8[^"'`\s]*)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1].replace(/\\\//g, '/');
    }
  }

  return null;
}

function buildPackedManifestUrl(htmlToParse) {
  if (!htmlToParse) return null;
  const m = htmlToParse.match(/}\('(.+?)',.+,'(.+?)'\.split/);
  if (!m) return null;
  const terms = m[2].split('|');
  const fileIndex = terms.indexOf('file');
  if (fileIndex === -1) return null;

  let hfs = '';
  for (let i = fileIndex; i < terms.length; i += 1) {
    if (terms[i].includes('hfs')) {
      hfs = terms[i];
      break;
    }
  }
  if (!hfs) return null;

  const urlsetIndex = terms.indexOf('urlset');
  const hlsIndex = terms.indexOf('hls2') !== -1 ? terms.indexOf('hls2') : terms.indexOf('hls');
  if (urlsetIndex === -1 || hlsIndex === -1 || hlsIndex <= urlsetIndex) return null;

  const reversed = terms.slice(urlsetIndex + 1, hlsIndex).reverse();
  if (!reversed.length) return null;

  const pathParts = reversed.slice(0, -1);
  const tailPart = reversed[reversed.length - 1];
  const base = `https://${hfs}.serversicuro.cc/${terms[hlsIndex]}`;
  const pathPrefix = pathParts.length ? `/${pathParts.join('/')}` : '';

  return `${base}${pathPrefix}/,${tailPart},.urlset/master.m3u8`;
}

function getPlaybackReferer(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return 'https://supervideo.cc/';
  }
}

function shouldTryBrowserManifest(url) {
  return Boolean(url)
    && /serversicuro\.cc/i.test(url)
    && !/[?&](?:token|expires|t|s|e|sp)=/i.test(url);
}

async function resolveWithBrowser(embedUrl, refererBase, wsProxy) {
  // Only one browser session at a time – concurrent callers skip immediately
  if (_activeBrowserPromise) {
    log.warn('skipping browser – another session already active', { embedUrl });
    return null;
  }
  const doResolve = async () => {
  log.warn('trying browser fallback', { embedUrl, withProxy: !!wsProxy });
  const browserResult = await fetchWithBrowser(embedUrl, refererBase, wsProxy);
  const browserHtml = browserResult && browserResult.html;
  const browserReferer = getPlaybackReferer((browserResult && browserResult.finalUrl) || embedUrl);

  log.warn('browser result', {
    embedUrl,
    finalUrl: browserResult && browserResult.finalUrl,
    hasManifestUrl: Boolean(browserResult && browserResult.manifestUrl),
    hasHtml: Boolean(browserHtml),
    htmlLength: browserHtml ? browserHtml.length : 0,
  });

  if (browserResult && browserResult.manifestUrl) {
    log.warn('browser manifest captured', {
      manifestUrl: browserResult.manifestUrl,
      referer: browserReferer,
      proxyUsed: !!wsProxy,
      hasManifestBody: Boolean(browserResult.manifestBody),
    });
    return {
      url: browserResult.manifestUrl,
      headers: { "User-Agent": USER_AGENT, "Referer": browserReferer },
      proxyUrl: wsProxy || undefined,
      manifestBody: browserResult.manifestBody || undefined,
    };
  }

  if (browserHtml && !browserHtml.includes("Just a moment") && !browserHtml.includes("cf-wrapper")) {
    const browserExactManifest = extractDirectManifestUrl(browserHtml);
    if (browserExactManifest) {
      log.warn('browser exact manifest from html', {
        manifestUrl: browserExactManifest,
        referer: browserReferer,
      });
      return {
        url: browserExactManifest,
        headers: { "User-Agent": USER_AGENT, "Referer": browserReferer },
        proxyUrl: wsProxy || undefined,
      };
    }

    const browserStreamvixUrl = buildPackedManifestUrl(browserHtml);
    if (browserStreamvixUrl) {
      log.warn('browser packed manifest fallback', {
        manifestUrl: browserStreamvixUrl,
        referer: browserReferer,
      });
      return { url: browserStreamvixUrl, headers: { "User-Agent": USER_AGENT, "Referer": browserReferer }, proxyUrl: wsProxy || undefined };
    }

    const browserPacked = extractPackedValue(browserHtml, [
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*'([^']+)'/i,
    ]);
    if (browserPacked && browserPacked.value) {
      const finalUrl = normalizeExtractorUrl(browserPacked.value, embedUrl);
      if (finalUrl) {
        log.warn('browser packed direct file', {
          finalUrl,
          referer: browserReferer,
        });
        return { url: finalUrl, headers: { "User-Agent": USER_AGENT, "Referer": browserReferer }, proxyUrl: wsProxy || undefined };
      }
    }

    const browserM3u8 = browserHtml.match(/["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)/i);
    if (browserM3u8) {
      const finalUrl = normalizeExtractorUrl(browserM3u8[1], embedUrl);
      if (finalUrl) {
        log.warn('browser regex m3u8 fallback', {
          finalUrl,
          referer: browserReferer,
        });
        return { url: finalUrl, headers: { "User-Agent": USER_AGENT, "Referer": browserReferer }, proxyUrl: wsProxy || undefined };
      }
    }
  }

  log.warn('browser fallback produced no playable url', {
    embedUrl,
    finalUrl: browserResult && browserResult.finalUrl,
  });
  return null;
  }; // end doResolve
  _activeBrowserPromise = doResolve();
  try {
    return await _activeBrowserPromise;
  } finally {
    _activeBrowserPromise = null;
  }
}

async function extractSuperVideo(url, options = {}) {
  try {
    const embedUrl = buildSuperVideoEmbedUrl(url);
    if (!embedUrl) return null;

    let refererBase = typeof options === 'string' ? options : options.refererBase;
    if (!refererBase) refererBase = getRefererBase(embedUrl, "https://supervideo.tv/");
    const proxyUrl = typeof options === 'object' ? String(options.proxyUrl || '').trim() : '';

    // Pick a Webshare proxy for this extraction (used for HTTP fetch + browser + HLS proxy)
    const wsProxy = getWebshareProxy();

    // Fetch embed page via wsProxy directly (not CF Worker).
    // This ensures the HLS token is IP-locked to the wsProxy IP,
    // matching what the HLS proxy uses for playback.
    const proxiedUrl = getProxiedUrl(embedUrl);

    let html;
    let responseStatus;
    if (wsProxy) {
      const agent = makeProxyAgent(wsProxy);
      try {
        const resp = await axios.get(embedUrl, {
          headers: { "User-Agent": USER_AGENT, "Referer": refererBase },
          timeout: 8_000,
          httpsAgent: agent, httpAgent: agent, proxy: false,
        });
        html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
        responseStatus = resp.status;
      } catch (err) {
        // wsProxy blocked by Cloudflare — try CF Worker (quality may be wrong but URL is valid)
        log.warn('wsProxy embed fetch failed, trying CF Worker', { embedUrl, error: err.message });
        try {
          const resp = await axios.get(proxiedUrl, {
            headers: { "User-Agent": USER_AGENT, "Referer": refererBase },
            timeout: 8_000,
          });
          html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
          responseStatus = resp.status;
        } catch (err2) {
          // Both failed — try browser with wsProxy
          log.warn('CF Worker embed fetch also failed, trying browser', { embedUrl, error: err2.message });
          try {
            const browserResolved = await resolveWithBrowser(embedUrl, refererBase, wsProxy);
            if (browserResolved) return browserResolved;
          } catch (browserErr) {
            log.error('browser fallback error', { embedUrl, error: browserErr.message });
          }
          return null;
        }
      }
    } else {
      // No Webshare proxy — try CF Worker, then fall back to PROXY_URL env
      try {
        const resp = await axios.get(proxiedUrl, {
          headers: { "User-Agent": USER_AGENT, "Referer": refererBase },
          timeout: 8_000,
        });
        html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
        responseStatus = resp.status;
      } catch (err) {
        log.warn('CF Worker embed fetch failed (no wsProxy), trying PROXY_URL fallback', { embedUrl, error: err.message });
        // Fallback: use PROXY_URL env var if available
        const envProxy = (process.env.PROXY_URL || process.env.PROXY || '').trim();
        if (envProxy) {
          try {
            const fallbackAgent = makeProxyAgent(envProxy);
            const resp = await axios.get(embedUrl, {
              headers: { "User-Agent": USER_AGENT, "Referer": refererBase },
              timeout: 8_000,
              httpsAgent: fallbackAgent, httpAgent: fallbackAgent, proxy: false,
            });
            html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
            responseStatus = resp.status;
          } catch (err2) {
            log.warn('PROXY_URL fallback also failed', { embedUrl, error: err2.message });
            return null;
          }
        } else {
          return null;
        }
      }
    }

    let exactManifestUrl = extractDirectManifestUrl(html);
    if (exactManifestUrl) {
      log.warn('direct manifest from initial html', {
        embedUrl,
        manifestUrl: exactManifestUrl,
      });
      return {
        url: exactManifestUrl,
        headers: { "User-Agent": USER_AGENT, "Referer": getPlaybackReferer(embedUrl) },
        proxyUrl: wsProxy || undefined,
      };
    }

    // Full unpack: extracts the actual URL with tokens (like EasyStreams does).
    // Try this BEFORE buildPackedManifestUrl which constructs tokenless URLs.
    const packedResult = extractPackedValue(html, [
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*'([^']+)'/i,
    ]);
    if (packedResult && packedResult.value) {
      const packedUrl = normalizeExtractorUrl(packedResult.value, embedUrl);
      if (packedUrl && /\.m3u8/i.test(packedUrl)) {
        log.warn('full unpack manifest from initial html', {
          embedUrl,
          manifestUrl: packedUrl,
        });
        return {
          url: packedUrl,
          headers: { "User-Agent": USER_AGENT, "Referer": getPlaybackReferer(embedUrl) },
          proxyUrl: wsProxy || undefined,
        };
      }
    }

    let streamvixUrl = buildPackedManifestUrl(html);
    if (streamvixUrl) {
        log.warn('packed manifest from initial html', {
          embedUrl,
          manifestUrl: streamvixUrl,
          requiresBrowser: shouldTryBrowserManifest(streamvixUrl),
        });
        if (shouldTryBrowserManifest(streamvixUrl)) {
          try {
            const browserResolved = await resolveWithBrowser(embedUrl, refererBase, wsProxy);
            if (browserResolved) return browserResolved;
          } catch (browserErr) {
            log.error('browser fallback error', { embedUrl, error: browserErr.message });
          }
          log.warn('returning external fallback after unresolved browser-required manifest', {
            embedUrl,
            manifestUrl: streamvixUrl,
          });
          return { url: embedUrl, name: 'SuperVideo', isExternal: true };
        }
        return { url: streamvixUrl, headers: { "User-Agent": USER_AGENT, "Referer": getPlaybackReferer(embedUrl) }, proxyUrl: wsProxy || undefined };
    }

    if (html.includes("Cloudflare") || responseStatus === 403 || responseStatus === 429) {
      console.log(`[Extractors] SuperVideo (tv) returned 403/Cloudflare, retrying with cloudscraper rotated UAs`);

      if (SHOULD_PREFER_BROWSER) {
        log.warn('preferring browser fallback after initial cloudflare response', {
          embedUrl,
          status: responseStatus,
        });
        try {
          const browserResolved = await resolveWithBrowser(embedUrl, refererBase, wsProxy);
          if (browserResolved) return browserResolved;
        } catch (browserErr) {
          log.error('browser fallback error', { embedUrl, error: browserErr.message });
        }
      }
      
      const proxiesListReq = require('fs').existsSync(require('path').join(__dirname, '../../proxies.json')) ? require('../../proxies.json') : [];
      let dynamicProxy = (proxiesListReq && proxiesListReq.length > 0) ? proxiesListReq[Math.floor(Math.random() * proxiesListReq.length)] : proxyUrl;
      
      // Use a short timeout when no proxy is available to avoid blocking other extractors for too long.
      // With a real rotating proxy the extra time is worth it; without one cloudscraper won't help anyway.
      const csTimeout = dynamicProxy ? 12_000 : 4_000;
      const csRetries = dynamicProxy ? 2 : 1;
      html = await fetchWithCloudscraper(embedUrl, {
        retries: csRetries,
        timeout: csTimeout,
        referer: refererBase,
        proxyUrl: dynamicProxy,
      });

      exactManifestUrl = extractDirectManifestUrl(html);
      if (exactManifestUrl) {
        log.warn('direct manifest from cloudscraper html', {
          embedUrl,
          manifestUrl: exactManifestUrl,
        });
        return {
          url: exactManifestUrl,
          headers: { "User-Agent": USER_AGENT, "Referer": getPlaybackReferer(embedUrl) },
          proxyUrl: wsProxy || undefined,
        };
      }

      streamvixUrl = buildPackedManifestUrl(html);
      if (streamvixUrl) {
          log.warn('packed manifest from cloudscraper html', {
            embedUrl,
            manifestUrl: streamvixUrl,
            requiresBrowser: shouldTryBrowserManifest(streamvixUrl),
          });
          if (shouldTryBrowserManifest(streamvixUrl)) {
            try {
              const browserResolved = await resolveWithBrowser(embedUrl, refererBase, wsProxy);
              if (browserResolved) return browserResolved;
            } catch (browserErr) {
              log.error('browser fallback error', { embedUrl, error: browserErr.message });
            }
            log.warn('returning external fallback after unresolved browser-required manifest', {
              embedUrl,
              manifestUrl: streamvixUrl,
            });
            return { url: embedUrl, name: 'SuperVideo', isExternal: true };
          }
          return { url: streamvixUrl, headers: { "User-Agent": USER_AGENT, "Referer": getPlaybackReferer(embedUrl) }, proxyUrl: wsProxy || undefined };
      }

      if (!html || html.includes("Cloudflare") || html.includes("Just a moment")) {
        try {
          const browserResolved = await resolveWithBrowser(embedUrl, refererBase, wsProxy);
          if (browserResolved) return browserResolved;
        } catch (browserErr) {
          log.error('browser fallback error', { embedUrl, error: browserErr.message });
        }
        console.log(`[Extractors] SuperVideo all fallbacks failed, returning external url`);
        return {
          url: embedUrl,
          name: 'SuperVideo',
          isExternal: true
        };
      }
    }

    const packed = extractPackedValue(html, [
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*"([^"]+)"/i,
      /file\s*:\s*'([^']+)'/i,
    ]);

    if (packed && packed.value) {
      const finalUrl = normalizeExtractorUrl(packed.value, embedUrl);
      if (!finalUrl) return null;
      return {
        url: finalUrl,
        headers: {
          "User-Agent": USER_AGENT,
          "Referer": "https://supervideo.tv/"
        },
        proxyUrl: wsProxy || undefined,
      };
    }

    // Fallback: direct regex search for any .m3u8 URL in the HTML
    const directM3u8 = html.match(/["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)/i);
    if (directM3u8) {
      const finalUrl = normalizeExtractorUrl(directM3u8[1], embedUrl);
      if (finalUrl) {
        return {
          url: finalUrl,
          headers: { "User-Agent": USER_AGENT, "Referer": "https://supervideo.tv/" },
          proxyUrl: wsProxy || undefined,
        };
      }
    }

    return null;
  } catch (e) {
    console.error("[Extractors] SuperVideo extraction error:", e);
    return null;
  }
}

/**
 * Wrapper that filters out serversicuro URLs in serverless environments.
 * serversicuro.cc manifest tokens are IP-locked: the extraction function
 * runs on instance A (IP X), but the HLS proxy that later serves the
 * video may run on instance B (IP Y) → 403.  On a fixed-IP server this
 * would work; on Vercel/Lambda it never does.
 */
async function extractSuperVideoValidated(url, options = {}) {
  const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
  const result = await extractSuperVideo(url, options);
  if (!result || result.isExternal) return result;
  // serversicuro URLs are OK if a proxy is attached (same IP for extraction & playback)
  if (result.proxyUrl) return result;
  // On serverless without proxy, serversicuro tokens are IP-locked → discard
  if (IS_SERVERLESS && result.url && /serversicuro\.cc/i.test(result.url)) {
    log.warn('discarding serversicuro URL on serverless (IP-locked token, no proxy)', {
      url: result.url,
    });
    return null;
  }
  return result;
}

async function fetchWithBrowser(url, refererBase, proxyUrl) {
  // Hard timeout to prevent the entire browser session from exceeding Vercel's function limit.
  // Uses a shared browser reference so the timeout can force-close it.
  const HARD_TIMEOUT_MS = 40_000;
  let browserRef = null;
  const setBrowser = (b) => { browserRef = b; };

  return Promise.race([
    _doFetchWithBrowser(url, refererBase, proxyUrl, setBrowser),
    new Promise((resolve) => setTimeout(async () => {
      log.warn('fetchWithBrowser hard timeout — closing browser', { url, timeoutMs: HARD_TIMEOUT_MS });
      if (browserRef) {
        try { await browserRef.close(); } catch {}
      }
      resolve(null);
    }, HARD_TIMEOUT_MS)),
  ]);
}

async function _doFetchWithBrowser(url, refererBase, proxyUrl, setBrowser) {
  let browser = null;
  try {
    const t0 = Date.now();
    log.warn('fetchWithBrowser starting', { url, proxyUrl: proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ':***@') : 'none' });
    browser = await launchBrowser(proxyUrl ? { proxyUrl } : {});
    if (setBrowser) setBrowser(browser);
    log.warn('browser launched', { ms: Date.now() - t0 });
    const page = await browser.newPage();
    // Authenticate proxy if browser was launched with one
    if (browser._proxyAuth) {
      await page.authenticate(browser._proxyAuth);
    }
    log.warn('page created + auth', { ms: Date.now() - t0 });
    let manifestUrl = null;
    let manifestBodyPromise = null;
    let manifestResponseOk = false;
    await page.setUserAgent(BROWSER_USER_AGENT);
    if (refererBase) {
      await page.setExtraHTTPHeaders({ Referer: refererBase });
    }
    page.on('request', (request) => {
      const requestUrl = request.url();
      if (!manifestUrl && /master\.m3u8/i.test(requestUrl)) {
        manifestUrl = requestUrl;
      }
    });
    page.on('response', (response) => {
      const responseUrl = response.url();
      if (/master\.m3u8/i.test(responseUrl)) {
        if (!manifestUrl) manifestUrl = responseUrl;
        const status = response.status();
        if (status >= 200 && status < 400) {
          manifestResponseOk = true;
          if (!manifestBodyPromise) {
            manifestBodyPromise = response.text().catch(() => null);
          }
        } else {
          // CDN returned error (e.g. 404) — this URL is invalid
          log.warn('manifest response not OK, clearing URL', { responseUrl, status });
          manifestUrl = null;
          manifestResponseOk = false;
        }
      }
    });

    const manifestResponsePromise = page.waitForResponse(
      (response) => /master\.m3u8/i.test(response.url()),
      { timeout: 8_000 }
    ).then(async (response) => {
      const status = response.status();
      if (status >= 200 && status < 400) {
        return {
          url: response.url(),
          body: await response.text().catch(() => null),
        };
      }
      return null;
    }).catch(() => null);

    // Helper: ensure manifest body is available (syncs request/response race)
    async function getManifestBody() {
      if (manifestBodyPromise) return manifestBodyPromise;
      // Response event hasn't fired yet — wait for it via waitForResponse
      const result = await manifestResponsePromise;
      if (result && result.body) return result.body;
      // Fallback: check if response handler set it while we waited
      return manifestBodyPromise ? await manifestBodyPromise : null;
    }

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 12_000,
    });
    log.warn('page goto done', { ms: Date.now() - t0, manifestUrl: !!manifestUrl });

    // If manifest was captured during page load, wait for response status check
    if (manifestUrl) {
      // Wait for the response to arrive (the request was captured, but we need the response status)
      const responseResult = await Promise.race([
        manifestResponsePromise,
        new Promise(r => setTimeout(() => r('timeout'), 5000))
      ]);
      // Re-check manifestUrl — the response handler may have cleared it on 404
      if (manifestUrl && manifestResponseOk) {
        log.warn('manifest already captured during load, skipping play interactions', { ms: Date.now() - t0, manifestUrl });
        const manifestBody = await getManifestBody();
        const html = await page.content().catch(() => '');
        const finalUrl = page.url();
        await page.close().catch(() => {});
        return { html, manifestUrl, manifestBody, finalUrl };
      }
      if (!manifestUrl) {
        log.warn('manifest request was 404, continuing with play interactions', { ms: Date.now() - t0 });
      }
    }

    // Detect Cloudflare challenge early — don't waste time on play interactions
    const earlyHtml = await page.content().catch(() => '');
    if (earlyHtml.length < 15000 && /Attention Required|Just a moment|cf-wrapper|cloudflare/i.test(earlyHtml)) {
      log.warn('Cloudflare challenge detected, aborting', { ms: Date.now() - t0, htmlLen: earlyHtml.length });
      await page.close().catch(() => {});
      return null;
    }

    // Wait for JWPlayer to be fully initialised before interacting
    await page.waitForFunction(() => {
      return typeof window.jwplayer === 'function' && window.jwplayer() && window.jwplayer().getState;
    }, { timeout: 5_000 }).catch(() => null);
    log.warn('jwplayer wait done', { ms: Date.now() - t0, manifestUrl: !!manifestUrl });

    // If manifest captured during JWPlayer initialization
    if (manifestUrl && manifestResponseOk) {
      log.warn('manifest captured during jwplayer init', { ms: Date.now() - t0, manifestUrl });
      const manifestBody = await getManifestBody();
      const html = await page.content().catch(() => '');
      const finalUrl = page.url();
      await page.close().catch(() => {});
      return { html, manifestUrl, manifestBody, finalUrl };
    }

    // Try programmatic play first (most reliable)
    await page.evaluate(() => {
      try {
        if (typeof window.jwplayer === 'function') {
          const p = window.jwplayer();
          if (p && typeof p.play === 'function') {
            p.setMute(true);
            p.play();
            return;
          }
        }
      } catch {}
      // Fallback: click player elements
      const selectors = [
        '.jw-display-icon-container',
        '.jw-icon-display',
        '.jwplayer',
        '.jw-media',
        '#player',
        'video',
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && typeof el.click === 'function') { el.click(); break; }
      }
    }).catch(() => null);

    await page.mouse.click(640, 360).catch(() => null);

    // Second attempt after a short delay
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => {
      try {
        if (typeof window.jwplayer === 'function') {
          const p = window.jwplayer();
          if (p && typeof p.play === 'function' && p.getState() !== 'playing') {
            p.play();
          }
        }
      } catch {}
      const video = document.querySelector('video');
      if (video && typeof video.play === 'function') {
        video.muted = true;
        return video.play().catch(() => null);
      }
      return null;
    }).catch(() => null);

    await page.waitForFunction(() => {
      const resources = performance.getEntriesByType('resource') || [];
      if (resources.some((entry) => /master\.m3u8/i.test(entry.name))) {
        return true;
      }

      const video = document.querySelector('video');
      if (video && video.currentSrc && /m3u8|blob:/i.test(video.currentSrc)) {
        return true;
      }

      try {
        if (typeof window.jwplayer === 'function') {
          const player = window.jwplayer();
          if (player && typeof player.getPlaylistItem === 'function') {
            const item = player.getPlaylistItem();
            if (item && typeof item.file === 'string' && /master\.m3u8/i.test(item.file)) {
              return true;
            }
          }
        }
      } catch {
        return false;
      }

      return false;
    }, { timeout: 8_000 }).catch(() => null);

    if (!manifestUrl || !manifestResponseOk) {
      const responseResult = await manifestResponsePromise;
      if (responseResult) {
        manifestUrl = responseResult.url;
        manifestResponseOk = true;
        if (!manifestBodyPromise && responseResult.body) {
          manifestBodyPromise = Promise.resolve(responseResult.body);
        }
      }
    }

    if (!manifestUrl) {
      manifestUrl = await page.evaluate(() => {
        const resources = performance.getEntriesByType('resource') || [];
        const manifestEntry = resources.find((entry) => /master\.m3u8/i.test(entry.name));
        if (manifestEntry) return manifestEntry.name;

        const video = document.querySelector('video');
        if (video && video.currentSrc && /m3u8/i.test(video.currentSrc)) {
          return video.currentSrc;
        }

        try {
          if (typeof window.jwplayer === 'function') {
            const player = window.jwplayer();
            if (player && typeof player.getPlaylistItem === 'function') {
              const item = player.getPlaylistItem();
              if (item && typeof item.file === 'string' && /m3u8/i.test(item.file)) {
                return item.file;
              }
            }
          }
        } catch {
          return null;
        }

        return null;
      }).catch(() => null);
    }

    const manifestBody = await getManifestBody();
    const html = await page.content();
    const finalUrl = page.url();
    log.warn('browser page summary', {
      url,
      finalUrl,
      manifestUrl,
      hasManifestBody: Boolean(manifestBody),
      htmlLength: html.length,
    });
    await page.close().catch(() => {});
    return { html, manifestUrl, manifestBody, finalUrl };
  } catch (error) {
    log.error('browser fallback error', { url, error: error.message });
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { extractSuperVideo: extractSuperVideoValidated };
