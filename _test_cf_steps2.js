// Debug: detailed step 3 body inspection
'use strict';
const cfUrl = 'https://kisskh-proxy.vitobsfm.workers.dev';
const auth = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';

async function cf(url, params = {}) {
  const u = new URL(cfUrl);
  u.searchParams.set('url', url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return fetch(u.toString(), { headers: { 'x-worker-auth': auth } }).then(r => r.json());
}

async function test() {
  const safegoUrl = 'https://safego.cc/safe.php?url=VEdBbndGQS9OMUVoRXh6THByMTh5MkVCT2dzUjF0WjY4K21tdngyeWliVCtPQzlRVFdxR3ViVk1ZNEMyZUNvSER5UUpwYUdrdDlEcUtncHloeWwxREE9PQ==';
  
  // Step 1: GET → PHPSESSID
  const r1 = await cf(safegoUrl, { nofollow: '1', wantCookie: '1' });
  const phpsessid = (r1.setCookie?.match(/PHPSESSID=([^;,\s]+)/) || [])[1];
  console.log('PHPSESSID:', phpsessid);
  
  // OCR
  const captchField = (r1.body?.match(/name="(captch[45])"/) || [])[1] || 'captch5';
  const b64 = (r1.body?.match(/data:image\/png;base64,([^"]+)"/) || [])[1]?.replace(/\s/g, '');
  const ocrResp = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    body: new URLSearchParams({ base64Image: `data:image/png;base64,${b64}`, apikey: 'helloworld', language: 'eng', isOverlayRequired: 'false', scale: 'true', OCREngine: '2' }),
    signal: AbortSignal.timeout(12000),
  });
  const answer = ((await ocrResp.json())?.ParsedResults?.[0]?.ParsedText || '').replace(/\D/g, '');
  console.log('Answer:', answer, 'Field:', captchField);
  
  // Step 2: POST
  const r2 = await cf(safegoUrl, { method: 'POST', body: `${captchField}=${answer}`, nofollow: '1', wantCookie: '1', cookie: `PHPSESSID=${phpsessid}`, contentType: 'application/x-www-form-urlencoded' });
  const captch5 = (r2.setCookie?.match(/captch[45]=([^;,\s]+)/) || [])[1];
  console.log('captch5:', captch5, 'status:', r2.status, 'location:', r2.location);
  
  // Step 3: GET with cookies (follow mode — NOT nofollow)
  console.log('\n--- Step 3a: GET with cookies, NO nofollow (follow redirects) ---');
  const r3a = await cf(safegoUrl, { cookie: `PHPSESSID=${phpsessid}; captch5=${captch5}` });
  console.log('status:', r3a.status || 'N/A');
  // r3a is the raw body (not JSON wrapper since no wantCookie)
  // Actually cf() always returns json... let me check
  console.log('Response type:', typeof r3a);
  console.log('Body preview:', JSON.stringify(r3a).substring(0, 500));
  
  // Step 3b: With wantCookie  
  console.log('\n--- Step 3b: GET with cookies + wantCookie (no nofollow) ---');
  const r3b = await cf(safegoUrl, { wantCookie: '1', cookie: `PHPSESSID=${phpsessid}; captch5=${captch5}` });
  console.log('status:', r3b.status, 'location:', r3b.location);
  console.log('Body length:', (r3b.body||'').length);
  
  // Find ALL links/URLs in body
  const urls = (r3b.body||'').match(/https?:\/\/[^\s"'<>]+/g) || [];
  console.log('URLs in body:', urls.length);
  urls.forEach(u => console.log(' -', u));
  
  // Check for meta refresh
  const metaRefresh = (r3b.body||'').match(/content="\d+;\s*url=([^"]+)"/i);
  if (metaRefresh) console.log('Meta refresh:', metaRefresh[1]);
  
  // Check for window.location
  const windowLoc = (r3b.body||'').match(/window\.location\s*=\s*["']([^"']+)/);
  if (windowLoc) console.log('Window.location:', windowLoc[1]);
  
  console.log('\nFull body:\n', (r3b.body||'').substring(0, 2000));
}

test().catch(e => console.error(e.message));
