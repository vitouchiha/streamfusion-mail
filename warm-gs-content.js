/**
 * warm-gs-content.js — Warm GuardoSerie episode pages into CF Worker KV.
 *
 * Scrapes series/episode pages from guardoserie.website (works from residential IP)
 * and pushes them to CF Worker KV via ?gs_push=1 endpoint.
 *
 * The provider's _cfWorkerFetch → Worker proxy → KV fallback chain then serves
 * these cached pages when live fetch fails (CF 403).
 *
 * Usage:
 *   node warm-gs-content.js                     # warm all shows in index
 *   node warm-gs-content.js "rick and morty"     # warm specific show(s)
 *   node warm-gs-content.js --top 50             # warm first 50 shows
 *   node warm-gs-content.js --slug rick-and-morty # warm by slug
 *
 * Requires: CF_WORKER_URL and CF_WORKER_AUTH env vars (or .env file)
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
// Read active domain from provider_urls.json (auto-updated by CF Worker cron)
let BASE = 'https://guardoserie.website';
try {
  const urls = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'provider_urls.json'), 'utf-8'));
  if (urls?.guardoserie) BASE = urls.guardoserie.replace(/\/$/, '');
} catch { /* fallback to default */ }
// Normalize any guardoserie variant → .digital (canonical KV domain)
function _normalizeGsUrl(url) { return url.replace(/guardoserie\.[a-z]+/gi, 'guardoserie.digital'); }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
};
const DELAY_MS = 400;        // delay between fetches (polite scraping)
const PUSH_BATCH_SIZE = 10;  // pages per push request
const EP_FETCH_TIMEOUT = 15000;

// ── Load env ────────────────────────────────────────────────────────────────
try {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch { /* no .env */ }

const CF_WORKER_URL = (process.env.CF_WORKER_URL || '').trim();
const CF_WORKER_AUTH = (process.env.CF_WORKER_AUTH || '').trim();
if (!CF_WORKER_URL) {
  console.error('❌ CF_WORKER_URL not set. Set it in env or .env file.');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function fetchPage(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(EP_FETCH_TIMEOUT), redirect: 'follow' });
  if (!r.ok) return null;
  const html = await r.text();
  if (html.includes('Just a moment') || html.includes('Checking your browser')) return null;
  return html;
}

function extractEpisodeUrls(seriesHtml) {
  const blocks = seriesHtml.split(/class=['"]les-content['"]/i);
  const seasons = [];
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i].substring(0, 10000);
    const re = /href=['"]([^'"]*\/episodio\/[^'"]*)['"]/gi;
    const eps = [];
    let m;
    while ((m = re.exec(b)) !== null) eps.push(m[1].replace(/\/$/, '') + '/');
    seasons.push(eps);
  }
  return seasons;
}

async function pushToKv(pages) {
  if (pages.length === 0) return { ok: true, stored: 0 };
  const pushUrl = new URL(CF_WORKER_URL.replace(/\/$/, ''));
  pushUrl.searchParams.set('gs_push', '1');
  const headers = { 'Content-Type': 'application/json' };
  if (CF_WORKER_AUTH) headers['x-worker-auth'] = CF_WORKER_AUTH;

  const body = pages.map(p => ({
    url: _normalizeGsUrl(p.url),
    html: p.html 
  }));

  const r = await fetch(pushUrl.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ────────────────────────────────────────────────────────────────────
async function warmShow(slug, title) {
  console.log(`\n📺 ${title || slug}`);
  
  // 1. Fetch series page
  const seriesUrl = `${BASE}/serie/${slug}/`;
  const seriesHtml = await fetchPage(seriesUrl);
  if (!seriesHtml) {
    console.log('   ❌ Could not fetch series page');
    return { slug, seasons: 0, episodes: 0, pushed: 0, error: 'series_fetch_failed' };
  }

  const seasons = extractEpisodeUrls(seriesHtml);
  const totalEps = seasons.reduce((s, eps) => s + eps.length, 0);
  console.log(`   ${seasons.length} seasons, ${totalEps} episodes`);

  // Queue: series page + all episode pages
  const pushQueue = [{ url: seriesUrl, html: seriesHtml }];
  let fetchedEps = 0;
  let failedEps = 0;

  for (let si = 0; si < seasons.length; si++) {
    const eps = seasons[si];
    for (let ei = 0; ei < eps.length; ei++) {
      const epUrl = eps[ei];
      try {
        await sleep(DELAY_MS);
        const epHtml = await fetchPage(epUrl);
        if (epHtml) {
          pushQueue.push({ url: epUrl, html: epHtml });
          fetchedEps++;
        } else {
          failedEps++;
          console.log(`   ⚠️ S${si + 1}E${ei + 1}: fetch failed`);
        }
      } catch (e) {
        failedEps++;
        console.log(`   ⚠️ S${si + 1}E${ei + 1}: ${e.message}`);
      }

      // Push in batches
      if (pushQueue.length >= PUSH_BATCH_SIZE) {
        try {
          const result = await pushToKv(pushQueue.splice(0));
          process.stdout.write(`   ✅ pushed ${result.stored || 0} pages  \r`);
        } catch (e) {
          console.log(`   ❌ KV push error: ${e.message}`);
        }
      }
    }
  }

  // Push remaining
  let totalPushed = fetchedEps + 1; // +1 for series page
  if (pushQueue.length > 0) {
    try {
      const result = await pushToKv(pushQueue);
      process.stdout.write('');
    } catch (e) {
      console.log(`   ❌ Final KV push error: ${e.message}`);
    }
  }

  console.log(`   ✅ ${fetchedEps}/${totalEps} episodes fetched, ${failedEps} failed, pushed to KV`);
  return { slug, seasons: seasons.length, episodes: totalEps, fetched: fetchedEps, failed: failedEps, pushed: totalPushed };
}

async function main() {
  const args = process.argv.slice(2);

  // Load titles index
  const indexPath = path.resolve(__dirname, 'gs-titles-index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('❌ gs-titles-index.json not found. Run warm-gs-cache.js first.');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const allKeys = Object.keys(index);
  console.log(`📦 Loaded titles index: ${allKeys.length} entries`);

  let targets = [];

  if (args.length === 0) {
    // Warm all shows
    const seen = new Set();
    for (const entries of Object.values(index)) {
      for (const e of entries) {
        if (!seen.has(e.slug)) {
          seen.add(e.slug);
          targets.push({ slug: e.slug, title: null });
        }
      }
    }
    console.log(`🔥 Warming ALL ${targets.length} shows...`);
  } else if (args[0] === '--top') {
    const count = parseInt(args[1]) || 50;
    const seen = new Set();
    for (const entries of Object.values(index)) {
      for (const e of entries) {
        if (!seen.has(e.slug)) {
          seen.add(e.slug);
          targets.push({ slug: e.slug, title: null });
        }
      }
    }
    targets = targets.slice(0, count);
    console.log(`🔥 Warming top ${targets.length} shows...`);
  } else if (args[0] === '--slug') {
    const slug = args[1];
    if (!slug) { console.error('Usage: --slug <slug>'); process.exit(1); }
    targets = [{ slug, title: slug.replace(/-/g, ' ') }];
  } else {
    // Search by title
    const query = args.join(' ').toLowerCase().trim();
    const qNorm = query.replace(/[^a-z0-9]/g, '');
    for (const [key, entries] of Object.entries(index)) {
      const keyNorm = key.replace(/[^a-z0-9]/g, '');
      if (keyNorm === qNorm || keyNorm.includes(qNorm) || qNorm.includes(keyNorm)) {
        for (const e of entries) {
          if (!targets.some(t => t.slug === e.slug)) {
            targets.push({ slug: e.slug, title: key });
          }
        }
      }
    }
    if (targets.length === 0) {
      console.log(`❌ No match found for "${query}"`);
      process.exit(1);
    }
    console.log(`🔥 Found ${targets.length} matching show(s) for "${query}"`);
  }

  const stats = { total: targets.length, ok: 0, failed: 0, episodes: 0 };
  for (const t of targets) {
    try {
      const result = await warmShow(t.slug, t.title);
      if (result.error) stats.failed++;
      else { stats.ok++; stats.episodes += result.fetched || 0; }
    } catch (e) {
      console.log(`   ❌ Unexpected error: ${e.message}`);
      stats.failed++;
    }
  }

  console.log(`\n════════════════════════════════════════════`);
  console.log(`✅ Done: ${stats.ok}/${stats.total} shows, ${stats.episodes} episodes pushed to KV`);
  if (stats.failed > 0) console.log(`⚠️ ${stats.failed} shows failed`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
