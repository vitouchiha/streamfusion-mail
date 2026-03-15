'use strict';

/**
 * Uprot.net → MaxStream resolver.
 *
 * Strategy:
 * 1. POST to uprot init URL → get PHPSESSID + captcha image (base64 embedded).
 * 2. Per-digit segmentation + CF Worker AI OCR → get 3-digit answer.
 * 3. POST captcha answer with cookies → get captcha hash cookie (success indicator).
 * 4. Cache cookies for ~22h.
 * 5. For each uprot link: POST with cached cookies → find REAL link (buttok button,
 *    NOT the decoy empty <a> tags) → follow uprots redirect → MaxStream.
 * 6. Extract video URL from MaxStream page.
 *
 * uprot.net accepts direct connections (no proxy needed).
 * Only the CF Worker is used for AI-based captcha OCR.
 */

const { extractMaxStream } = require('./maxstream');
const { decodePngGrayscale, ocrDigitsFromPixels, encodePngGrayscale, preprocessCaptcha } = require('../utils/ocr');
const { proxyFetch } = require('../utils/proxy');

const UPROT_INIT_URL = 'https://uprot.net/msf/r4hcq47tarq8';
const COOKIE_TTL = 22 * 3600 * 1000; // 22h
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const CF_WORKER_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';

// Alias for the smart proxy fetch (tries multiple proxy IPs on failure)
const _proxyFetch = proxyFetch;

// Cookie cache per path type (/msf/, /msei/, etc.)
let _cookieCache = {}; // { '/msf/': { sessid, captchaHash, captchaAnswer, ts }, ... }
let _kvCacheLoaded = false; // Whether we've tried loading from KV on this instance

function _getPathType(url) {
  const m = String(url).match(/uprot\.net\/(ms[a-z]+)\//);
  const raw = m ? `/${m[1]}/` : '/msf/';
  // /msfi/ and /msfld/ share the same captcha session as /msf/
  if (raw === '/msfi/' || raw === '/msfld/') return '/msf/';
  return raw;
}

/**
 * Load cookies from CF Worker KV (persists across Vercel cold starts).
 */
async function _loadCookiesFromKv() {
  if (_kvCacheLoaded) return;
  _kvCacheLoaded = true;
  const auth = process.env.CF_WORKER_AUTH || '';
  if (!auth) return;
  try {
    const resp = await fetch(`${CF_WORKER_URL}/?uprot_kv=1&auth=${encodeURIComponent(auth)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.cookies && data.data && data.t && (Date.now() - data.t) < COOKIE_TTL) {
      // Convert CF Worker format to local format
      const sessid = data.cookies.PHPSESSID || '';
      const captchaHash = data.cookies.captcha || '';
      const captchaAnswer = data.data.captcha || '';
      if (sessid) {
        _cookieCache['/msf/'] = { sessid, captchaHash, captchaAnswer, ts: data.t };
        console.log('[Uprot] Loaded cookies from KV (age:', Math.round((Date.now() - data.t) / 60000), 'min)');
      }
    }
  } catch (e) {
    console.warn('[Uprot] KV load failed:', e.message);
  }
}

/**
 * Save cookies to CF Worker KV (persists across Vercel cold starts).
 */
async function _saveCookiesToKv(cookies) {
  const auth = process.env.CF_WORKER_AUTH || '';
  if (!auth) return;
  try {
    await fetch(`${CF_WORKER_URL}/?uprot_kv=1&auth=${encodeURIComponent(auth)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cookies: { PHPSESSID: cookies.sessid, captcha: cookies.captchaHash },
        data: { captcha: cookies.captchaAnswer },
        t: cookies.ts,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch { /* best effort */ }
}

function _headers(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://uprot.net',
    'Referer': referer || 'https://uprot.net/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1',
  };
}

/**
 * OCR a captcha image via per-digit segmentation + AI:
 * 1. Decode PNG → grayscale
 * 2. Binarize at low threshold → clean digit shapes
 * 3. Column-projection segmentation → 3 digit regions
 * 4. Extract each digit as clean isolated PNG
 * 5. Send each digit to CF Worker AI OCR (expectedDigits=1)
 * 6. Combine results
 */
async function _ocrCaptcha(b64) {
  const raw = Buffer.from(b64, 'base64');
  let width, height, pixels;
  try {
    ({ width, height, pixels } = decodePngGrayscale(raw));
  } catch { return null; }

  // 1. Try local pixel OCR first (fast, works if templates match)
  try {
    const pxAnswer = ocrDigitsFromPixels(width, height, pixels);
    if (pxAnswer && !pxAnswer.includes('?') && pxAnswer.length >= 2 && pxAnswer.length <= 5) {
      return { answer: pxAnswer, method: 'pixel' };
    }
  } catch { /* pixel OCR failed */ }

  // 2. Per-digit segmentation + AI OCR
  const threshold = 80;
  try {
    // Column projection to find digit segments
    const colDark = [];
    for (let x = 0; x < width; x++) {
      let dark = 0;
      for (let y = 0; y < height; y++) if (pixels[y * width + x] < threshold) dark++;
      colDark.push(dark);
    }
    const inDigit = colDark.map(v => v > 1);
    const segments = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (inDigit[x] && start < 0) start = x;
      else if (!inDigit[x] && start >= 0) { segments.push([start, x - 1]); start = -1; }
    }
    // Merge segments within 2px gap
    const merged = [];
    for (const seg of segments) {
      if (merged.length && seg[0] - merged[merged.length - 1][1] <= 2) {
        merged[merged.length - 1][1] = seg[1];
      } else merged.push([...seg]);
    }
    // Filter out noise segments (too narrow)
    const digitSegs = merged.filter(([s, e]) => e - s >= 5);
    if (digitSegs.length < 2 || digitSegs.length > 5) {
      console.warn('[Uprot] Segmentation found', digitSegs.length, 'digits (expected 3)');
    }

    // OCR each digit individually (sequential to avoid CF Worker AI timeout)
    const auth = process.env.CF_WORKER_AUTH || '';
    // Build digit images first, then OCR in parallel for speed
    const digitPngs = [];
    for (const [s, e] of digitSegs) {
      // Find vertical bounds
      let top = -1, bot = -1;
      for (let y = 0; y < height; y++) {
        let d = 0;
        for (let x = s; x <= e; x++) if (pixels[y * width + x] < threshold) d++;
        if (d > 0) { if (top < 0) top = y; bot = y; }
      }
      if (top < 0) { digitPngs.push(null); continue; }

      // Create clean digit image with padding
      const pad = 4;
      const dw = e - s + 1 + pad * 2;
      const dh = bot - top + 1 + pad * 2;
      const dp = new Uint8Array(dw * dh).fill(255);
      for (let y = top; y <= bot; y++) {
        for (let x = s; x <= e; x++) {
          dp[(y - top + pad) * dw + (x - s + pad)] = pixels[y * width + x] < threshold ? 0 : 255;
        }
      }
      digitPngs.push(encodePngGrayscale(dw, dh, dp));
    }

    // OCR all digits in parallel (faster than sequential)
    const digitResults = await Promise.all(digitPngs.map(async (png) => {
      if (!png) return '?';
      try {
        const resp = await fetch(`${CF_WORKER_URL}/?ocr_digits=1&auth=${auth}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: png.toString('base64'), expectedDigits: 1 }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await resp.json();
        return data?.answer || '?';
      } catch { return '?'; }
    }));

    const answer = digitResults.join('');
    if (answer && !answer.includes('?') && answer.length >= 2) {
      return { answer, method: 'ai-perdigit' };
    }
  } catch (e) {
    console.warn('[Uprot] Per-digit OCR error:', e.message);
  }

  // 3. Fallback: send full preprocessed image to CF Worker
  try {
    const cleanPixels = preprocessCaptcha(width, height, pixels, threshold);
    const cleanPng = encodePngGrayscale(width, height, cleanPixels);
    const auth = process.env.CF_WORKER_AUTH || '';
    const resp = await fetch(`${CF_WORKER_URL}/?ocr_digits=1&auth=${auth}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: cleanPng.toString('base64') }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    if (data?.answer) return { answer: data.answer, method: data.method || 'ai-clean' };
  } catch { /* fallback failed */ }

  return null;
}

/**
 * Solve the uprot captcha on a given URL → OCR → POST answer → cache cookies.
 * @param {string} [solveUrl] - URL to solve on; defaults to UPROT_INIT_URL for /msf/ paths.
 */
async function _solveCaptcha(solveUrl) {
  const targetUrl = solveUrl || UPROT_INIT_URL;
  const pathType = _getPathType(targetUrl);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 1. POST to uprot page (empty body) → PHPSESSID + captcha image
      const r1 = await _proxyFetch(targetUrl, {
        method: 'POST',
        headers: _headers(targetUrl),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });

      const setCookie1 = r1.headers.get('set-cookie') || '';
      const sessMatch = setCookie1.match(/PHPSESSID=([^;,\s]+)/);
      if (!sessMatch) { console.warn('[Uprot] No PHPSESSID, attempt', attempt); continue; }
      const sessid = sessMatch[1];
      const html = await r1.text();

      // Extract captcha image
      const imgMatch = html.match(/(?:src|data-src)=["'](data:image\/png;base64,([^"']+))["']/i)
        || html.match(/data:image\/png;base64,([^"']+)/i);
      if (!imgMatch) { console.warn('[Uprot] No captcha image, attempt', attempt); continue; }
      const b64 = (imgMatch[2] || imgMatch[1]).replace(/\s/g, '');

      // 2. OCR the captcha
      const ocr = await _ocrCaptcha(b64);
      if (!ocr) { console.warn('[Uprot] OCR failed, attempt', attempt); continue; }
      console.log('[Uprot] OCR:', ocr.answer, '(' + ocr.method + ')');

      // 3. POST captcha answer
      const r2 = await _proxyFetch(targetUrl, {
        method: 'POST',
        headers: { ..._headers(targetUrl), 'Cookie': `PHPSESSID=${sessid}` },
        body: `captcha=${ocr.answer}`,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });

      const html2 = await r2.text();

      // Extract updated cookies — captcha hash cookie = definitive success indicator
      const setCookie2 = r2.headers.get('set-cookie') || '';
      const sessMatch2 = setCookie2.match(/PHPSESSID=([^;,\s]+)/);
      const hashMatch = setCookie2.match(/captcha=([^;,\s]+)/);
      const hasCaptchaForm = /data:image\/png;base64/i.test(html2);

      if (!hashMatch || hasCaptchaForm) {
        console.warn('[Uprot] Wrong answer:', ocr.answer, 'attempt', attempt);
        continue;
      }

      const cookies = {
        sessid: sessMatch2 ? sessMatch2[1] : sessid,
        captchaHash: hashMatch ? hashMatch[1] : '',
        captchaAnswer: ocr.answer,
        ts: Date.now(),
      };
      _cookieCache[pathType] = cookies;
      console.log('[Uprot] Captcha solved:', ocr.answer, 'for', pathType);
      // Persist to KV for cross-invocation cache
      if (pathType === '/msf/') _saveCookiesToKv(cookies);
      return cookies;
    } catch (e) {
      console.warn('[Uprot] Solve attempt', attempt, 'error:', e.message);
    }
  }
  return null;
}

/** Get valid cookies for the given URL's path type (from cache, KV, or solve fresh). */
async function _getCookies(targetUrl) {
  const pathType = _getPathType(targetUrl || UPROT_INIT_URL);
  const cached = _cookieCache[pathType];
  if (cached && (Date.now() - cached.ts) < COOKIE_TTL) return cached;
  // Try loading from KV (persists across Vercel cold starts)
  await _loadCookiesFromKv();
  const kvCached = _cookieCache[pathType];
  if (kvCached && (Date.now() - kvCached.ts) < COOKIE_TTL) return kvCached;
  // For /msf/ use the fixed init URL; for others solve on the actual target URL
  return _solveCaptcha(pathType === '/msf/' ? undefined : targetUrl);
}

/**
 * Bypass an uprot link: POST with cached cookies → follow "CONTINUE" → MaxStream.
 * Returns MaxStream embed URL or null.
 */
async function _bypassUprot(uprotUrl, retried) {
  const cookies = await _getCookies(uprotUrl);
  if (!cookies) return null;

  try {
    const cookieStr = `PHPSESSID=${cookies.sessid}${cookies.captchaHash ? `; captcha=${cookies.captchaHash}` : ''}`;

    const r = await _proxyFetch(uprotUrl, {
      method: 'POST',
      headers: { ..._headers(uprotUrl), 'Cookie': cookieStr },
      body: `captcha=${cookies.captchaAnswer}`,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    const html = await r.text();
    console.log('[Uprot] Bypass response: status', r.status, 'htmlLen', html.length,
      'hasCaptcha:', /data:image\/png;base64/i.test(html),
      'hasButtok:', /buttok/i.test(html),
      'cookieAge:', Math.round((Date.now() - cookies.ts) / 60000), 'min');

    // Strip display:none blocks and HTML comments to avoid honeypots/decoys
    const cleanHtml = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<div[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

    // Find the REAL uprots/maxstream redirect link.
    let redirect = null;

    // Primary: <a> wrapping a <button id="buttok"> with C O N T I N U E
    const buttokMatch = cleanHtml.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*<button[^>]*id=["']buttok["'][^>]*>\s*C\s*O\s*N\s*T\s*I\s*N\s*U\s*E/i);
    if (buttokMatch) {
      redirect = buttokMatch[1];
    }

    // Fallback: any visible <a> wrapping a <button> with "C o n t i n u e" text
    if (!redirect) {
      const contMatch = cleanHtml.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*<button[^>]*>\s*C\s+[oO]\s+[nN]\s+[tT]\s+[iI]\s+[nN]\s+[uU]\s+[eE]\s*<\/button>/i);
      if (contMatch) redirect = contMatch[1];
    }

    // Last resort: all uprots/uprotem/maxstream redirect URLs in clean HTML
    if (!redirect) {
      const allUprots = [...cleanHtml.matchAll(/href=["'](https?:\/\/[^"']*(?:uprot(?:s|em)|maxstream\.video)\/[^"']+)["']/gi)].map(m => m[1]);
      const counts = {};
      for (const u of allUprots) counts[u] = (counts[u] || 0) + 1;
      redirect = allUprots.find(u => counts[u] === 1) || null;
      if (!redirect && allUprots.length > 0) {
        // If no unique URL found, pick the most common (or first maxstream.video one)
        redirect = allUprots.find(u => u.includes('maxstream.video')) || allUprots[0];
      }
      console.log('[Uprot] Last-resort URLs:', allUprots.length, 'unique:', redirect ? 'yes' : 'no');
    }

    if (!redirect) {
      // Debug: log what we see in the response
      const allHrefs = [...cleanHtml.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
      const videoHrefs = allHrefs.filter(u => /maxstream|uprots|uprotem/i.test(u));
      console.log('[Uprot] Bypass debug: status', r.status, 'html', html.length, 'clean', cleanHtml.length, 'hasCaptcha:', /data:image\/png;base64/i.test(html), 'allHrefs:', allHrefs.length, 'videoHrefs:', videoHrefs.length, videoHrefs.slice(0, 3));
      if (/data:image\/png;base64/i.test(html) && !retried) {
        console.warn('[Uprot] Cookies expired on bypass, re-solving...');
        const pathType = _getPathType(uprotUrl);
        delete _cookieCache[pathType];
        return _solveCaptcha(pathType === '/msf/' ? undefined : uprotUrl)
          .then(c => c ? _bypassUprot(uprotUrl, true) : null);
      }
      console.warn('[Uprot] No redirect link found');
      return null;
    }

    // Follow redirect chain through uprots → maxstream (3 tries max, bail on CF block)
    for (let i = 0; i < 3 && redirect.includes('uprots'); i++) {
      try {
        const rr = await _proxyFetch(redirect, {
          method: 'HEAD',
          headers: { 'User-Agent': UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(5000),
        });
        if (rr.status === 503 || rr.status === 403) {
          console.log('[Uprot] Redirect blocked by CF (' + rr.status + '), passing to extractMaxStream');
          break;
        }
        redirect = rr.url || redirect;
      } catch {
        break;
      }
    }

    // Convert watchfree URL → maxstream embed
    if (redirect.includes('watchfree')) {
      const parts = redirect.split('/');
      const wfIdx = parts.indexOf('watchfree');
      if (wfIdx >= 0 && parts[wfIdx + 2]) {
        return `https://maxstream.video/emvvv/${parts[wfIdx + 2]}`;
      }
    }

    if (redirect.includes('maxstream')) return redirect;

    console.warn('[Uprot] Unexpected redirect:', redirect);
    return null;
  } catch (e) {
    console.error('[Uprot] Bypass error:', e.message);
    return null;
  }
}

/**
 * Handle /msei/ (individual episode) uprot links.
 * These use a token-based captcha form (no PHPSESSID session),
 * so each URL requires solving its own captcha.
 */
async function _extractMseiUprot(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // 1. GET page → captcha image + token
      const r1 = await _proxyFetch(url, {
        method: 'GET',
        headers: _headers(url),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const html1 = await r1.text();

      const tokenMatch = html1.match(/name=['"]token['"][^>]*value=['"]([^'"]+)/i);
      if (!tokenMatch) { console.warn('[Uprot/msei] No token, attempt', attempt); continue; }
      const token = tokenMatch[1];

      const imgMatch = html1.match(/data:image\/png;base64,([^'"]+)/i);
      if (!imgMatch) { console.warn('[Uprot/msei] No captcha image, attempt', attempt); continue; }
      const b64 = imgMatch[1].replace(/\s/g, '');

      // 2. OCR captcha
      const ocr = await _ocrCaptcha(b64);
      if (!ocr) { console.warn('[Uprot/msei] OCR failed, attempt', attempt); continue; }
      console.log('[Uprot/msei] OCR:', ocr.answer, '(' + ocr.method + ')');

      // 3. POST with token + capt
      const r2 = await _proxyFetch(url, {
        method: 'POST',
        headers: { ..._headers(url), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}&capt=${encodeURIComponent(ocr.answer)}`,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const html2 = await r2.text();

      // If still has captcha → wrong answer
      if (/data:image\/png;base64/i.test(html2)) {
        console.warn('[Uprot/msei] Wrong answer:', ocr.answer, 'attempt', attempt);
        continue;
      }

      // 4. Extract redirect link — strip honeypots first
      const cleanHtml2 = html2
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<div[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

      let redirect = null;
      const buttokMatch = cleanHtml2.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*<button[^>]*id=["']buttok["'][^>]*>\s*C\s*O\s*N\s*T\s*I\s*N\s*U\s*E/i);
      if (buttokMatch) redirect = buttokMatch[1];

      if (!redirect) {
        const contMatch = cleanHtml2.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*<button[^>]*>\s*C\s+[oO]\s+[nN]\s+[tT]\s+[iI]\s+[nN]\s+[uU]\s+[eE]\s*<\/button>/i);
        if (contMatch) redirect = contMatch[1];
      }

      if (!redirect) {
        const allUprots = [...cleanHtml2.matchAll(/href=["'](https?:\/\/[^"']*uprot(?:s|em)\/[^"']+)["']/gi)].map(m => m[1]);
        const counts = {};
        for (const u of allUprots) counts[u] = (counts[u] || 0) + 1;
        redirect = allUprots.find(u => counts[u] === 1) || null;
      }

      if (!redirect) {
        const msMatch = cleanHtml2.match(/href=["'](https?:\/\/[^"']*maxstream[^"']+)["']/i);
        if (msMatch) redirect = msMatch[1];
      }

      if (!redirect) {
        console.warn('[Uprot/msei] No redirect link after captcha solve');
        continue;
      }

      console.log('[Uprot/msei] Redirect:', redirect);

      // Follow redirect chain through uprots → maxstream (3 tries, bail on CF)
      for (let i = 0; i < 3 && redirect.includes('uprots'); i++) {
        try {
          const rr = await _proxyFetch(redirect, {
            method: 'HEAD',
            headers: { 'User-Agent': UA },
            redirect: 'follow',
            signal: AbortSignal.timeout(5000),
          });
          if (rr.status === 503 || rr.status === 403) break;
          redirect = rr.url || redirect;
        } catch { break; }
      }

      if (redirect.includes('watchfree')) {
        const parts = redirect.split('/');
        const wfIdx = parts.indexOf('watchfree');
        if (wfIdx >= 0 && parts[wfIdx + 2]) {
          redirect = `https://maxstream.video/emvvv/${parts[wfIdx + 2]}`;
        }
      }

      if (redirect.includes('maxstream')) {
        const result = await extractMaxStream(redirect);
        return result || { url: redirect, headers: { 'User-Agent': UA, 'Referer': 'https://maxstream.video/' } };
      }

      console.warn('[Uprot/msei] Unexpected redirect:', redirect);
    } catch (e) {
      console.error('[Uprot/msei] Attempt', attempt, 'error:', e.message);
    }
  }
  return null;
}

/**
 * Delegate uprot resolution to CF Worker (most reliable: same-IP, direct AI access).
 * ?uprot=1&url=<uprotUrl>&extract=1&auth=<auth>
 * Returns { url, headers } or null.
 */
async function _resolveViaCfWorker(uprotUrl) {
  const auth = process.env.CF_WORKER_AUTH || '';
  if (!auth) return null;
  try {
    const params = new URLSearchParams({
      url: uprotUrl,
      uprot: '1',
      extract: '1',
      auth,
    });
    console.log('[Uprot] Delegating to CF Worker:', uprotUrl);
    const resp = await fetch(`${CF_WORKER_URL}/?${params}`, {
      signal: AbortSignal.timeout(18000),
      headers: { 'User-Agent': UA },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn('[Uprot] CF Worker returned', resp.status, body.substring(0, 200));
      return null;
    }
    const data = await resp.json();
    console.log('[Uprot] CF Worker result:', data.method || 'unknown', data.url ? 'URL found' : 'no URL');
    if (data.url) {
      return {
        url: data.url,
        headers: { 'User-Agent': UA, 'Referer': 'https://maxstream.video/' },
      };
    }
    return null;
  } catch (e) {
    console.warn('[Uprot] CF Worker delegation failed:', e.message);
    return null;
  }
}

/**
 * Main entry: resolve an uprot.net link to a playable video URL.
 * Primary: delegate to CF Worker (single-IP, reliable OCR).
 * Fallback: local captcha solving with KV-cached cookies.
 * Returns { url, headers } or null.
 */
async function extractUprot(uprotUrl) {
  try {
    let link = String(uprotUrl).trim();
    if (link.includes('/mse/')) link = link.replace('/mse/', '/msf/');

    // /msfld/ is a folder listing — not directly extractable (handled by CB01 provider)
    if (link.includes('/msfld/')) return null;

    // Primary strategy: delegate to CF Worker — SKIP if PROXY_URL is set
    // because uprot.net blocks all datacenter IPs (Vercel, CF Workers).
    // When proxy is available, local resolution via proxy is faster and more reliable.
    const cfResult = (process.env.PROXY_URL || '').trim() ? null : await _resolveViaCfWorker(link);
    if (cfResult) return cfResult;

    // Fallback: local resolution
    console.log('[Uprot] CF Worker failed, trying local resolution for', link);

    // /msei/ uses token-based captcha (per-URL, no session caching)
    if (link.includes('/msei/')) return _extractMseiUprot(link);

    const maxstreamUrl = await _bypassUprot(link);
    if (!maxstreamUrl) return null;

    const result = await extractMaxStream(maxstreamUrl);
    if (result) return result;

    return {
      url: maxstreamUrl,
      headers: { 'User-Agent': UA, 'Referer': 'https://maxstream.video/' },
    };
  } catch (e) {
    console.error('[Uprot] Extraction error:', e.message);
    return null;
  }
}

/**
 * Fetch an uprot.net page with valid cookies + proxy.
 * Used by CB01 to resolve /msfld/ folder listings.
 * Returns HTML string or null.
 */
async function fetchUprotPage(url) {
  const cookies = await _getCookies(url);
  if (!cookies) { console.log('[Uprot] fetchUprotPage: no cookies'); return null; }
  try {
    const cookieStr = `PHPSESSID=${cookies.sessid}${cookies.captchaHash ? `; captcha=${cookies.captchaHash}` : ''}`;
    const r = await _proxyFetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://uprot.net',
        'Referer': url,
        'Cookie': cookieStr,
      },
      body: `captcha=${cookies.captchaAnswer}`,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    console.log('[Uprot] fetchUprotPage: status', r.status);
    if (r.status >= 400) return null;
    return await r.text();
  } catch (e) { console.log('[Uprot] fetchUprotPage error:', e.message); return null; }
}

module.exports = { extractUprot, fetchUprotPage };

