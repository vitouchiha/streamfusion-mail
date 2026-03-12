const axios = require('axios');

async function findKKey() {
  const domain = 'kisskh.co';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  
  const r = await axios.get(`https://${domain}/main.c582432abad915cc.js`, { timeout: 15000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
  const data = r.data;
  
  // Find ALL long hex strings (the old KKEY was 256 chars of hex)
  console.log('=== ALL long hex strings (>100 chars) ===');
  const hexStrings = data.matchAll(/["']([0-9A-Fa-f]{100,})["']/g);
  for (const m of hexStrings) {
    const pos = m.index;
    const ctx = data.slice(Math.max(0, pos - 60), pos);
    console.log(`  Hex (${m[1].length} chars) at pos ${pos}: ...${ctx.slice(-40)} → ${m[1].slice(0, 60)}...`);
  }
  
  // Also search for: this.kk or this.key or this.kKey patterns
  console.log('\n=== "key" related assignments ===');
  const thisKey = data.matchAll(/this\.(?:kk|key|kKey|ky|apiKe|episodeK|subK|myK)\w*\s*=\s*["']?([^;,]{10,100})/gi);
  for (const m of thisKey) {
    console.log(`  ${m[0].slice(0, 120)}`);
  }
  
  // Search for: N.kk or N.key or g.N. or environment patterns
  console.log('\n=== N.* config assignments ===');
  const nConfig = data.matchAll(/N\.(?:kk|key|kKey|ky|ep|sub|apiK)\w*\s*=\s*["']([^"']+)["']/gi);
  for (const m of nConfig) {
    console.log(`  ${m[0].slice(0, 120)}`);
  }
  
  // What is g.N? Let me find where N is defined as a config object
  console.log('\n=== g.N baseUrl context ===');
  const baseUrlPos = data.indexOf('baseUrl');
  if (baseUrlPos !== -1) {
    // Scan forward to find the full config object
    let i = baseUrlPos;
    // Go back to find the object start
    while (i > 0 && data[i] !== '{') i--;
    const configObj = data.slice(i, i + 1000);
    // Find the closing brace level
    let depth = 0;
    let end = 0;
    for (let j = 0; j < configObj.length; j++) {
      if (configObj[j] === '{') depth++;
      if (configObj[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    console.log(configObj.slice(0, end || 500));
  }
  
  // Search for GetEpisode calls with better context
  console.log('\n=== GetEpisode calls (wider context) ===');
  let pos = 0;
  let count = 0;
  while ((pos = data.indexOf('GetEpisode(', pos)) !== -1 && count < 5) {
    const full = data.slice(pos, pos + 300);
    const endParen = full.indexOf(')');
    console.log(`  Call: ${full.slice(0, endParen + 1)}`);
    // Show 300 chars before to see where args come from
    console.log(`  Before: ...${data.slice(Math.max(0, pos - 300), pos).slice(-300)}`);
    pos += 10;
    count++;
  }
}

findKKey().catch(console.error);
