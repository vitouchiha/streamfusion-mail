// Debug: test individual steps of safego captcha through CF Worker
'use strict';
process.env.CF_WORKER_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';
process.env.CF_WORKER_AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';

const cfUrl = process.env.CF_WORKER_URL;
const auth = process.env.CF_WORKER_AUTH;
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0';

async function cfFetch(url, params = {}) {
  const u = new URL(cfUrl);
  u.searchParams.set('url', url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString(), { headers: { 'x-worker-auth': auth } });
  return r.json();
}

async function test() {
  const safegoUrl = 'https://safego.cc/safe.php?url=VEdBbndGQS9OMUVoRXh6THByMTh5MkVCT2dzUjF0WjY4K21tdngyeWliVCtPQzlRVFdxR3ViVk1ZNEMyZUNvSER5UUpwYUdrdDlEcUtncHloeWwxREE9PQ==';
  
  // Step 1: GET safego (nofollow + wantCookie) to get PHPSESSID + captcha
  console.log('=== Step 1: GET safego ===');
  const r1 = await cfFetch(safegoUrl, { nofollow: '1', wantCookie: '1' });
  console.log('status:', r1.status, 'setCookie:', (r1.setCookie||'').substring(0, 80));
  const phpsessid = (r1.setCookie?.match(/PHPSESSID=([^;,\s]+)/) || [])[1];
  console.log('PHPSESSID:', phpsessid);
  
  // Extract captcha from body
  const captchField = (r1.body?.match(/name="(captch[45])"/) || [])[1] || 'captch5';
  const imgMatch = r1.body?.match(/src="(data:image\/png;base64,([^"]+))"/i);
  if (!imgMatch) { console.log('No captcha image found!'); return; }
  const b64data = imgMatch[2].replace(/\s/g, '');
  
  // OCR the captcha
  const ocrForm = new URLSearchParams({
    base64Image: `data:image/png;base64,${b64data}`,
    apikey: 'helloworld', language: 'eng',
    isOverlayRequired: 'false', detectOrientation: 'false', scale: 'true', OCREngine: '2',
  });
  const ocrResp = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: ocrForm, signal: AbortSignal.timeout(12000) });
  const ocrJson = await ocrResp.json();
  const captchAnswer = ((ocrJson?.ParsedResults || [])[0]?.ParsedText || '').replace(/\D/g, '');
  console.log('Captcha answer:', captchAnswer);
  
  // Step 2: POST captcha answer
  console.log('\n=== Step 2: POST captcha ===');
  const postBody = new URLSearchParams({ [captchField]: captchAnswer }).toString();
  const r2 = await cfFetch(safegoUrl, { 
    method: 'POST', 
    body: postBody, 
    nofollow: '1', 
    wantCookie: '1',
    cookie: `PHPSESSID=${phpsessid}`,
    contentType: 'application/x-www-form-urlencoded',
  });
  console.log('status:', r2.status, 'location:', r2.location, 'setCookie:', (r2.setCookie||'').substring(0, 80));
  console.log('body preview:', (r2.body||'').substring(0, 200));
  
  const captch5 = (r2.setCookie?.match(/captch[45]=([^;,\s]+)/) || [])[1];
  console.log('captch5 cookie:', captch5);
  
  // Step 3: GET with both cookies → should redirect to turbovid
  console.log('\n=== Step 3: GET with cookies ===');
  const cookieStr = `PHPSESSID=${phpsessid}; captch5=${captch5}`;
  const r3 = await cfFetch(safegoUrl, {
    nofollow: '1',
    wantCookie: '1',
    cookie: cookieStr,
  });
  console.log('status:', r3.status, 'location:', r3.location);
  console.log('setCookie:', (r3.setCookie||'').substring(0, 80));
  console.log('body preview:', (r3.body||'').substring(0, 300));
  
  // Check if body contains a link
  const linkMatch = (r3.body||'').match(/<a\b[^>]+href="(https?:\/\/[^"]+)"/);
  if (linkMatch) console.log('Link in body:', linkMatch[1]);
}

test().catch(e => console.error(e.message));
