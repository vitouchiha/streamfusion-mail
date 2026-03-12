const axios = require('axios');

async function investigate() {
  const domain = 'kisskh.co';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  
  const mainJs = await axios.get(`https://${domain}/main.c582432abad915cc.js`, { timeout: 15000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
  const data = mainJs.data;
  
  // Find GetEpisode call and trace 3000 chars before
  const getEpIdx = data.indexOf('.GetEpisode(');
  if (getEpIdx !== -1) {
    console.log('=== Context around GetEpisode call (3000 before, 300 after) ===');
    const before = data.slice(Math.max(0, getEpIdx - 3000), getEpIdx);
    const after = data.slice(getEpIdx, getEpIdx + 300);
    
    // Extract the actual call including its arguments
    const callStr = after.match(/\.GetEpisode\(([^)]*)\)/);
    if (callStr) console.log('Call args:', callStr[1]);
    
    // Search for key/kk/Me assignments in the context before
    console.log('\n--- Assignments in context ---');
    const assignments = before.matchAll(/(?:var |let |const |this\.|,)(\w+)\s*=\s*([^;,]{5,150}?)(?=[;,])/g);
    for (const m of assignments) {
      const varName = m[1];
      const value = m[2];
      // Only show if it's related to key/token/kk or if it's a function call
      if (varName.match(/^(key|kk|kKey|token|Me|J|K|encr|decr)/i) || 
          value.match(/key|kk|token|encr|decr|fire|config/i) ||
          value.length > 80) {
        console.log(`  ${varName} = ${value.slice(0, 150)}`);
      }
    }
  }
  
  // Also look for "this.key" or "this.kk" patterns throughout the file
  console.log('\n=== this.key and this.kk patterns ===');
  const thisPatterns = data.matchAll(/this\.(key|kk|kKey|episodeKe|subKe|myKe)\w*\s*=\s*([^;]{5,200}?)(?=[;,\n])/gi);
  for (const m of thisPatterns) {
    console.log(`  this.${m[1]}... = ${m[2].slice(0, 200)}`);
  }
  
  // Search for Firebase Remote Config patterns (common way to distribute keys)
  console.log('\n=== Firebase/Remote Config patterns ===');
  const fbPatterns = data.matchAll(/(?:remoteConfig|getValue|fetchConfig|getRemoteConfig|getString)\s*\(['"]?(\w*)['"]?\)/gi);
  for (const m of fbPatterns) {
    console.log(`  ${m[0].slice(0, 100)}`);
  }
  
  // Look for the "key" member in the main service/component  
  console.log('\n=== key= nearby .png usage ===');
  const pngPos = data.indexOf('.png?');
  if (pngPos !== -1) {
    // Get 5000 chars before .png
    const ctx = data.slice(Math.max(0, pngPos - 5000), pngPos + 300);
    
    // Find the enclosing function/class
    const funcStarts = [...ctx.matchAll(/(?:function\s+\w+|key:\s*"[^"]*",\s*value:\s*function)/g)];
    if (funcStarts.length > 0) {
      const lastFunc = funcStarts[funcStarts.length - 1];
      console.log(`  Enclosing function: ${lastFunc[0].slice(0, 100)}`);
      console.log(`  Offset: ${lastFunc.index}`);
      // Show from that function to .png
      const funcToEnd = ctx.slice(lastFunc.index, ctx.length);
      console.log(`  Function body: ${funcToEnd.slice(0, 600)}`);
    }
  }
  
  // Search for decrypt or encode pattern related to keys
  console.log('\n=== Encryption/encoding patterns ===');
  const encPatterns = data.matchAll(/(?:encrypt|decrypt|encode|decode|hmac|sha|hash|aes|cipher)\w*\s*\(([^)]{0,200})\)/gi);
  let count = 0;
  for (const m of encPatterns) {
    if (count++ > 10) break;
    console.log(`  ${m[0].slice(0, 150)}`);
  }
}

investigate().catch(console.error);
