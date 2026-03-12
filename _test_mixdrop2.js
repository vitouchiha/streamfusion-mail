'use strict';

// Deep debug MixDrop - examine page content for video URLs
async function debugMixdropDeep(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://m1xdrop.net/'
    },
    redirect: 'follow'
  });
  const html = await resp.text();
  console.log('URL:', resp.url, 'Size:', html.length);
  
  // Search for video-related patterns
  const patterns = [
    { name: 'mp4', re: /https?:[^"'\s]*\.mp4[^"'\s]*/gi },
    { name: 'm3u8', re: /https?:[^"'\s]*\.m3u8[^"'\s]*/gi },
    { name: 'delivery/cdn', re: /https?:[^"'\s]*(?:delivery|cdn|mxcontent|dropcdn)[^"'\s]*/gi },
    { name: 'MDCore', re: /MDCore\.\w+\s*=\s*["'][^"']*/gi },
    { name: 'vsrc/wurl/src', re: /(?:vsrc|wurl|source|videoUrl|streamUrl|file)\s*[:=]\s*["'][^"']{10,}/gi },
    { name: 'player.setup', re: /player\.setup\(\{[\s\S]{0,500}/gi },
    { name: 'videojs', re: /videojs\([^)]*\)[\s\S]{0,300}/gi },
    { name: 'data-video-src', re: /data-(?:video|src|file)[^=]*=\s*["'][^"']+/gi },
    { name: 'eval(', re: /eval\([^)]{10,200}\)/gi },
    { name: 'atob/decode', re: /atob\([^)]+\)|decode[^(]*\([^)]+\)/gi },
    { name: 'window.location', re: /window\.location[^;]*/gi },
    { name: 'src="http', re: /src\s*=\s*["']https?:\/\/[^"']+/gi },
  ];
  
  for (const p of patterns) {
    const matches = html.match(p.re);
    if (matches && matches.length) {
      console.log(`\n[${p.name}] ${matches.length} match(es):`);
      matches.slice(0, 5).forEach(m => console.log('  ', m.substring(0, 200)));
    }
  }
  
  // Extract all script blocks and search for interesting vars
  const scripts = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    if (match[1].trim().length > 50) {
      scripts.push(match[1]);
    }
  }
  console.log('\n=== Inline script blocks (' + scripts.length + ') ===');
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    if (s.length > 100 && (s.includes('video') || s.includes('play') || s.includes('src') || s.includes('MDCore') || s.includes('eval'))) {
      console.log(`\n--- Script #${i} (${s.length} chars) ---`);
      console.log(s.substring(0, 1000));
    }
  }
}

(async () => {
  await debugMixdropDeep('https://m1xdrop.net/e/nlx0oj3kcqkwq9');
})();
