(async () => {
  const cfBase = 'https://kisskh-proxy.vitobsfm.workers.dev';
  const cfAuth = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';
  
  // Test .digital vs .best through CF Worker
  const urls = [
    'https://guardoserie.digital/?s=breaking+bad',
    'https://guardoserie.best/?s=breaking+bad',
  ];
  
  for (const target of urls) {
    const u = `${cfBase}?url=${encodeURIComponent(target)}`;
    try {
      const r = await fetch(u, {
        headers: {'x-worker-auth': cfAuth, 'Accept': 'text/html'},
        signal: AbortSignal.timeout(15000)
      });
      const txt = await r.text();
      const isCf = txt.includes('Just a moment');
      const hasSerie = (txt.match(/\/serie\//g) || []).length;
      console.log(`${r.status} ${target.split('//')[1].split('?')[0]} cf=${isCf} /serie/=${hasSerie} len=${txt.length}`);
    } catch(e) { console.log('FAIL', target, e.message); }
  }
  
  // Now test what Vercel env vars are set  
  console.log('\nEnv check:');
  console.log('CF_WORKER_URL:', process.env.CF_WORKER_URL || 'NOT SET');
  console.log('CF_WORKER_AUTH:', process.env.CF_WORKER_AUTH ? 'SET' : 'NOT SET');
})().catch(e => console.error(e.message));
