const axios = require('axios');

async function findKKey() {
  const domain = 'kisskh.co';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  
  const r = await axios.get(`https://${domain}/main.c582432abad915cc.js`, { timeout: 15000, headers: { 'User-Agent': UA, 'Referer': `https://${domain}/` } });
  const data = r.data;
  
  // Find the kkey context with more surrounding text
  const kkeyPos = data.indexOf('kkey="+Me');
  if (kkeyPos !== -1) {
    // Show large context around the kkey usage
    console.log('=== kkey usage context (500 chars before) ===');
    console.log(data.slice(Math.max(0, kkeyPos - 500), kkeyPos + 50));
    console.log('\n=== Looking for Me assignment ===');
  }
  
  // Search for: Me=" or Me= followed by a long hex string
  // Variable Me is assigned somewhere in the minified code
  const meAssignments = data.matchAll(/(?:,|;|\b)Me\s*=\s*["']([^"']{50,})["']/g);
  for (const m of meAssignments) {
    console.log(`Me = "${m[1].slice(0, 80)}..." (${m[1].length} chars)`);
  }
  
  // Also try different minification patterns  
  const meAssign2 = data.matchAll(/(?:this\.|,\s*)Me\s*=\s*["']([^"']+)["']/g);
  for (const m of meAssign2) {
    if (m[1].length > 50) {
      console.log(`Me (this) = "${m[1].slice(0, 80)}..." (${m[1].length} chars)`);
    }
  }

  // Broader search: any assignment to Me with a long hex value
  const allMeAssign = data.matchAll(/Me=["']([A-F0-9]{64,})["']/gi);
  for (const m of allMeAssign) {
    console.log(`Me hex = "${m[1].slice(0, 80)}..." (${m[1].length} chars)`);
  }
  
  // Also check for the J variable (used in sub kkey)
  const jkeyPos = data.indexOf('kkey="+J');
  if (jkeyPos !== -1) {
    console.log('\n=== J (sub kkey) context ===');
    console.log(data.slice(Math.max(0, jkeyPos - 200), jkeyPos + 50));
  }
  
  // Search for long hex strings near kkey
  const area = data.slice(Math.max(0, kkeyPos - 5000), kkeyPos);
  const hexInArea = area.matchAll(/["']([0-9A-Fa-f]{128,})["']/g);
  for (const m of hexInArea) {
    console.log(`\nNearby hex (${m[1].length} chars): ${m[1].slice(0, 80)}...`);
  }

  // Also search for env or environment-like kkey patterns
  const envKkey = data.matchAll(/kkey\s*[:=]\s*["']([A-F0-9]{64,})["']/gi);
  for (const m of envKkey) {
    console.log(`Direct kkey value: ${m[1].slice(0, 80)}... (${m[1].length} chars)`);
  }
}

findKKey().catch(console.error);
