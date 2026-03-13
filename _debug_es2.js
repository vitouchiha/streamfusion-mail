#!/usr/bin/env node
const https = require('https');
const AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';

function fetchW(u) {
  return new Promise((ok, ko) => {
    https.get('https://kisskh-proxy.vitobsfm.workers.dev/?url=' + encodeURIComponent(u) + '&auth=' + AUTH, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => ok(d));
    }).on('error', ko);
  });
}

async function main() {
  const raw = await fetchW('https://eurostream.ing/wp-json/wp/v2/posts/77498?_fields=content,title');
  const html = JSON.parse(raw).content.rendered;

  // Parse spoiler sections
  const sectionRe = /su-spoiler-title[^>]*>(?:<[^>]*>)*\s*([^<]+)<\/(?:span|div)>[\s\S]*?su-spoiler-content[^"]*">([\s\S]*?)<\/div>\s*<\/div>/gi;
  const sections = [...html.matchAll(sectionRe)];
  
  console.log('=== Spoiler sections and their episodes ===\n');
  for (const sec of sections) {
    const title = sec[1].trim();
    const content = sec[2];
    
    // Parse episodes from this section
    const epRe = /(\d+)&#215;(\d+)\s*(.*?)(?=<br\s*\/?>|\d+&#215;|\n*$)/gis;
    const eps = [...content.matchAll(epRe)];
    
    console.log(`\n--- ${title} (${eps.length} episodes) ---`);
    // Show first 2 episodes
    for (const ep of eps.slice(0, 2)) {
      const s = ep[1], e = ep[2], rest = ep[3].trim();
      const links = [...rest.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi)];
      const players = links.map(l => `${l[2].trim()} → ${l[1].substring(0, 50)}`);
      console.log(`  ${s}x${e}: ${players.length} players`);
      players.forEach(p => console.log(`    ${p}`));
      if (players.length === 0) console.log(`    (no links, text: ${rest.substring(0, 80)})`);
    }
  }
  
  // Now test S1E1 through findEpisodeStreams logic
  console.log('\n\n=== findEpisodeStreams simulation for S1E1 ===');
  const season = 1, episode = 1;
  const episodePadded = String(episode).padStart(2, '0');
  const re = new RegExp(
    `\\b${season}&#215;${episodePadded}\\s*(.*?)(?=<br\\s*/?>)`,
    'gis'
  );
  const matches = [...html.matchAll(re)];
  console.log(`Matches: ${matches.length}`);
  for (let t = 0; t < matches.length; t++) {
    const matchText = matches[t][1] || '';
    const parts = matchText.split(/\s*[–\-]\s*/u);
    const atag = parts.length > 1 ? parts.slice(1).join(' – ') : matchText;
    const language = t === 0 ? '\nITA' : '\nSUB-ITA';
    console.log(`\nMatch ${t + 1} (${language.trim()}):`);
    console.log(`  Full match: ${matchText.substring(0, 200)}`);
    console.log(`  Has href: ${atag.includes('href')}`);
    console.log(`  atag: ${atag.substring(0, 200)}`);
    
    // Check which players
    const hasMixDrop = /MixDrop/i.test(atag);
    const hasDeltaBit = /DeltaBit/i.test(atag);
    const hasMaxStream = /MaxStream/i.test(atag);
    const hasTurbovid = /Turbovid/i.test(atag);
    console.log(`  Players: MixDrop=${hasMixDrop} DeltaBit=${hasDeltaBit} MaxStream=${hasMaxStream} Turbovid=${hasTurbovid}`);
    
    // Extract hrefs
    const hrefRe = /<a\s[^>]*href="([^"]+)"[^>]*>\s*(\S+)\s*<\/a>/gi;
    const hrefs = [...atag.matchAll(hrefRe)];
    hrefs.forEach(h => console.log(`    ${h[2]}: ${h[1]}`));
  }
  
  // Same for S4E1
  console.log('\n\n=== findEpisodeStreams simulation for S4E1 ===');
  const re4 = new RegExp(`\\b4&#215;01\\s*(.*?)(?=<br\\s*/?>)`, 'gis');
  const m4 = [...html.matchAll(re4)];
  console.log(`Matches: ${m4.length}`);
  for (let t = 0; t < m4.length; t++) {
    const matchText = m4[t][1] || '';
    const parts = matchText.split(/\s*[–\-]\s*/u);
    const atag = parts.length > 1 ? parts.slice(1).join(' – ') : matchText;
    const language = t === 0 ? '\nITA' : '\nSUB-ITA';
    console.log(`\nMatch ${t + 1} (${language.trim()}):`);
    console.log(`  atag: ${atag.substring(0, 300)}`);
    const hasMixDrop = /MixDrop/i.test(atag);
    const hasDeltaBit = /DeltaBit/i.test(atag);
    console.log(`  Players: MixDrop=${hasMixDrop} DeltaBit=${hasDeltaBit}`);
    const hrefRe = /<a\s[^>]*href="([^"]+)"[^>]*>\s*(\S+)\s*<\/a>/gi;
    const hrefs = [...atag.matchAll(hrefRe)];
    hrefs.forEach(h => console.log(`    ${h[2]}: ${h[1]}`));
  }
}

main().catch(e => console.error(e));
