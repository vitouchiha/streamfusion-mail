'use strict';

// Test stayonline resolution and extractors
const { extractMixDrop } = require('./src/extractors/mixdrop');
const { extractMaxStream } = require('./src/extractors/maxstream');

async function resolveStayOnline(link) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  try {
    const idMatch = /stayonline\.pro\/(?:[el]\/)?([a-zA-Z0-9_-]+)/.exec(link);
    if (!idMatch) { console.log('  No ID match for', link); return null; }
    const id = idMatch[1];
    console.log('  StayOnline ID:', id);

    const resp = await fetch('https://stayonline.pro/ajax/linkEmbedView.php', {
      method: 'POST',
      headers: {
        'Origin': 'https://stayonline.pro',
        'Referer': 'https://stayonline.pro/',
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ id, ref: '' }).toString(),
    });
    console.log('  StayOnline response status:', resp.status);
    const text = await resp.text();
    console.log('  StayOnline raw response:', text.substring(0, 200));
    try {
      const data = JSON.parse(text);
      console.log('  Resolved URL:', data?.data?.value || 'NULL');
      return data?.data?.value || null;
    } catch { return null; }
  } catch(e) {
    console.log('  StayOnline error:', e.message);
    return null;
  }
}

(async () => {
  console.log('=== Testing StayOnline resolution ===\n');
  
  const urls = [
    'https://stayonline.pro/e/9ngpp/',
    'https://stayonline.pro/e/PJyXK/',
    'https://stayonline.pro/l/lnQ3W/',
    'https://stayonline.pro/l/x0QGk/',
  ];
  
  for (const url of urls) {
    console.log('\nResolving:', url);
    const resolved = await resolveStayOnline(url);
    if (resolved) {
      console.log('  -> Resolved to:', resolved);
      const host = new URL(resolved).hostname.toLowerCase();
      console.log('  -> Host:', host);
      
      if (host.includes('mixdrop') || host.includes('m1xdrop')) {
        console.log('  -> Trying MixDrop extractor...');
        const result = await extractMixDrop(resolved);
        console.log('  -> MixDrop result:', result ? { url: result.url?.substring(0, 80), hasHeaders: !!result.headers } : 'NULL');
      } else if (host.includes('maxstream')) {
        console.log('  -> Trying MaxStream extractor...');
        const result = await extractMaxStream(resolved);
        console.log('  -> MaxStream result:', result ? { url: result.url?.substring(0, 80) } : 'NULL');
      } else {
        console.log('  -> Unknown host, no extractor');
      }
    }
  }
  
  console.log('\n=== Done ===');
})();
