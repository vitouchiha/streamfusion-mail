'use strict';
const zlib = require('zlib');
const CF_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';
const AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';
const SAFEGO = 'https://safego.cc/safe.php?url=OEFSWGI4aStqNE5hclcvODd5d05EZXZraTVzNlltejFRa0dlazRFSTg4cGlzTjZXSzYvbUZmalVLTnczVWl3aw==';
function decodePng(buf) {
  let offset = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idats = [];
  while (offset < buf.length) {
    const cl = buf.readUInt32BE(offset); offset += 4;
    const ty = buf.slice(offset, offset + 4).toString('ascii'); offset += 4;
    const da = buf.slice(offset, offset + cl); offset += cl + 4;
    if (ty === 'IHDR') { w = da.readUInt32BE(0); h = da.readUInt32BE(4); bd = da[8]; ct = da[9]; }
    else if (ty === 'IDAT') idats.push(da);
    else if (ty === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const ch = [0, 0, 3, 0, 2, 0, 4][ct] || 1;
  const bpp = Math.ceil((bd * ch) / 8);
  const stride = 1 + w * bpp;
  const px = new Uint8Array(w * h);
  let prev = new Uint8Array(w * bpp);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * stride];
    const cur = new Uint8Array(w * bpp);
    for (let i = 0; i < w * bpp; i++) {
      const b = raw[y * stride + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const c2 = (i >= bpp && y > 0) ? prev[i - bpp] : 0;
      const p = prev[i];
      let v;
      if (ft === 0) v = b; else if (ft === 1) v = b + a; else if (ft === 2) v = b + p;
      else if (ft === 3) v = b + Math.floor((a + p) / 2);
      else { const pa = Math.abs(p - c2), pb = Math.abs(a - c2), pc = Math.abs(a + p - 2 * c2); v = b + (pa <= pb && pa <= pc ? a : pb <= pc ? p : c2); }
      cur[i] = v & 0xFF;
    }
    prev = cur;
    for (let x = 0; x < w; x++) {
      const r = cur[x * bpp], g = ch >= 3 ? cur[x * bpp + 1] : r, bv = ch >= 3 ? cur[x * bpp + 2] : r;
      px[y * w + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * bv);
    }
  }
  return { w, h, px };
}
async function main() {
  console.log('Fetching captcha page...');
  const u1 = new URL(CF_URL);
  u1.searchParams.set('url', SAFEGO);
  u1.searchParams.set('nofollow', '1');
  u1.searchParams.set('wantCookie', '1');
  const r1 = await fetch(u1.toString(), { headers: { 'x-worker-auth': AUTH } });
  const d1 = await r1.json();
  const sessid = (d1.setCookie.match(/PHPSESSID=([^;]+)/) || [])[1];
  console.log('PHPSESSID:', sessid);
  const im = d1.body.match(/data:image\/png;base64,([^"]+)"/i);
  if (!im) { console.log('No captcha image!'); return; }
  const buf = Buffer.from(im[1].replace(/\s/g, ''), 'base64');
  const { w, h, px } = decodePng(buf);
  console.log('Image ' + w + 'x' + h + ':');
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += px[y * w + x] < 80 ? '#' : ' ';
    if (row.trim()) console.log(row);
  }
  const answer = process.argv[2];
  if (!answer) { console.log('Run: node _test_mc.js <digits>'); return; }
  console.log('POSTing captch5=' + answer);
  const u2 = new URL(CF_URL);
  u2.searchParams.set('url', SAFEGO);
  u2.searchParams.set('method', 'POST');
  u2.searchParams.set('body', 'captch5=' + answer);
  u2.searchParams.set('contentType', 'application/x-www-form-urlencoded');
  u2.searchParams.set('cookie', 'PHPSESSID=' + sessid);
  u2.searchParams.set('nofollow', '1');
  u2.searchParams.set('wantCookie', '1');
  const r2 = await fetch(u2.toString(), { headers: { 'x-worker-auth': AUTH } });
  const d2 = await r2.json();
  console.log('Result:', JSON.stringify(d2, null, 2));
}
main().catch(function(e) { console.error('Error:', e.message); });
