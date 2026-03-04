'use strict';

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

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
const { createLogger } = require('./logger');

puppeteerExtra.use(StealthPlugin());

const log = createLogger('browser');

const IS_SERVERLESS = !!(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NETLIFY
);

/**
 * Launch (or connect to) a Puppeteer browser instance.
 *
 * If BROWSERLESS_URL is set → connect to remote Chrome via WebSocket.
 * Otherwise → launch locally (for Docker / local dev).
 *
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchBrowser() {
  const browserlessUrl = (process.env.BROWSERLESS_URL || '').trim();

  // ── Option 1: Remote Chrome via Browserless.io (recommended for Vercel) ────
  if (browserlessUrl) {
    log.info('connecting to remote Chrome via BROWSERLESS_URL');
    try {
      // Use puppeteer-core.connect() for Browserless.io.
      // puppeteer-extra.connect() fails on Vercel due to missing stealth evasion sub-modules.
      const puppeteerCore = require('puppeteer-core');
      const browser = await puppeteerCore.connect({
        browserWSEndpoint: browserlessUrl,
        defaultViewport: { width: 1280, height: 720 },
      });
      log.debug('connected to remote Chrome');
      return browser;
    } catch (err) {
      log.error(`remote Chrome connection failed: ${err.message}`);



      throw err;
    }
  }

  // ── Option 2: Local launch (Docker / dev) ───────────────────────────────────
  const args = _baseArgs();
  let executablePath;

  if (process.env.PUPPETEER_EXECUTABLE_PATH && process.env.PUPPETEER_EXECUTABLE_PATH.length > 1) {
    log.info('launching chromium from PUPPETEER_EXECUTABLE_PATH');
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
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

  try {
    const browser = await puppeteerExtra.launch(launchOpts);
    log.debug('browser launched locally');
    return browser;
  } catch (err) {
    log.error(`browser launch failed: ${err.message}`);
    throw err;
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

module.exports = { launchBrowser };
