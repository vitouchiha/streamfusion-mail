'use strict';

const { fetchWithCloudscraper } = require('./src/utils/fetcher');
const { extractMixDrop } = require('./src/extractors/mixdrop');
const { extractMaxStream } = require('./src/extractors/maxstream');

async function testCb01Movie() {
  console.log('\n=== CB01 Movie Debug (Barbie 2023) ===');
  
  // 1. Search
  const html = await fetchWithCloudscraper('https://cb01uno.uno/?s=Barbie', { referer: 'https://cb01uno.uno/', retries: 1 });
  if (!html) { console.log('CB01 search returned NULL'); return; }
  
  // Find matches
  const cardRe = /<div[^>]+class="card-content"[\s\S]*?<h3[^>]+class="card-title"[^>]*>\s*<a[^>]+href="([^"]+)"/gi;
  const matches = [];
  for (const m of html.matchAll(cardRe)) {
    const href = m[1];
    const slug = href.split('/').filter(Boolean).pop() || href;
    const ym = /(19|20)\d{2}/.exec(slug);
    matches.push({ href, year: ym ? ym[0] : null });
  }
  console.log('Search results:', matches.length);
  matches.forEach(m => console.log('  ', m.year, m.href));
  
  // 2. Pick the 2023 match
  const target = matches.find(m => m.year === '2023');
  if (!target) { console.log('No 2023 match found'); return; }
  console.log('\nFetching page:', target.href);
  
  const pageHtml = await fetchWithCloudscraper(target.href, { referer: 'https://cb01uno.uno/', retries: 1 });
  if (!pageHtml) { console.log('Page fetch returned NULL'); return; }
  
  // 3. Find iframen divs
  const iframeRe = /<div[^>]+id="(iframen\d+)"[^>]+data-src="([^"]+)"|<div[^>]+data-src="([^"]+)"[^>]+id="(iframen\d+)"/gi;
  console.log('\nIframe divs found:');
  for (const m of pageHtml.matchAll(iframeRe)) {
    const id = m[1] || m[4];
    const url = m[2] || m[3];
    console.log(' ', id, '->', url ? url.substring(0, 80) : 'NULL');
  }
  
  // 4. Try stayonline resolution
  const stayRe = /stayonline\.pro[^"']*/gi;
  const stayMatches = pageHtml.match(stayRe);
  console.log('\nStayonline URLs in page:', stayMatches ? stayMatches.length : 0);
  if (stayMatches) stayMatches.slice(0, 5).forEach(u => console.log('  ', u));
  
  // 5. Check for other embed patterns
  const embedRe = /(?:mixdrop|maxstream|uprot|supervideo|dropload)[^"'\s]*/gi;
  const embeds = pageHtml.match(embedRe);
  console.log('\nDirect embed URLs:', embeds ? embeds.length : 0);
  if (embeds) embeds.slice(0, 10).forEach(u => console.log('  ', u));
}

async function testStreamingCommunity() {
  console.log('\n=== StreamingCommunity Debug ===');
  const sc = require('./src/streamingcommunity/index');
  const t0 = Date.now();
  try {
    const streams = await sc.getStreams('tt1517268', 'movie', null, null, { primaryTitle: 'Barbie', titleCandidates: ['Barbie'] });
    console.log('SC result:', streams.length, 'streams in', Date.now() - t0, 'ms');
    streams.forEach(s => console.log('  ', s.name, s.title?.split('\n')[0]));
  } catch(e) { console.error('SC error:', e.message); }
}

async function testGuardaflix() {
  console.log('\n=== Guardaflix Debug ===');
  const gf = require('./src/guardaflix/index');
  const t0 = Date.now();
  try {
    const streams = await gf.getStreams('tt1517268', 'movie', null, null, { primaryTitle: 'Barbie', titleCandidates: ['Barbie'] });
    console.log('Guardaflix result:', streams.length, 'streams in', Date.now() - t0, 'ms');
    streams.forEach(s => console.log('  ', s.name, s.title?.split('\n')[0]));
  } catch(e) { console.error('Guardaflix error:', e.message); }
}

async function testLoonex() {
  console.log('\n=== Loonex Debug (Movie) ===');
  const loonex = require('./src/loonex/index');
  const t0 = Date.now();
  try {
    const streams = await loonex.getStreams('tt1517268', 'movie', null, null, { primaryTitle: 'Barbie', titleCandidates: ['Barbie'] });
    console.log('Loonex result:', streams.length, 'streams in', Date.now() - t0, 'ms');
    streams.forEach(s => console.log('  ', s.name, s.title?.split('\n')[0]));
  } catch(e) { console.error('Loonex error:', e.message); }
}

async function testGuardoserie() {
  console.log('\n=== Guardoserie Debug ===');
  const gs = require('./src/guardoserie/index');
  const t0 = Date.now();
  try {
    const streams = await gs.getStreams('tt1517268', 'movie', null, null, { primaryTitle: 'Barbie', titleCandidates: ['Barbie'] });
    console.log('Guardoserie result:', streams.length, 'streams in', Date.now() - t0, 'ms');
    streams.forEach(s => console.log('  ', s.name, s.title?.split('\n')[0]));
  } catch(e) { console.error('Guardoserie error:', e.message); }
}

(async () => {
  await testCb01Movie();
  await testStreamingCommunity();
  await testGuardaflix();
  await testLoonex();
  await testGuardoserie();
  console.log('\n=== All tests done ===');
})();
