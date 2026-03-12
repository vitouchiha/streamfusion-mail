const axios = require('axios');

async function investigate() {
  const domain = 'kisskh.co';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  
  // Fetch common.js 
  console.log('=== common.js ===');
  try {
    const r = await axios.get(`https://${domain}/common.js?v=9082123`, { timeout: 10000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
    console.log('Size:', r.data.length);
    // Search for kkey/key/hex
    if (r.data.match(/[0-9A-F]{64,}/i)) console.log('Has hex strings!');
    if (r.data.includes('kkey')) console.log('Has kkey!');
    // Show the whole file if small
    if (r.data.length < 20000) {
      // Search for relevant patterns
      for (const pattern of ['key', 'kk', 'token', 'auth', 'secret']) {
        const matches = r.data.matchAll(new RegExp(`\\b\\w*${pattern}\\w*\\s*[:=]\\s*["'][^"']{10,}["']`, 'gi'));
        for (const m of matches) {
          console.log(`  ${pattern}: ${m[0].slice(0, 150)}`);
        }
      }
    }
  } catch(e) { console.log('Error:', e.message); }
  
  // Fetch scripts.js
  console.log('\n=== scripts.js ===');
  try {
    const r = await axios.get(`https://${domain}/scripts.js?v=2`, { timeout: 10000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
    console.log('Size:', r.data.length);
    if (r.data.match(/[0-9A-F]{64,}/i)) console.log('Has hex strings!');
    if (r.data.includes('kkey')) console.log('Has kkey!');
  } catch(e) { console.log('Error:', e.message); }
  
  // Try to fetch the environment config from Angular's chunk files
  console.log('\n=== Looking for lazy-loaded chunks ===');
  try {
    const mainJs = await axios.get(`https://${domain}/main.c582432abad915cc.js`, { timeout: 15000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
    
    // Find chunk file references
    const chunks = mainJs.data.matchAll(/["']([a-f0-9]{10,20})["']\s*:\s*["']([a-f0-9]{10,20})["']/g);
    const chunkIds = [];
    for (const m of chunks) {
      chunkIds.push(m[1]);
    }
    console.log(`Found ${chunkIds.length} chunk refs`);
    
    // Also find environment module
    const envSearch = mainJs.data.matchAll(/environment[^{]*\{([^}]*production[^}]*)\}/g);
    for (const m of envSearch) {
      console.log(`Env: {${m[1].slice(0, 400)}}`);
    }
    
    // Look for how kkey argument is provided in the component
    // Find the component that calls GetEpisode
    const getEpIdx = mainJs.data.indexOf('.GetEpisode(');
    if (getEpIdx === -1) {
      console.log('GetEpisode not found directly');
      // Search for other patterns
      const patterns = ['GetEpisode', 'getEpisode', 'episode', '.png'];
      for (const p of patterns) {
        const idx = mainJs.data.indexOf(p);
        if (idx !== -1) console.log(`  ${p} at ${idx}`);
      }
    } else {
      // Get 2000 chars of context before the call to understand the variable flow
      const ctx = mainJs.data.slice(Math.max(0, getEpIdx - 2000), getEpIdx + 200);
      console.log('\n=== 2000 chars before GetEpisode call ===');
      console.log(ctx);
    }
  } catch(e) { console.log('Error:', e.message); }
  
  // Try direct API: maybe there's a key endpoint
  console.log('\n=== Testing API endpoints ===');
  const endpoints = [
    `https://${domain}/api/DramaList/GetKey`,
    `https://${domain}/api/Key`,
    `https://${domain}/api/DramaList/Config`,
  ];
  for (const url of endpoints) {
    try {
      const r = await axios.get(url, { timeout: 5000, headers: { 'User-Agent': UA } });
      console.log(`OK ${url}: ${JSON.stringify(r.data).slice(0, 200)}`);
    } catch(e) {
      console.log(`${e.response?.status || e.message} ${url}`);
    }
  }
}

investigate().catch(console.error);
