// Quick test: verify CF_PROXY_URL-based SuperVideo extraction
const { extractSuperVideo } = require('./src/extractors/supervideo');

// Test 1: Check if CF proxy works for SV embed
async function testDirectProxy() {
  const url = 'https://streamfusion-proxy.vitobsfm.workers.dev/?url=' + encodeURIComponent('https://supervideo.tv/e/914t0hxfcmcj');
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const html = await r.text();
  console.log('[Proxy] Status:', r.status, 'Len:', html.length);
  console.log('[Proxy] Has eval:', html.includes('eval(function'));
  console.log('[Proxy] Has sources:', html.includes('sources'));
  console.log('[Proxy] Has packed:', /eval\(function\(p,a,c,k,e,d\)/.test(html));
}

// Test 2: Run full extraction with CF_PROXY_URL env
async function testExtraction() {
  process.env.CF_PROXY_URL = 'https://streamfusion-proxy.vitobsfm.workers.dev';
  // Also set global for compat
  global.CF_PROXY_URL = 'https://streamfusion-proxy.vitobsfm.workers.dev';
  
  const result = await extractSuperVideo('https://supervideo.cc/e/914t0hxfcmcj', {
    refererBase: 'https://guardaserietv.skin/',
  });
  console.log('\n[Extraction] Result:', JSON.stringify(result, null, 2));
}

(async () => {
  await testDirectProxy();
  await testExtraction();
})().catch(e => console.error('FATAL:', e));
