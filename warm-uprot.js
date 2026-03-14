#!/usr/bin/env node
'use strict';

/**
 * warm-uprot.js — Pre-solve uprot captcha and persist cookies to CF Worker KV.
 * 
 * Run locally (residential IP) to warm-up cookies for the server.
 * Cookies persist ~22h in KV, surviving Vercel cold starts.
 * 
 * Usage: node warm-uprot.js
 * 
 * Add to crontab for auto-refresh (every 20h):
 *   node warm-uprot.js >> warm-uprot.log 2>&1
 */

process.env.CF_WORKER_AUTH = process.env.CF_WORKER_AUTH || 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';

const { extractUprot } = require('./src/extractors/uprot');

const CF_WORKER_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';
const auth = process.env.CF_WORKER_AUTH;

async function checkKvStatus() {
  try {
    const resp = await fetch(`${CF_WORKER_URL}/?uprot_kv=1&auth=${encodeURIComponent(auth)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.t) {
      const ageMin = Math.round((Date.now() - data.t) / 60000);
      return { age: ageMin, hasCookies: !!(data.cookies && data.cookies.PHPSESSID) };
    }
    return { age: null, hasCookies: false };
  } catch { return null; }
}

(async () => {
  console.log(`[${new Date().toISOString()}] warm-uprot: Starting...`);
  
  // Check current KV status
  const status = await checkKvStatus();
  if (status) {
    console.log(`  KV status: ${status.hasCookies ? 'has cookies' : 'no cookies'}, age: ${status.age ?? 'unknown'} min`);
    if (status.hasCookies && status.age !== null && status.age < 20 * 60) {
      console.log('  Cookies still valid, skipping solve.');
      return;
    }
  }

  // Solve fresh captcha
  console.log('  Solving uprot captcha...');
  const start = Date.now();
  const result = await extractUprot('https://uprot.net/msf/r4hcq47tarq8');
  const elapsed = Math.round((Date.now() - start) / 1000);
  
  if (result && result.url) {
    console.log(`  OK: solved in ${elapsed}s → ${result.url.substring(0, 80)}`);
    
    // Verify KV was saved
    const check = await checkKvStatus();
    if (check && check.hasCookies) {
      console.log(`  KV: cookies saved (age: ${check.age} min)`);
    } else {
      console.log('  WARNING: KV save may have failed, check CF Worker logs');
    }
  } else {
    console.log(`  FAILED: could not solve captcha in ${elapsed}s`);
    process.exit(1);
  }
})();
