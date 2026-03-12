const axios = require('axios');

async function findKKey() {
  const domain = 'kisskh.co';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  
  // Fetch main.*.js - the Angular bundle with KKEY
  const scripts = [
    `https://${domain}/main.c582432abad915cc.js`,
    `https://${domain}/scripts.075605d76f7d5f68.js`,
    `https://${domain}/common.js`,
  ];
  
  for (const url of scripts) {
    console.log(`Fetching: ${url}`);
    try {
      const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
      const data = r.data;
      console.log(`  Size: ${data.length}`);
      
      // Search for kkey patterns
      const kkeyMatches = data.matchAll(/kkey[=:]["']?([A-F0-9]{64,})/gi);
      for (const m of kkeyMatches) {
        console.log(`  KKEY FOUND: ${m[1].slice(0, 60)}...`);
      }
      
      // Search for long hex strings (128+ chars) that could be kkeys
      const hexMatches = data.matchAll(/["']([0-9A-F]{128,})["']/g);
      for (const m of hexMatches) {
        console.log(`  HEX STRING (${m[1].length} chars): ${m[1].slice(0, 60)}...`);
      }
      
      // Also search for "kkey" in any context
      if (data.includes('kkey')) {
        const idx = data.indexOf('kkey');
        console.log(`  kkey context: ...${data.slice(Math.max(0, idx - 30), idx + 80)}...`);
        
        // Find all occurrences
        let pos = 0;
        let count = 0;
        while ((pos = data.indexOf('kkey', pos)) !== -1 && count < 10) {
          console.log(`  kkey@${pos}: ...${data.slice(Math.max(0, pos - 20), pos + 60)}...`);
          pos += 4;
          count++;
        }
      }
      
      // Search for .png endpoint pattern
      if (data.includes('.png')) {
        let pos = 0;
        let count = 0;
        while ((pos = data.indexOf('.png', pos)) !== -1 && count < 5) {
          const ctx = data.slice(Math.max(0, pos - 60), pos + 40);
          if (ctx.includes('Episode') || ctx.includes('api') || ctx.includes('kkey')) {
            console.log(`  .png@${pos}: ...${ctx}...`);
          }
          pos += 4;
          count++;
        }
      }
    } catch(e) {
      console.log(`  Error: ${e.response?.status || e.message}`);
    }
  }
}

findKKey();
