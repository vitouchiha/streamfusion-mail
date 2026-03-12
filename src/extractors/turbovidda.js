'use strict';

const zlib = require('zlib');
const { USER_AGENT, unpackPackedSource } = require('./common');

const TURBO_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// ─── CF Worker proxy helper ─────────────────────────────────────────────────

/**
 * Fetch through CF Worker when CF_WORKER_URL is set, direct fetch otherwise.
 * Handles GET/POST, redirect manual/follow, and cookie pass-through.
 * Returns a Response-compatible object.
 */
async function _proxyFetch(url, options = {}) {
  const cfBase = (process.env.CF_WORKER_URL || '').trim();
  if (!cfBase) return fetch(url, options); // Direct (local dev)

  const workerUrl = new URL(cfBase.replace(/\/$/, ''));
  workerUrl.searchParams.set('url', url);

  const cfAuth = (process.env.CF_WORKER_AUTH || '').trim();
  const outHeaders = {};
  if (cfAuth) outHeaders['x-worker-auth'] = cfAuth;

  const isPost = (options.method || 'GET').toUpperCase() === 'POST';
  const isManual = options.redirect === 'manual';

  if (isPost) {
    workerUrl.searchParams.set('method', 'POST');
    if (options.body) workerUrl.searchParams.set('body', String(options.body));
    const ct = options.headers?.['Content-Type'] || options.headers?.['content-type'];
    if (ct) workerUrl.searchParams.set('contentType', ct);
  }

  // Pass cookie header
  const cookie = options.headers?.Cookie || options.headers?.cookie;
  if (cookie) workerUrl.searchParams.set('cookie', cookie);

  if (isManual) workerUrl.searchParams.set('nofollow', '1');
  // Always use wantCookie so we get setCookie + body in JSON
  workerUrl.searchParams.set('wantCookie', '1');

  const resp = await fetch(workerUrl.toString(), {
    headers: outHeaders,
    signal: options.signal,
  });

  let data;
  try { data = await resp.json(); } catch {
    return { status: 502, ok: false, url, headers: _fakeHeaders({}), text: async () => '', json: async () => ({}) };
  }
  const status = data.status || resp.status;
  return {
    status,
    ok: status >= 200 && status < 400,
    url,
    headers: _fakeHeaders({
      'location': data.location || '',
      'set-cookie': data.setCookie || '',
    }),
    text: async () => data.body || '',
    json: async () => JSON.parse(data.body || '{}'),
  };
}

function _fakeHeaders(map) {
  return { get(name) { return map[(name || '').toLowerCase()] || null; } };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse all <input> fields from an HTML string into an object.
 */
function parseFormInputs(html) {
  const data = {};
  // Matches <input ... name="x" ... value="y" ...> in any attr order
  for (const match of String(html).matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1];
    const nameMatch = /\bname="([^"]+)"/.exec(attrs);
    const valueMatch = /\bvalue="([^"]*)"/.exec(attrs);
    if (nameMatch) {
      data[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  }
  return data;
}

/**
 * Follow HEAD redirects step by step to resolve the final URL.
 * Turbovid links often go through a short redirect chain.
 */
async function resolveRedirectUrl(url, maxHops = 5) {
  let current = String(url || '').trim();
  for (let i = 0; i < maxHops; i++) {
    try {
      const resp = await _proxyFetch(current, {
        method: 'GET',
        headers: {
          'User-Agent': TURBO_UA,
          'Range': 'bytes=0-0',
        },
        redirect: 'manual',
      });
      const location = resp.headers.get('location');
      if (!location) break;
      // Resolve relative URLs
      current = new URL(location, current).href;
    } catch {
      break;
    }
  }
  return current;
}

/**
 * Attempt to bypass safego.cc by following the redirect chain automatically.
 * If safego shows a captcha page, this will fail gracefully.
 * @returns {string|null} The resolved URL past safego, or null if bypass failed
 */
/**
 * In-memory cache for safego.cc cookies.
 * Shared across all calls within the same process lifetime.
 * { phpsessid, captch5, ts } — ts is the Unix-ms timestamp when cached.
 */
const _safegoCache = { phpsessid: '', captch5: '', ts: 0 };
const SAFEGO_COOKIE_TTL = 3 * 60 * 60 * 1000; // 3 hours

/**
 * Decode a PNG Buffer into { width, height, pixels[] } (grayscale 0-255).
 * Uses only Node.js built-in zlib. A simplified Paeth predictor is used.
 */
function _decodePngGrayscale(buf) {
  let offset = 8; // skip magic
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const chunkLen = buf.readUInt32BE(offset); offset += 4;
    const type = buf.slice(offset, offset + 4).toString('ascii'); offset += 4;
    const data = buf.slice(offset, offset + chunkLen); offset += chunkLen + 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const channels = [0, 0, 3, 0, 2, 0, 4][colorType] || 1;
  const bpp = Math.ceil((bitDepth * channels) / 8);
  const stride = 1 + width * bpp;
  const pixels = new Uint8Array(width * height);
  let prev = new Uint8Array(width * bpp);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * stride];
    const cur = new Uint8Array(width * bpp);
    for (let i = 0; i < width * bpp; i++) {
      const b = raw[y * stride + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const c = (i >= bpp && y > 0) ? prev[i - bpp] : 0;
      const p = prev[i];
      let v;
      if (ft === 0) v = b;
      else if (ft === 1) v = b + a;
      else if (ft === 2) v = b + p;
      else if (ft === 3) v = b + Math.floor((a + p) / 2);
      else { // paeth
        const pa = Math.abs(p - c), pb = Math.abs(a - c), pc = Math.abs(a + p - 2 * c);
        v = b + (pa <= pb && pa <= pc ? a : pb <= pc ? p : c);
      }
      cur[i] = v & 0xFF;
    }
    prev = cur;
    for (let x = 0; x < width; x++) {
      const r = cur[x * bpp], g = channels >= 3 ? cur[x * bpp + 1] : r, bv = channels >= 3 ? cur[x * bpp + 2] : r;
      pixels[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * bv);
    }
  }
  return { width, height, pixels };
}

/**
 * Segment dark pixel columns into digit groups and apply simple 7-segment template matching.
 * Returns the digit string (e.g. "4271") or null if unrecognisable.
 */
function _ocrDigitsFromPixels(width, height, pixels, threshold = 128) {
  // Build column darkness profile
  const colDark = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < height; y++) {
      if (pixels[y * width + x] < threshold) dark++;
    }
    colDark[x] = dark / height;
  }

  // Find digit segments: contiguous columns with >5% dark pixels
  const inDigit = colDark.map(v => v > 0.05);
  const segments = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    if (inDigit[x] && start < 0) start = x;
    else if (!inDigit[x] && start >= 0) { segments.push([start, x - 1]); start = -1; }
  }
  // Only merge if literally adjacent (gap = 0); safego digit gaps are exactly 1 col
  const merged = [];
  for (const seg of segments) {
    if (merged.length && seg[0] - merged[merged.length - 1][1] <= 1) {
      merged[merged.length - 1][1] = seg[1];
    } else merged.push([...seg]);
  }
  // Ignore very narrow artifact columns (< 2px wide)
  const digits = merged.filter(([s, e]) => e - s >= 2);

  if (!digits.length) return null;

  let result = '';
  for (const [s, e] of digits) {
    const dw = e - s + 1;
    // Build row profile for this digit column range
    const rowDark = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      let dark = 0;
      for (let x = s; x <= e; x++) if (pixels[y * width + x] < threshold) dark++;
      rowDark[y] = dark / dw;
    }
    // Find top/bottom of the digit (rows with any dark pixels)
    let top = 0, bot = height - 1;
    for (let y = 0; y < height; y++) { if (rowDark[y] > 0.1) { top = y; break; } }
    for (let y = height - 1; y >= 0; y--) { if (rowDark[y] > 0.1) { bot = y; break; } }
    const dh = bot - top + 1; if (dh < 3) continue;

    // 3-zone split (top / mid / bottom) + left/right half darkness
    const t1 = top + Math.floor(dh / 3), t2 = top + Math.floor(2 * dh / 3);
    const zones = ['T', 'M', 'B'];
    const profile = {};
    for (const [zi, [ya, yb]] of [['T', [top, t1]], ['M', [t1 + 1, t2]], ['B', [t2 + 1, bot]]]) {
      let L = 0, R = 0, cnt = 0;
      const mid = Math.floor((s + e) / 2);
      for (let y = ya; y <= yb; y++) {
        for (let x = s; x <= e; x++) {
          if (pixels[y * width + x] < threshold) {
            if (x <= mid) L++; else R++;
          }
          cnt++;
        }
      }
      profile[zi + 'L'] = L / (cnt / 2 + 0.01);
      profile[zi + 'R'] = R / (cnt / 2 + 0.01);
    }

    const { TL = 0, TR = 0, ML = 0, MR = 0, BL = 0, BR = 0 } = profile;
    const ratio = dw / dh;
    // Width-to-height ratio helps distinguish 1 (narrow) from others
    const digit = _matchDigit(TL, TR, ML, MR, BL, BR, ratio);
    result += digit;
  }

  return result || null;
}

/**
 * Map pixel zone profile to a digit character.
 * Uses nearest-neighbour matching against expected feature vectors.
 * Vectors measured from real safego.cc captcha samples.
 * Format: [TL, TR, ML, MR, BL, BR] (zone darkness 0-1 per half).
 */
const _DIGIT_TEMPLATES = {
  '0': [0.44, 0.44, 0.50, 0.50, 0.42, 0.42], // oval – symmetric, all zones dark
  '1': [0.00, 0.90, 0.00, 0.90, 0.00, 0.90], // right bar only (ratio < 0.28 catches narrow)
  '2': [0.38, 0.50, 0.08, 0.42, 0.66, 0.33], // top arc, right mid, diagonal → BL heavy
  '3': [0.10, 0.65, 0.00, 0.60, 0.05, 0.70], // right-side only all zones
  '4': [0.50, 0.55, 0.70, 0.60, 0.00, 0.80], // left bar top, crossbar, right bar bottom
  '5': [0.60, 0.15, 0.42, 0.48, 0.08, 0.72], // top-left, centre, bottom-right
  '6': [0.50, 0.31, 0.66, 0.50, 0.50, 0.50], // top-left arch, left side, bottom oval
  '7': [0.50, 0.78, 0.00, 0.52, 0.00, 0.18], // full top bar, right diagonal only, no bottom
  '8': [0.52, 0.52, 0.58, 0.58, 0.52, 0.52], // all zones dark (two stacked ovals)
  '9': [0.42, 0.42, 0.22, 0.70, 0.00, 0.72], // top arc, right + middle, no BL
};

function _matchDigit(TL, TR, ML, MR, BL, BR, ratio) {
  if (ratio < 0.28) return '1';
  const obs = [TL, TR, ML, MR, BL, BR];
  let best = '?', bestDist = Infinity;
  for (const [ch, tmpl] of Object.entries(_DIGIT_TEMPLATES)) {
    let dist = 0;
    for (let i = 0; i < 6; i++) dist += Math.abs(obs[i] - tmpl[i]);
    if (dist < bestDist) { bestDist = dist; best = ch; }
  }
  // Reject if nothing is close enough (max total distance = 1.0)
  return bestDist < 1.0 ? best : '?';
}

/**
 * Solve a safego.cc captcha.
 * 1. GET the safego URL to receive PHPSESSID cookie + captcha PNG (data URI)
 * 2. Decode the PNG and OCR the digits using built-in Node zlib (NO external deps)
 * 3. POST the answer using the field name detected from the page (captch4 or captch5)
 * 4. Returns { phpsessid, captch5 } or null on failure
 */
async function _solveSafegoCaptcha(safegoUrl) {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0';
  try {
    const r1 = await _proxyFetch(safegoUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Referer': 'https://safego.cc/' },
      redirect: 'manual',
    });
    const setCookie1 = r1.headers.get('set-cookie') || '';
    const phpsessid = (setCookie1.match(/PHPSESSID=([^;,\s]+)/) || [])[1] || '';
    if (!phpsessid) return null;
    const html1 = await r1.text();
    // Detect captcha field name dynamically (safego uses captch4 or captch5 depending on page version)
    const captchField = /name="(captch[45])"/.exec(html1)?.[1] || 'captch4';
    // Extract inline PNG data URI from captcha page
    const imgMatch = html1.match(/src="(data:image\/png;base64,([^"]+))"/i);
    if (!imgMatch) return null;
    const b64data = imgMatch[2].replace(/\s/g, '');
    const imgBuf = Buffer.from(b64data, 'base64');
    const { width, height, pixels } = _decodePngGrayscale(imgBuf);

    // Primary: ocr.space free API (accurate, ~25k req/month free)
    // Fallback: pixel-based nearest-neighbour OCR (fast, no external deps)
    let captchAnswer = null;
    try {
      const ocrForm = new URLSearchParams({
        base64Image: `data:image/png;base64,${b64data}`,
        apikey: 'helloworld',
        language: 'eng',
        isOverlayRequired: 'false',
        detectOrientation: 'false',
        scale: 'true',
        OCREngine: '2',
      });
      const ocrResp = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: ocrForm,
        signal: AbortSignal.timeout(10000),
      });
      const ocrJson = await ocrResp.json().catch(() => ({}));
      const ocrText = ((ocrJson?.ParsedResults || [])[0]?.ParsedText || '').replace(/\D/g, '');
      if (ocrText) { captchAnswer = ocrText; console.log(`[Safego] OCR.space: "${captchAnswer}"`); }
    } catch (e) {
      console.log(`[Safego] OCR.space failed: ${e.message}`);
    }
    if (!captchAnswer) {
      captchAnswer = _ocrDigitsFromPixels(width, height, pixels);
      console.log(`[Safego] Pixel OCR fallback: "${captchAnswer}" (${width}x${height})`);
    }
    if (!captchAnswer) return null;
    // POST the answer using detected field name
    const body = new URLSearchParams({ [captchField]: captchAnswer }).toString();
    console.log(`[Safego] Posting ${captchField}=${captchAnswer}`);
    const r2 = await _proxyFetch(safegoUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `PHPSESSID=${phpsessid}`,
        'Origin': 'https://safego.cc',
        'Referer': safegoUrl,
        'Accept': 'text/html,application/xhtml+xml',
      },
      body,
      redirect: 'manual',
    });
    const setCookie2 = r2.headers.get('set-cookie') || '';
    const captch5Cookie = (setCookie2.match(/captch[45]=([^;,\s]+)/) || [])[1] || '';
    const r2loc = r2.headers.get('location');
    if (captch5Cookie || r2loc) {
      const directUrl = r2loc ? new URL(r2loc, safegoUrl).href : undefined;
      if (directUrl) console.log(`[Safego] Captcha solved OK → ${directUrl}`);
      else console.log(`[Safego] Captcha solved OK, captch5 cookie obtained, doing follow-up GET`);
      if (!directUrl && captch5Cookie) {
        // Cookie obtained but no immediate redirect — GET with cookie to retrieve destination
        const cookieStr = `PHPSESSID=${phpsessid}; captch5=${captch5Cookie}`;
        try {
          const rGet = await _proxyFetch(safegoUrl, {
            headers: { 'User-Agent': UA, 'Cookie': cookieStr, 'Accept': 'text/html,application/xhtml+xml' },
            redirect: 'manual',
          });
          const getLoc = rGet.headers.get('location');
          if (getLoc) return { phpsessid, captch5: captch5Cookie, directUrl: new URL(getLoc, safegoUrl).href };
          const getHtml = await rGet.text();
          const getLink = /<a\b[^>]+href="(https?:\/\/[^"]+)"/.exec(getHtml);
          if (getLink) return { phpsessid, captch5: captch5Cookie, directUrl: getLink[1] };
        } catch (_) { /* ignore, fall through to return without directUrl */ }
      }
      return { phpsessid, captch5: captch5Cookie || captchAnswer, directUrl };
    }
    // Check if response has a direct link (POST succeeded without a cookie)
    const html2 = await r2.text();
    const linkMatch = /<a[^>]+href=["']([^"']+)["']/.exec(html2);
    if (linkMatch && /^https?:\/\//.test(linkMatch[1])) {
      return { phpsessid, captch5: captchAnswer, directUrl: linkMatch[1] };
    }
    console.log('[Safego] Captcha POST did not return captch5 cookie — captcha may have been wrong');
    return null;
  } catch (e) {
    console.error('[Safego] solveCaptcha error:', e.message);
    return null;
  }
}

/**
 * Get valid safego.cc cookies, using in-memory cache and auto-solving when expired.
 * Priority: in-memory cache → env vars → auto-solve captcha
 */
async function _getValidSafegoCookies(safegoUrl) {
  // 1. In-memory cache
  if (_safegoCache.captch5 && Date.now() - _safegoCache.ts < SAFEGO_COOKIE_TTL) {
    return `PHPSESSID=${_safegoCache.phpsessid}; captch5=${_safegoCache.captch5}`;
  }
  // 2. Env vars
  const envSessid = (process.env.SAFEGO_PHPSESSID || '').trim();
  const envCaptch = (process.env.SAFEGO_CAPTCH5  || '').trim();
  if (envSessid && envCaptch) {
    _safegoCache.phpsessid = envSessid;
    _safegoCache.captch5 = envCaptch;
    _safegoCache.ts = Date.now();
    return `PHPSESSID=${envSessid}; captch5=${envCaptch}`;
  }
  // 3. Auto-solve captcha
  if (safegoUrl) {
    const solved = await _solveSafegoCaptcha(safegoUrl);
    if (solved && solved.captch5) {
      _safegoCache.phpsessid = solved.phpsessid;
      _safegoCache.captch5 = solved.captch5;
      _safegoCache.ts = Date.now();
      return `PHPSESSID=${solved.phpsessid}; captch5=${solved.captch5}`;
    }
  }
  return null;
}

async function bypassSafego(initialUrl) {
  try {
    let current = String(initialUrl || '').trim();

    // Follow redirects until we hit safego or a direct video host link
    for (let i = 0; i < 8; i++) {
      if (/turbovid|deltabit|mixdrop|m1xdrop/i.test(current)) {
        return current;
      }

      // At safego: try cached cookies first, then auto-solve captcha
      if (current.includes('safego')) {
        // 1. Try cached or env-var cookies (GET request — safego redirects if cookie is valid)
        const envSessid = (process.env.SAFEGO_PHPSESSID || '').trim();
        const envCaptch  = (process.env.SAFEGO_CAPTCH5  || '').trim();
        const hasCached = _safegoCache.captch5 && Date.now() - _safegoCache.ts < SAFEGO_COOKIE_TTL;
        const hasCookies = hasCached || (envSessid && envCaptch);
        if (hasCookies) {
          const ph = hasCached ? _safegoCache.phpsessid : envSessid;
          const c5 = hasCached ? _safegoCache.captch5 : envCaptch;
          const cookieStr = `PHPSESSID=${ph}; captch5=${c5}`;
          const getR = await _proxyFetch(current, {
            headers: {
              'User-Agent': TURBO_UA, 'Cookie': cookieStr,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'manual',
          });
          const getLoc = getR.headers.get('location');
          if (getLoc) { current = new URL(getLoc, current).href; continue; }
          const getHtml = await getR.text();
          const getLink = /<a\b[^>]+href="(https?:\/\/[^"]+)"/.exec(getHtml);
          if (getLink) return getLink[1];
          // Cookie invalid — clear cache and fall through to auto-solve
          _safegoCache.ts = 0;
        }

        // 2. Auto-solve captcha (single attempt)
        const solved = await _solveSafegoCaptcha(current);
        if (solved) {
          if (solved.directUrl) { current = solved.directUrl; continue; }
          // Got cookies but no directUrl — try GET with new cookies
          if (solved.captch5) {
            const ck = `PHPSESSID=${solved.phpsessid}; captch5=${solved.captch5}`;
            const gR = await _proxyFetch(current, {
              headers: { 'User-Agent': TURBO_UA, 'Cookie': ck, 'Accept': 'text/html,application/xhtml+xml' },
              redirect: 'manual',
            });
            const gLoc = gR.headers.get('location');
            if (gLoc) { current = new URL(gLoc, current).href; continue; }
            const gHtml = await gR.text();
            const gLink = /<a\b[^>]+href="(https?:\/\/[^"]+)"/.exec(gHtml);
            if (gLink) return gLink[1];
          }
        }

        console.log('[Safego] bypass failed — captcha could not be solved automatically.');
        return null;
      }

      // Generic redirect following
      const resp = await _proxyFetch(current, {
        headers: {
          'User-Agent': TURBO_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        redirect: 'manual',
      });
      const location = resp.headers.get('location');
      if (location) {
        current = new URL(location, current).href;
        continue;
      }
      const html = await resp.text();
      const metaMatch = /content="\d+;\s*url=(https?:\/\/[^"]+)"/.exec(html);
      if (metaMatch) { current = metaMatch[1]; continue; }
      break;
    }

    if (/turbovid|deltabit|mixdrop|m1xdrop/i.test(current)) return current;
    return null;
  } catch {
    return null;
  }
}


/**
 * Extract a video stream URL from a Turbovid embed page.
 *
 * Flow (ported from mammamia deltabit.py Turbovid path):
 *   1. Resolve redirect to get actual turbovid URL
 *   2. GET the Turbovid page, parse all <input> form fields
 *   3. Set imhuman = "Proceed to video" (submit button value)
 *   4. Wait 5 seconds (required by Turbovid's JS protection)
 *   5. POST the form − response has p.a.c.k.e.r encoded JS
 *   6. Unpack JS, extract sources:["{url}"] pattern
 *
 * @param {string} pageUrl  Turbovid embed URL (after safego bypass)
 * @returns {Promise<{url:string}|null>}
 */
async function extractTurbovidda(pageUrl) {
  try {
    const rawUrl = String(pageUrl || '').trim();
    if (!rawUrl.startsWith('http')) return null;

    // Step 1: Resolve final turbovid URL after redirect chain
    const actualUrl = await resolveRedirectUrl(rawUrl);
    let parsedOrigin;
    try {
      parsedOrigin = new URL(actualUrl).origin;
    } catch {
      return null;
    }

    // Step 2: GET the Turbovid page
    const pageResp = await _proxyFetch(actualUrl, {
      headers: {
        'User-Agent': TURBO_UA,
        'Referer': 'https://safego.cc/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });
    if (!pageResp.ok) return null;

    const finalUrl = pageResp.url || actualUrl;
    const html = await pageResp.text();

    // Step 3: Parse form inputs
    const formFields = parseFormInputs(html);

    // Step 4: Set Turbovid-specific submit value (empty per Python reference)
    formFields['imhuman'] = '';
    formFields['referer'] = finalUrl;

    const formBody = new URLSearchParams(formFields).toString();

    const postHeaders = {
      'User-Agent': TURBO_UA,
      'Referer': finalUrl,
      'Origin': parsedOrigin,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };

    // Step 5: Wait 4.5 seconds (Turbovid enforces a JS timer — MammaMia uses 5s)
    await new Promise((r) => setTimeout(r, 4500));

    // Step 6: POST the form
    const postResp = await _proxyFetch(finalUrl, {
      method: 'POST',
      headers: postHeaders,
      body: formBody,
      redirect: 'follow',
    });
    if (!postResp.ok) return null;
    const postHtml = await postResp.text();

    // Step 7: Unpack p.a.c.k.e.r and extract video URL
    const unpacked = unpackPackedSource(postHtml);
    const source = unpacked || postHtml;

    const urlMatch = /sources\s*:\s*\[\s*["']([^"']+)["']\s*\]/.exec(source)
      || /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/.exec(source)
      || /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/.exec(source);

    if (urlMatch && urlMatch[1] && urlMatch[1].startsWith('http')) {
      return { url: urlMatch[1] };
    }

    return null;
  } catch {
    return null;
  }
}

module.exports = { extractTurbovidda, bypassSafego };
