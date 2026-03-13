// Pre-warm the KV cache by calling the Worker from a non-blocked edge
const WORKER = 'https://kisskh-proxy.vitobsfm.workers.dev';
const AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';
const hdr = { 'x-worker-auth': AUTH };

async function warm(label, targetUrl, opts = {}) {
  const u = new URL(WORKER);
  u.searchParams.set('url', targetUrl);
  if (opts.nofollow) u.searchParams.set('nofollow', '1');
  if (opts.wantCookie) u.searchParams.set('wantCookie', '1');
  const r = await fetch(u.toString(), { headers: hdr, signal: AbortSignal.timeout(15000) });
  const cache = r.headers.get('x-kv-cache') || 'miss';
  const body = await r.text();
  const blocked = body.includes('Just a moment');
  console.log(`${label}: ${r.status} cache:${cache} blocked:${blocked} len:${body.length}`);
  return body;
}

async function warmSearch(query) {
  console.log(`\n--- Warming: "${query}" ---`);

  // 1. Search (matches scraper's exact URL format)
  const searchUrl = `https://eurostream.ing/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&_fields=id,subtype&per_page=10`;
  const searchBody = await warm('  Search', searchUrl);

  let results;
  try { results = JSON.parse(searchBody); } catch { console.log('  Failed to parse search'); return; }
  if (!results.length) { console.log('  No results'); return; }

  // 2. Warm each post via WP REST API (matches scraper's exact URL)
  for (const r of results.filter(x => x.subtype === 'post').slice(0, 3)) {
    const postUrl = `https://eurostream.ing/wp-json/wp/v2/posts/${r.id}?_fields=content,title`;
    const postBody = await warm(`  Post ${r.id}`, postUrl);

    let content;
    try {
      const post = JSON.parse(postBody);
      content = post?.content?.rendered || '';
    } catch { console.log('  Failed to parse post'); continue; }

    // 3. Find and warm clicka.cc redirects
    const deltaRe = /href="(https?:\/\/clicka\.cc\/delta\/[^"]+)"/gi;
    const deltas = [];
    let m;
    while ((m = deltaRe.exec(content)) !== null) deltas.push(m[1]);
    console.log(`  Delta links: ${deltas.length}`);

    for (let i = 0; i < Math.min(deltas.length, 10); i++) {
      await warm(`    Delta ${i}`, deltas[i], { nofollow: true });
    }
  }
}

(async () => {
  console.log('=== Warming KV cache ===');
  const shows = process.argv.slice(2);
  if (shows.length === 0) shows.push('Snowpiercer');
  for (const show of shows) {
    await warmSearch(show);
  }
  console.log('\n=== Done ===');
})();
