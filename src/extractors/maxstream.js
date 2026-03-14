'use strict';

const { USER_AGENT } = require('./common');
const { launchBrowser, applyStealthEvasions } = require('../utils/browser');
const { proxyFetch } = require('../utils/proxy');

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Alias for the smart proxy fetch
const _proxyFetch = proxyFetch;

// ─── Extract video URL from HTML (shared between HTTP & browser paths) ────────
function _extractVideoUrlFromHtml(html, pageUrl) {
  const primaryMatch = /sources\W+src\W+(https?:\/\/[^"']+)["']/i.exec(html);
  if (primaryMatch && primaryMatch[1]) {
    return primaryMatch[1].trim();
  }
  const fallbackMatch = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/i.exec(html);
  if (fallbackMatch && fallbackMatch[1] && fallbackMatch[1].startsWith('http')) {
    return fallbackMatch[1].trim();
  }
  return null;
}

// ─── Browser-based extraction (Cloudflare bypass) ─────────────────────────────
// Uses Puppeteer + stealth + residential proxy.
// Handles the full chain: uprots redirect → watchfree → emvvv → video URL.
async function _extractViaBrowser(url) {
  let browser;
  try {
    const proxyUrl = (process.env.PROXY_URL || '').trim() || undefined;
    browser = await launchBrowser(proxyUrl ? { proxyUrl } : {});
    const page = await browser.newPage();
    await applyStealthEvasions(page);
    if (browser._proxyAuth) await page.authenticate(browser._proxyAuth);
    await page.setUserAgent(UA_DESKTOP);

    // Intercept requests to catch .m3u8 directly from the player
    let m3u8Url = null;
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (!m3u8Url && /\.m3u8/i.test(u)) m3u8Url = u;
      req.continue().catch(() => {});
    });

    console.log('[MaxStream] Browser: navigating to', url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    // Wait for Cloudflare challenge if detected
    let finalUrl = page.url();
    let title = await page.title();
    if (/just a moment|cloudflare/i.test(title)) {
      console.log('[MaxStream] Browser: CF challenge, waiting...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      finalUrl = page.url();
    }

    // If redirected to watchfree URL → construct emvvv embed URL
    if (finalUrl.includes('watchfree')) {
      const parts = finalUrl.split('/');
      const wfIdx = parts.indexOf('watchfree');
      if (wfIdx >= 0 && parts[wfIdx + 2]) {
        const emvvvUrl = `https://maxstream.video/emvvv/${parts[wfIdx + 2]}`;
        console.log('[MaxStream] Browser: watchfree →', emvvvUrl);
        await page.goto(emvvvUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        title = await page.title();
        if (/just a moment|cloudflare/i.test(title)) {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        }
      }
    }

    // Check intercepted .m3u8 first
    if (m3u8Url) {
      console.log('[MaxStream] Browser: intercepted m3u8:', m3u8Url);
      return { url: m3u8Url, headers: { 'User-Agent': UA_DESKTOP, 'Referer': 'https://maxstream.video/' } };
    }

    // Wait for player to initialize and potentially request m3u8
    await new Promise(r => setTimeout(r, 3000));
    if (m3u8Url) {
      console.log('[MaxStream] Browser: intercepted m3u8 (delayed):', m3u8Url);
      return { url: m3u8Url, headers: { 'User-Agent': UA_DESKTOP, 'Referer': 'https://maxstream.video/' } };
    }

    // Fallback: extract from page HTML
    const html = await page.content();
    const videoUrl = _extractVideoUrlFromHtml(html, finalUrl);
    if (videoUrl) {
      console.log('[MaxStream] Browser: extracted from HTML:', videoUrl.substring(0, 80));
      return { url: videoUrl, headers: { 'User-Agent': UA_DESKTOP, 'Referer': 'https://maxstream.video/' } };
    }

    console.log('[MaxStream] Browser: no video found (page:', html.length, 'bytes, url:', page.url(), ')');
    return null;
  } catch (e) {
    console.error('[MaxStream] Browser error:', e.message);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Extract a direct video stream URL from a MaxStream page.
 * Tries fast HTTP first; falls back to headless browser on Cloudflare block.
 * Also handles uprots redirect URLs (browser follows the full chain).
 * @param {string} url  MaxStream URL (emvvv, uprots, or direct)
 * @returns {Promise<{url:string, headers:object}|null>}
 */
async function extractMaxStream(url) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl.startsWith('http')) return null;

  // ── Fast path: HTTP fetch ─────────────────────────────────────────────────
  try {
    const resp = await _proxyFetch(normalizedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (resp.status === 503 || resp.status === 403) {
      await resp.text().catch(() => {});
      console.log('[MaxStream] HTTP blocked (' + resp.status + '), trying browser...');
      return _extractViaBrowser(normalizedUrl);
    }

    if (!resp.ok) return null;
    const html = await resp.text();

    const videoUrl = _extractVideoUrlFromHtml(html, normalizedUrl);
    if (videoUrl) {
      const origin = new URL(normalizedUrl).origin;
      return { url: videoUrl, headers: { 'User-Agent': USER_AGENT, 'Referer': `${origin}/` } };
    }

    return null;
  } catch (e) {
    // Network/timeout error — try browser as last resort
    console.log('[MaxStream] HTTP error (' + e.message + '), trying browser...');
    return _extractViaBrowser(normalizedUrl);
  }
}

module.exports = { extractMaxStream };
