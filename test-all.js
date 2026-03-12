const https = require('https');
const http = require('http');

function fetch(url, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ streams: [] }); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const addons = [
  { name: 'NelloStream', url: 'https://streamfusion-mail.vercel.app' },
  { name: 'StreamVix', url: 'https://streamvix.hayd.uk' },
  { name: 'EasyStreams', url: 'https://easystreams.stremio.dpdns.org' },
  { name: 'MammaMia', url: 'https://mammamia.stremio.dpdns.org' },
];

const titles = [
  { name: 'Barbie (movie)', type: 'movie', id: 'tt1517268' },
  { name: 'Squid Game S2E1', type: 'series', id: 'tt10919420:2:1' },
  { name: 'Our Universe S1E4', type: 'series', id: 'tt39453765:1:4' },
  { name: 'One Piece S1E1', type: 'series', id: 'tt0388629:1:1' },
];

async function testOne(addon, title) {
  const url = `${addon.url}/stream/${title.type}/${title.id}.json`;
  try {
    const data = await fetch(url, 60000);
    const streams = data.streams || [];
    const providers = streams.map(s => {
      const lines = (s.name || s.title || '?').split('\n');
      return lines[lines.length - 1].trim().substring(0, 40);
    });
    const unique = [...new Set(providers)];
    return { count: streams.length, providers: unique.join(', ') };
  } catch (e) {
    return { count: -1, providers: `ERROR: ${e.message}` };
  }
}

(async () => {
  const results = {};
  
  for (const title of titles) {
    console.log(`\n=== ${title.name} ===`);
    for (const addon of addons) {
      const r = await testOne(addon, title);
      const key = `${title.name}|${addon.name}`;
      results[key] = r;
      console.log(`  ${addon.name}: ${r.count} streams [${r.providers}]`);
    }
  }
  
  // Print markdown table
  console.log('\n\n## COMPARISON TABLE\n');
  console.log('| Title | NelloStream | StreamVix | EasyStreams | MammaMia |');
  console.log('|-------|------------|-----------|------------|----------|');
  for (const title of titles) {
    const cols = addons.map(a => {
      const r = results[`${title.name}|${a.name}`];
      if (r.count < 0) return 'ERROR';
      if (r.count === 0) return '0';
      return `${r.count} (${r.providers})`;
    });
    console.log(`| ${title.name} | ${cols.join(' | ')} |`);
  }
  console.log('\nDONE');
})();
