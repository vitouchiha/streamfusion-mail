#!/usr/bin/env node
const https = require('https');
const AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';

function fetchWorker(url) {
  return new Promise((resolve, reject) => {
    const wu = `https://kisskh-proxy.vitobsfm.workers.dev/?url=${encodeURIComponent(url)}&auth=${AUTH}`;
    https.get(wu, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function main() {
  const season = parseInt(process.argv[2] || '1');
  const episode = parseInt(process.argv[3] || '1');
  console.log(`Testing S${season}E${episode}\n`);

  const raw = await fetchWorker('https://eurostream.ing/wp-json/wp/v2/posts/77498?_fields=content,title');
  const post = JSON.parse(raw);
  const html = post.content?.rendered || '';

  // === Test 1: Current regex (from findEpisodeStreams) ===
  const episodePadded = String(episode).padStart(2, '0');
  const re = new RegExp(
    `\\b${season}&#215;${episodePadded}\\s*(.*?)(?=<br\\s*/?>)`,
    'gis'
  );
  const matches = [...html.matchAll(re)];
  console.log(`Current regex matches: ${matches.length}`);
  matches.forEach((m, i) => {
    console.log(`  Match ${i + 1}: ${m[1].substring(0, 200)}`);
  });

  // === Test 2: Check what char is before the episode number ===
  const searchStr = `${season}&#215;${episodePadded}`;
  let idx = 0;
  let count = 0;
  while ((idx = html.indexOf(searchStr, idx)) !== -1) {
    count++;
    const before = html.substring(Math.max(0, idx - 30), idx);
    const after = html.substring(idx, idx + searchStr.length + 80);
    console.log(`\n  Occurrence ${count} at pos ${idx}:`);
    console.log(`    Before: ${JSON.stringify(before)}`);
    console.log(`    Match+after: ${JSON.stringify(after.substring(0, 120))}`);

    // What char is right before the digit?
    const charBefore = html[idx - 1];
    console.log(`    Char before '${season}': '${charBefore}' (code ${charBefore?.charCodeAt(0)})`);
    idx += searchStr.length;
  }
  console.log(`\nTotal occurrences of '${searchStr}': ${count}`);

  // === Test 3: Spoiler sections ===
  const spoilerRe = /su-spoiler-title[^>]*>(?:<[^>]*>)*\s*([^<]+)/gi;
  const spoilers = [...html.matchAll(spoilerRe)];
  console.log('\n=== Spoiler sections: ===');
  spoilers.forEach((m, i) => {
    const title = m[1].trim();
    // Find position of this spoiler's content
    const contentStart = html.indexOf('su-spoiler-content', m.index);
    const nextSpoiler = html.indexOf('su-spoiler-title', m.index + 10);
    const sectionHtml = html.substring(contentStart, nextSpoiler > 0 ? nextSpoiler : contentStart + 500);
    // Count episodes in this section
    const epCount = (sectionHtml.match(new RegExp(`\\d+&#215;\\d+`, 'g')) || []).length;
    console.log(`  ${i + 1}. "${title}" — ${epCount} episodes`);
  });
}

main().catch(e => console.error(e));
