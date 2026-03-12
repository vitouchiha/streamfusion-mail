'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Shared Puppeteer browser launcher — Vercel-compatible
 *
 * Priority order:
 *   1. BROWSERLESS_URL env var → connects to remote Chrome (Browserless.io, etc.)
 *      wss://chrome.browserless.io?token=TOKEN
 *      Works from Vercel serverless / any environment (just a WebSocket)
 *   2. Local launch:
 *      - PUPPETEER_EXECUTABLE_PATH → custom binary path (Docker / VPS)
 *      - Auto-detect system Chrome (local dev)
 *
 * Browserless.io free tier: https://www.browserless.io/  (sign up, copy WS URL)
 *
 * Usage:
 *   const { launchBrowser } = require('./browser');
 *   const browser = await launchBrowser();
 *   // ... use browser
 *   await browser.close();
 */

const puppeteerCore = require('puppeteer-core');
const { createLogger } = require('./logger');

const log = createLogger('browser');

const IS_SERVERLESS = !!(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NETLIFY
);

function getBrowserlessUrl() {
  const raw = String(process.env.BROWSERLESS_URL || '').replace(/[\r\n]/g, '').trim();
  if (!raw) return '';
  return raw.replace(/^['"]+|['"]+$/g, '').replace(/\\r|\\n/g, '').trim();
}

/**
 * Parse a proxy URL into its components.
 * @param {string} proxyUrl  e.g. http://user:pass@host:port
 * @returns {{ host: string, port: string, username: string, password: string } | null}
 */
function _parseProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    if (!parsed.hostname || !parsed.port) return null;
    return {
      host: parsed.hostname,
      port: parsed.port,
      username: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Launch (or connect to) a Puppeteer browser instance.
 *
 * If BROWSERLESS_URL is set → connect to remote Chrome via WebSocket.
 * Otherwise → launch locally (for Docker / local dev).
 *
 * @param {object} [options]
 * @param {string} [options.proxyUrl]  HTTP proxy URL (http://user:pass@host:port)
 *   When set, Chrome is launched with --proxy-server so all page requests go
 *   through the proxy. The caller must call page.authenticate() with the
 *   credentials returned in browser._proxyAuth.
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchBrowser(options = {}) {
  const proxyInfo = _parseProxyUrl(options.proxyUrl);
  const browserlessUrl = getBrowserlessUrl();

  // ── Option 1: Remote Chrome via Browserless.io (recommended for Vercel) ────
  if (browserlessUrl) {
    log.info('connecting to remote Chrome via BROWSERLESS_URL', {
      withProxy: !!proxyInfo,
      urlLen: browserlessUrl.length,
      urlHex: [...browserlessUrl].slice(-10).map(c => c.charCodeAt(0).toString(16)).join(','),
    });
    // Single attempt — retries waste 2s+ and consistently fail with same error
    try {
      let wsUrl = browserlessUrl;
      if (proxyInfo) {
        const sep = wsUrl.includes('?') ? '&' : '?';
        wsUrl += `${sep}--proxy-server=http://${proxyInfo.host}:${proxyInfo.port}`;
      }
      log.warn('browserless connect', { wsUrlLen: wsUrl.length, hasProxy: !!proxyInfo, wsUrlEnd: wsUrl.slice(-50) });
      const browser = await Promise.race([
        puppeteerCore.connect({
          browserWSEndpoint: wsUrl,
          defaultViewport: { width: 1280, height: 720 },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Browserless connect timeout (15s)')), 15_000)),
      ]);
      if (proxyInfo && proxyInfo.username) {
        browser._proxyAuth = { username: proxyInfo.username, password: proxyInfo.password };
      }
      log.debug('connected to remote Chrome');
      return browser;
    } catch (err) {
      log.warn(`remote Chrome failed: ${err.message}, falling back to local Chromium`);
    }
  }

  // ── Option 2: Local launch (Docker / dev) ───────────────────────────────────
  const args = _baseArgs();
  if (proxyInfo) {
    args.push(`--proxy-server=http://${proxyInfo.host}:${proxyInfo.port}`);
  }
  let executablePath;

  if (process.env.PUPPETEER_EXECUTABLE_PATH && process.env.PUPPETEER_EXECUTABLE_PATH.length > 1) {
    log.info('launching chromium from PUPPETEER_EXECUTABLE_PATH');
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else if (IS_SERVERLESS) {
    try {
      const chromium = require('@sparticuz/chromium');
      log.info('launching chromium via @sparticuz/chromium');
      executablePath = await chromium.executablePath();
      args.push(...chromium.args);
    } catch (err) {
      log.warn(`@sparticuz/chromium unavailable: ${err.message}`);
    }
  } else {
    log.info('launching chromium (local auto-detect)');
    executablePath = _detectLocalChrome();
  }

  const launchOpts = {
    headless: true,
    args,
    ...(executablePath ? { executablePath } : {}),
    defaultViewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  };

  const userDataDir = _buildUserDataDir();
  if (userDataDir) {
    launchOpts.userDataDir = userDataDir;
  }

  try {
    const browser = await puppeteerCore.launch(launchOpts);
    if (proxyInfo && proxyInfo.username) {
      browser._proxyAuth = { username: proxyInfo.username, password: proxyInfo.password };
    }
    log.debug('browser launched locally');
    return browser;
  } catch (err) {
    log.error(`browser launch failed: ${err.message}`);
    throw err;
  }
}

function _buildUserDataDir() {
  // On serverless runtimes /tmp can be tiny or exhausted; Chromium can still launch
  // without forcing a dedicated profile dir, so only allocate one when it is safe.
  if (IS_SERVERLESS) {
    return undefined;
  }

  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer_dev_profile-'));
  } catch (err) {
    log.warn(`could not allocate browser profile dir: ${err.message}`);
    return undefined;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _baseArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
  ];
}

function _detectLocalChrome() {
  const { platform } = process;
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].find(p => { try { require('fs').accessSync(p); return true; } catch { return false; } }) || undefined;
  }
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  // Linux
  return '/usr/bin/chromium-browser' || '/usr/bin/chromium' || '/usr/bin/google-chrome' || undefined;
}

/**
 * Apply key stealth evasions to a page to avoid headless Chrome detection.
 * Lighter alternative to puppeteer-extra-plugin-stealth that works on Vercel.
 * Call BEFORE navigating to any page.
 */
async function applyStealthEvasions(page) {
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Chrome runtime (non-headless Chrome always has this)
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
      window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
    }

    // Realistic plugins array
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    // Realistic languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // Permissions API — prevent detection via Notification permission
    const origQuery = window.Permissions?.prototype?.query;
    if (origQuery) {
      window.Permissions.prototype.query = function (params) {
        if (params?.name === 'notifications') {
          return Promise.resolve({ state: 'denied', onchange: null });
        }
        return origQuery.call(this, params);
      };
    }
  });
}

module.exports = { launchBrowser, applyStealthEvasions };
