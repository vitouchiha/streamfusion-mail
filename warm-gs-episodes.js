#!/usr/bin/env node
/**
 * warm-gs-episodes.js — Build a player-link cache for GuardoSerie episodes.
 *
 * For each series in gs-titles-index.json:
 *   1. Fetch the /serie/{slug}/ page → extract episode URLs
 *   2. Fetch each episode page → extract player links (loadm, uqload, dropload)
 *   3. Save mapping: "slug-stagione-S-episodio-E" → [{url, label}]
 *
 * Output: gs-episodes-index.json  (~slug-SxE → player URLs)
 *
 * Run from local machine (residential IP — CF blocks cloud IPs).
 *
 *   node warm-gs-episodes.js [--limit N] [--continue] [--slug breaking-bad] [--deploy]
 *
 * Options:
 *   --limit N      Max series to process (default: all)
 *   --continue     Resume from existing gs-episodes-index.json
 *   --slug SLUG    Process specific series only (comma-separated)
 *   --delay MS     Delay between requests (default: 200)
 *   --deploy       After warm-up, git add + commit + push to deploy the cache
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://guardoserie.website';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
};

const INDEX_PATH = path.resolve(__dirname, 'gs-titles-index.json');
const OUT_PATH = path.resolve(__dirname, 'gs-episodes-index.json');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const LIMIT = Number(getArg('limit')) || Infinity;
const CONTINUE = hasFlag('continue');
const ONLY_SLUGS = getArg('slug')?.split(',').map(s => s.trim()).filter(Boolean) || null;
const DELAY = Number(getArg('delay')) || 200;
const DEPLOY = hasFlag('deploy');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!r.ok) return null;
  return r.text();
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Extract /episodio/ links from a /serie/ page HTML.
 * Returns [{slug: "show-stagione-1-episodio-1", url: "https://..."}]
 */
function extractEpisodeLinks(html, serieSlug) {
  const results = [];
  const seen = new Set();
  const re = /href="(https?:\/\/[^"]*\/episodio\/([^"\/]+))\/?"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].replace(/\/$/, '') + '/';
    const epSlug = m[2];
    // Only include episodes for this series
    if (!epSlug.startsWith(serieSlug + '-stagione-')) continue;
    if (seen.has(epSlug)) continue;
    seen.add(epSlug);
    results.push({ slug: epSlug, url });
  }
  return results;
}

/**
 * Extract player links from an episode page HTML.
 * Returns [{url, label}] — same format as extractAllPlayerLinksFromHtml.
 */
function extractPlayersFromHtml(html) {
  const players = [];
  const seen = new Set();

  // 1. Numbered tabs (#tab1, #tab2, …)
  const tabRegex = /<div[^>]+id="tab(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]+id="tab\d+"|<\/div>\s*<\/div>\s*$)/gi;
  let tabMatch;
  while ((tabMatch = tabRegex.exec(html)) !== null) {
    const tabContent = tabMatch[2];
    const labelMatch = html.match(new RegExp(`<a[^>]+href="#tab${tabMatch[1]}"[^>]*>([^<]+)<`, 'i'));
    const label = labelMatch ? labelMatch[1].trim() : null;
    for (const url of extractPlayerUrls(tabContent)) {
      if (!seen.has(url)) { seen.add(url); players.push({ url, label }); }
    }
  }

  // 2. Fallback: extract ALL player URLs from full HTML
  if (players.length === 0) {
    for (const url of extractPlayerUrls(html)) {
      if (!seen.has(url)) { seen.add(url); players.push({ url, label: null }); }
    }
  }

  return players;
}

function extractPlayerUrls(block) {
  const results = [];

  // iframe src / data-src
  const iframeTags = block.match(/<iframe\b[^>]*>/ig) || [];
  for (const tag of iframeTags) {
    const attrRegex = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(tag)) !== null) {
      const url = normalizeUrl(attrMatch[2]);
      if (url) results.push(url);
    }
  }

  // data-src/data-url anywhere (DooPlay lazy-loaded)
  const dataSrcRe = /data-(?:src|url)=["'](https?:\/\/[^"']+(?:loadm|uqload|dropload)[^"']*)["']/gi;
  let dsm;
  while ((dsm = dataSrcRe.exec(block)) !== null) {
    const url = normalizeUrl(dsm[1]);
    if (url && !results.includes(url)) results.push(url);
  }

  // Direct URL fallback
  if (results.length === 0) {
    const directRe = /https?:\/\/(?:www\.)?(?:loadm|uqload|dropload)\.[^"'<\s]+/ig;
    const matches = block.match(directRe) || [];
    for (const raw of matches) {
      const url = normalizeUrl(raw);
      if (url && !results.includes(url)) results.push(url);
    }
  }

  return results;
}

function normalizeUrl(link) {
  if (!link) return null;
  let normalized = link.trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
  if (!normalized || normalized.startsWith('data:')) return null;
  if (normalized.startsWith('//')) normalized = `https:${normalized}`;
  if (!/^https?:\/\//i.test(normalized)) return null;
  // Only keep known player hosts
  if (!/(?:loadm|uqload|dropload)/i.test(normalized)) return null;
  return normalized;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(INDEX_PATH)) {
    console.error('❌ gs-titles-index.json not found. Run warm-gs-cache.js first.');
    process.exit(1);
  }

  const titlesIndex = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));

  // Collect unique slugs
  const slugs = new Set();
  for (const entries of Object.values(titlesIndex)) {
    for (const e of entries) slugs.add(e.slug);
  }

  let targetSlugs = ONLY_SLUGS ? ONLY_SLUGS : [...slugs];
  if (LIMIT < Infinity) targetSlugs = targetSlugs.slice(0, LIMIT);

  // Load existing index if --continue
  let episodesIndex = {};
  if (CONTINUE && fs.existsSync(OUT_PATH)) {
    episodesIndex = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
    console.log(`📂 Loaded existing index: ${Object.keys(episodesIndex).length} episodes`);
  }

  // Track which series already have all episodes cached
  const cachedSeries = new Set();
  if (CONTINUE) {
    for (const key of Object.keys(episodesIndex)) {
      const serieSlug = key.replace(/-stagione-\d+-episodio-\d+$/, '');
      cachedSeries.add(serieSlug);
    }
  }

  console.log(`🔍 Processing ${targetSlugs.length} series...`);
  let processedSeries = 0;
  let processedEpisodes = 0;
  let newEpisodes = 0;

  for (const slug of targetSlugs) {
    if (CONTINUE && cachedSeries.has(slug)) {
      processedSeries++;
      continue;
    }

    const serieUrl = `${BASE}/serie/${slug}/`;

    try {
      const serieHtml = await fetchHtml(serieUrl);
      if (!serieHtml) {
        console.log(`  ⚠ ${slug}: HTTP error`);
        processedSeries++;
        await delay(DELAY);
        continue;
      }

      const episodes = extractEpisodeLinks(serieHtml, slug);
      if (episodes.length === 0) {
        console.log(`  ⚠ ${slug}: no episodes found`);
        processedSeries++;
        await delay(DELAY);
        continue;
      }

      let serieNewEps = 0;
      for (const ep of episodes) {
        if (episodesIndex[ep.slug]) {
          processedEpisodes++;
          continue; // already cached
        }

        await delay(DELAY);
        try {
          const epHtml = await fetchHtml(ep.url);
          if (!epHtml) {
            processedEpisodes++;
            continue;
          }

          const players = extractPlayersFromHtml(epHtml);
          if (players.length > 0) {
            episodesIndex[ep.slug] = players;
            serieNewEps++;
            newEpisodes++;
          }
          processedEpisodes++;
        } catch {
          processedEpisodes++;
        }
      }

      processedSeries++;
      console.log(
        `  ✓ ${slug}: ${episodes.length} eps, ${serieNewEps} new` +
        ` | total: ${processedSeries}/${targetSlugs.length} series, ${newEpisodes} new eps`
      );

      // Save periodically (every 10 series)
      if (processedSeries % 10 === 0) {
        fs.writeFileSync(OUT_PATH, JSON.stringify(episodesIndex));
      }

    } catch (e) {
      console.log(`  ⚠ ${slug}: ${e.message}`);
      processedSeries++;
    }

    await delay(DELAY);
  }

  // Final save
  fs.writeFileSync(OUT_PATH, JSON.stringify(episodesIndex));
  const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  console.log(`\n✅ Done! ${Object.keys(episodesIndex).length} episodes cached (${sizeKB} KB)`);
  console.log(`   New episodes this run: ${newEpisodes}`);

  return newEpisodes;
}

// ── Git deploy ───────────────────────────────────────────────────────────────
const { execSync } = require('child_process');

async function gitDeploy() {
  const cwd = __dirname;
  const run = (cmd) => {
    console.log(`  $ ${cmd}`);
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  };

  // Check if there are actual changes
  const diff = run('git diff --stat gs-episodes-index.json');
  if (!diff) {
    console.log('📦 No changes in gs-episodes-index.json, skipping deploy.');
    return;
  }

  console.log('\n🚀 Deploying updated episode cache...');
  run('git add gs-episodes-index.json');

  const count = Object.keys(JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'))).length;
  const msg = `chore: update gs-episodes-index (${count} episodes)`;
  run(`git commit -m "${msg}"`);

  const pushOut = run('git push origin master');
  console.log(pushOut || '  (pushed)');
  console.log('✅ Deploy complete — Vercel will pick up the new cache.');
}

main()
  .then(async (newEps) => {
    if (DEPLOY && newEps > 0) {
      await gitDeploy();
    } else if (DEPLOY) {
      console.log('📦 No new episodes, skipping deploy.');
    }
  })
  .catch(e => { console.error('Fatal:', e); process.exit(1); });
