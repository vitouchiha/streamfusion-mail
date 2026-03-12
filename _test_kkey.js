const axios = require('axios');

async function test() {
  // Try both domains
  for (const domain of ['kisskh.co', 'kisskh.do']) {
    console.log(`\n--- Testing ${domain} ---`);
    try {
      const r = await axios.get(`https://${domain}`, { 
        timeout: 10000, 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }, 
        maxRedirects: 5 
      });
      console.log('Status:', r.status, 'Size:', r.data.length);
      
      // Find script tags
      const scriptMatches = r.data.matchAll(/src=["']([^"']*\.js[^"']*)["']/gi);
      for (const m of scriptMatches) {
        console.log('Script:', m[1].slice(0, 150));
      }
      
      // Check for kkey references
      if (r.data.includes('kkey')) {
        console.log('Found kkey in HTML!');
        const idx = r.data.indexOf('kkey');
        console.log('Context:', r.data.slice(Math.max(0, idx - 50), idx + 100));
      }
    } catch(e) {
      console.log('FAIL:', e.response?.status || e.code || e.message);
      // If 403, try to check what CF challenge looks like
      if (e.response?.status === 403) {
        console.log('CF challenge page, size:', e.response?.data?.length);
      }
    }
  }
  
  // Try to find the KKEY from the kkey test file
  try {
    const { findKKey } = require('./findkkey');
    console.log('\n--- findkkey module ---');
    const result = await findKKey();
    console.log('Result:', JSON.stringify(result).slice(0, 300));
  } catch(e) {
    console.log('\nfindkkey module failed:', e.message);
  }
}

test();
