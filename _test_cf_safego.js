// Test: simulate the safego captcha flow through CF Worker proxy (as it would run on Vercel)
'use strict';
process.env.CF_WORKER_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';
process.env.CF_WORKER_AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';

const { extractTurbovidda, bypassSafego } = require('./src/extractors/turbovidda');

async function testSafegoViaCF() {
  console.log('[Test] bypassSafego via CF Worker proxy...');
  const safegoUrl = 'https://safego.cc/safe.php?url=VEdBbndGQS9OMUVoRXh6THByMTh5MkVCT2dzUjF0WjY4K21tdngyeWliVCtPQzlRVFdxR3ViVk1ZNEMyZUNvSER5UUpwYUdrdDlEcUtncHloeWwxREE9PQ==';
  
  console.log('URL:', safegoUrl);
  const start = Date.now();
  const resolved = await bypassSafego(safegoUrl);
  console.log(`Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log('Resolved:', resolved);
  
  if (resolved) {
    console.log('\n[Test] extractTurbovidda via CF Worker proxy...');
    const start2 = Date.now();
    const result = await extractTurbovidda(resolved);
    console.log(`Time: ${((Date.now() - start2) / 1000).toFixed(1)}s`);
    console.log('Result:', result);
  }
}

testSafegoViaCF().catch(e => console.error(e.stack));
