'use strict';

/**
 * warm-es-cache.js — Pre-populate static batch files with all Eurostreaming
 * posts, so Vercel can serve them without needing KV or live API access.
 *
 * Run from LOCAL MACHINE (where CF doesn't block):
 *   node warm-es-cache.js
 *
 * This fetches directly from eurostream.ing and saves:
 *   - es-cache/page-{N}.json  (one per page, 100 posts each)
 *   - es-titles-index.json    (title → [{id, page}] mapping)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ES_BASE = 'https://eurostream.ing';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const CACHE_DIR = path.join(__dirname, 'es-cache');

async function fetchPage(page) {
  const url = `${ES_BASE}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,title,content`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    if (resp.status === 400) return null; // beyond last page
    throw new Error(`HTTP ${resp.status}`);
  }
  const body = await resp.text();
  if (body.includes('Just a moment')) throw new Error('CF blocked');
  return JSON.parse(body);
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

async function main() {
  console.log('Warming Eurostreaming cache (direct fetch)...\n');

  // Ensure cache directory exists
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const start = Date.now();
  const allTitles = {};
  let totalPosts = 0;
  let totalBytes = 0;
  const maxPages = 100;

  for (let page = 1; page <= maxPages; page++) {
    try {
      process.stdout.write(`  Page ${page}... `);
      const posts = await fetchPage(page);
      if (!posts || !Array.isArray(posts) || posts.length === 0) {
        console.log('(empty — last page)');
        break;
      }

      totalPosts += posts.length;

      // Build batch array for this page
      const batch = posts.map(p => ({
        id: p.id,
        title: { rendered: p.title?.rendered || '' },
        content: { rendered: p.content?.rendered || '' },
      }));

      // Save batch file (gzipped to reduce size)
      const batchJson = JSON.stringify(batch);
      const batchPath = path.join(CACHE_DIR, `page-${page}.json.gz`);
      fs.writeFileSync(batchPath, zlib.gzipSync(batchJson));
      totalBytes += batchJson.length;

      // Build titles index
      for (const post of posts) {
        const title = decodeEntities(post.title?.rendered);
        if (title) {
          const key = title.toLowerCase();
          if (!allTitles[key]) allTitles[key] = [];
          allTitles[key].push({ id: post.id, page });
        }
      }

      console.log(`${posts.length} posts (${(batchJson.length / 1024).toFixed(0)} KB)`);

      if (posts.length < 100) {
        console.log('  (last page)');
        break;
      }

      // Small delay between pages
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      break;
    }
  }

  // Save titles index
  const indexPath = path.join(__dirname, 'es-titles-index.json');
  fs.writeFileSync(indexPath, JSON.stringify(allTitles));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
  console.log(`  Total posts: ${totalPosts}`);
  console.log(`  Batch files: ${totalBytes > 1024*1024 ? (totalBytes/1024/1024).toFixed(1)+' MB' : (totalBytes/1024).toFixed(0)+' KB'}`);
  console.log(`  Index entries: ${Object.keys(allTitles).length}`);
  console.log(`  Files saved to: ${CACHE_DIR}/`);
}

main();
