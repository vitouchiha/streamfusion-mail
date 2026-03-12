const axios = require('axios');

async function findKKey() {
  const domain = 'kisskh.co';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  
  const r = await axios.get(`https://${domain}/main.c582432abad915cc.js`, { timeout: 15000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
  const data = r.data;
  
  // Search for GetEpisode calls with their arguments
  const calls = data.matchAll(/\.GetEpisode\(([^)]{0,500})\)/g);
  let count = 0;
  for (const m of calls) {
    console.log(`\nGetEpisode call ${++count}:`);
    console.log(`  Args: ${m[1].slice(0, 200)}`);
    // Show context before the call
    const pos = m.index;
    console.log(`  Context before: ...${data.slice(Math.max(0, pos - 200), pos).slice(-200)}`);
  }
  
  // Search for GetSub calls
  const subCalls = data.matchAll(/\.GetSub\(([^)]{0,300})\)/g);
  count = 0;
  for (const m of subCalls) {
    console.log(`\nGetSub call ${++count}:`);
    console.log(`  Args: ${m[1].slice(0, 200)}`);
    const pos = m.index;
    console.log(`  Context before: ...${data.slice(Math.max(0, pos - 200), pos).slice(-200)}`);
  }
  
  // Also search for kKey or episodeKKey or similar variable definitions
  const keyPatterns = data.matchAll(/(?:kKey|kkey|episodeKey|subKey|apiKey)\s*[:=]\s*["']([A-F0-9]{32,})["']/gi);
  for (const m of keyPatterns) {
    console.log(`\nKey pattern: ${m[0].slice(0, 40)}... value(${m[1].length}): ${m[1].slice(0, 60)}...`);
  }

  // Search for environment or config objects with long hex values
  const configPatterns = data.matchAll(/(?:environment|config|key|kk)\s*[:=]\s*\{[^}]*["']([A-F0-9]{128,})["']/gi);
  for (const m of configPatterns) {
    console.log(`\nConfig hex (${m[1].length}): ${m[1].slice(0, 80)}...`);
  }
  
  // Find the environment/config module - Angular apps usually have environment.ts compiled
  const envMatches = data.matchAll(/(?:production|environment|baseUrl)[^{]*\{([^}]{0,2000})\}/g);
  for (const m of envMatches) {
    if (m[1].includes('kisskh') || m[1].match(/[A-F0-9]{64}/)) {
      console.log(`\nEnv/config object: {${m[1].slice(0, 300)}...}`);
    }
  }
}

findKKey().catch(console.error);
