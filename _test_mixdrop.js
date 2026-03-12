'use strict';

// Debug MixDrop extractor
const { extractMixDrop } = require('./src/extractors/mixdrop');

async function debugMixdrop(url) {
  console.log('\n=== MixDrop Debug:', url, '===');
  
  // First do a raw fetch to see what we get
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://m1xdrop.net/'
    }
  });
  console.log('Status:', resp.status);
  console.log('Final URL:', resp.url);
  const html = await resp.text();
  console.log('HTML length:', html.length);
  
  // Check for p,a,c,k,e,d pattern
  const packedMatch = /eval\(function\(p,a,c,k,e,d\)/i.test(html);
  console.log('Has packed JS:', packedMatch);
  
  // Check for MDCore.wurl
  const wurlMatch = /MDCore\.wurl|wurl\s*=/i.test(html);
  console.log('Has wurl reference:', wurlMatch);
  
  // Check for common blocking patterns
  const blocked = /captcha|challenge|just.*moment|blocked|forbidden/i.test(html);
  console.log('Possible blocking:', blocked);
  
  // Show relevant JS snippets
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
  console.log('Script blocks:', scripts.length);
  
  // Find packed scripts
  const packedScripts = scripts.filter(s => /eval\(function\(p,a,c,k,e,d\)/i.test(s));
  console.log('Packed scripts:', packedScripts.length);
  if (packedScripts.length) {
    console.log('First packed (preview):', packedScripts[0].substring(0, 300));
  }
  
  // Show first 500 chars of HTML
  console.log('\nHTML preview:', html.substring(0, 500));
  
  // Now try the actual extractor
  console.log('\n--- Running extractMixDrop ---');
  const result = await extractMixDrop(url);
  console.log('Result:', result);
}

(async () => {
  await debugMixdrop('https://m1xdrop.net/e/nlx0oj3kcqkwq9');
  await debugMixdrop('https://m1xdrop.net/e/9w49djnruvnw');
})();
