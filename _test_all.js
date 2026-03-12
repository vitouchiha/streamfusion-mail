'use strict';

// Test MaxStream and all other extractors
const { extractMaxStream } = require('./src/extractors/maxstream');
const { extractMixDrop } = require('./src/extractors/mixdrop');

async function testExtractorDirect(name, fn, url) {
  console.log(`\n[${name}] Testing: ${url}`);
  const t0 = Date.now();
  try {
    const result = await fn(url);
    console.log(`  Result (${Date.now()-t0}ms):`, result ? { url: result.url?.substring(0, 100), hasHeaders: !!result.headers } : 'NULL');
  } catch(e) {
    console.log(`  Error (${Date.now()-t0}ms):`, e.message);
  }
}

// Test KissKH
async function testKissKH() {
  console.log('\n=== KissKH ===');
  const kisskh = require('./src/providers/kisskh');
  // Try catalog search
  const t0 = Date.now();
  const results = await kisskh.getCatalog(0, 'Our Universe', {});
  console.log(`Search (${Date.now()-t0}ms):`, results?.length || 0, 'results');
  if (results?.length) {
    results.slice(0, 3).forEach(r => console.log(`  - ${r.id}: ${r.name}`));
    // Get meta for first result
    const { meta } = await kisskh.getMeta(results[0].id, {});
    console.log(`Meta: ${meta?.videos?.length || 0} episodes`);
    if (meta?.videos?.length) {
      console.log('  First ep:', meta.videos[0].id, meta.videos[0].title);
      // Try streams
      const streams = await kisskh.getStreams(meta.videos[0].id, {});
      console.log(`Streams: ${streams?.length || 0}`);
      streams?.forEach(s => console.log('  -', s.name, s.url?.substring(0, 80)));
    }
  }
}

// Test Eurostreaming
async function testEurostreaming() {
  console.log('\n=== Eurostreaming ===');
  const euro = require('./src/eurostreaming/index');
  const t0 = Date.now();
  const streams = await euro.getStreams('tt14688458', 'series', 1, 1, { primaryTitle: 'Squid Game', titleCandidates: ['Squid Game'] });
  console.log(`Eurostreaming (${Date.now()-t0}ms):`, streams.length, 'streams');
  streams.forEach(s => console.log('  -', s.name, s.title?.split('\n')[0]));
}

// Test Guardaserie
async function testGuardaserie() {
  console.log('\n=== Guardaserie (Squid Game S1E1) ===');
  const gs = require('./src/guardaserie/index');
  const t0 = Date.now();
  const streams = await gs.getStreams('tt14688458', 'series', 1, 1, { primaryTitle: 'Squid Game', titleCandidates: ['Squid Game'] });
  console.log(`Guardaserie (${Date.now()-t0}ms):`, streams.length, 'streams');
  streams.forEach(s => console.log('  -', s.name, s.title?.split('\n')[0]));
}

// Test resolveStayOnline -> MaxStream path
async function testMaxStreamFromStayonline() {
  console.log('\n=== MaxStream via StayOnline (Barbie iframen1) ===');
  // First resolve stayonline
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  const idMatch = /stayonline\.pro\/(?:[el]\/)?([a-zA-Z0-9_-]+)/.exec('https://stayonline.pro/e/9ngpp/');
  const id = idMatch[1];
  const resp = await fetch('https://stayonline.pro/ajax/linkEmbedView.php', {
    method: 'POST',
    headers: { 'Origin': 'https://stayonline.pro', 'Referer': 'https://stayonline.pro/', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id, ref: '' }).toString(),
  });
  const data = await resp.json();
  const resolved = data?.data?.value;
  console.log('Resolved:', resolved);
  
  if (resolved && resolved.includes('uprot')) {
    console.log('This is Uprot, testing...');
    const { extractUprot } = require('./src/extractors/uprot');
    const result = await extractUprot(resolved);
    console.log('Uprot result:', result ? { url: result.url?.substring(0, 100) } : 'NULL');
  }
  
  // Also try all 4 stayonline links
  const links = [
    'https://stayonline.pro/l/lnQ3W/',
    'https://stayonline.pro/l/x0QGk/',
  ];
  for (const link of links) {
    const id2 = /stayonline\.pro\/(?:[el]\/)?([a-zA-Z0-9_-]+)/.exec(link)[1];
    const r = await fetch('https://stayonline.pro/ajax/linkEmbedView.php', {
      method: 'POST',
      headers: { 'Origin': 'https://stayonline.pro', 'Referer': 'https://stayonline.pro/', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: id2, ref: '' }).toString(),
    });
    const d = await r.json();
    console.log(`  ${link} -> ${d?.data?.value || 'NULL'}`);
  }
}

(async () => {
  await testMaxStreamFromStayonline();
  await testKissKH();
  await testEurostreaming();
  await testGuardaserie();
  console.log('\n=== All done ===');
})();
