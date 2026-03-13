const W = 'https://kisskh-proxy.vitobsfm.workers.dev';
const H = { 'x-worker-auth': 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3' };
const zlib = require('zlib');

function decodePng(raw) {
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (off < raw.length) {
    const len = raw.readUInt32BE(off); off += 4;
    const type = raw.toString('ascii', off, off + 4); off += 4;
    const data = raw.slice(off, off + len); off += len + 4;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') idatChunks.push(data);
    if (type === 'IEND') break;
  }
  const idat = Buffer.concat(idatChunks);
  const inflated = zlib.inflateSync(idat);
  const channels = [0, 0, 3, 0, 2, 0, 4][colorType] || 1;
  const bpp = Math.ceil((bitDepth * channels) / 8);
  const stride = 1 + width * bpp;
  const pixels = new Uint8Array(width * height);
  let prev = new Uint8Array(width * bpp);
  for (let y = 0; y < height; y++) {
    const ft = inflated[y * stride];
    const cur = new Uint8Array(width * bpp);
    for (let i = 0; i < width * bpp; i++) {
      const b = inflated[y * stride + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const c2 = (i >= bpp && y > 0) ? prev[i - bpp] : 0;
      const p = prev[i];
      let v;
      if (ft === 0) v = b;
      else if (ft === 1) v = b + a;
      else if (ft === 2) v = b + p;
      else if (ft === 3) v = b + Math.floor((a + p) / 2);
      else { const pa = Math.abs(p - c2), pb = Math.abs(a - c2), pc = Math.abs(a + p - 2 * c2); v = b + (pa <= pb && pa <= pc ? a : pb <= pc ? p : c2); }
      cur[i] = v & 0xFF;
    }
    prev = cur;
    for (let x = 0; x < width; x++) {
      const r = cur[x * bpp], g = channels >= 3 ? cur[x * bpp + 1] : r, bv = channels >= 3 ? cur[x * bpp + 2] : r;
      pixels[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * bv);
    }
  }
  return { width, height, pixels };
}

async function fetchOne() {
  const url = 'https://safego.cc/safe.php?url=TEST';
  const r = await fetch(W + '/?url=' + encodeURIComponent(url) + '&wantCookie=1', { headers: H });
  const j = await r.json();
  const html = j.body || '';
  const m = html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  return decodePng(Buffer.from(m[1], 'base64'));
}

function getSegments(w, h, px, thr) {
  const colDark = new Float32Array(w);
  for (let x = 0; x < w; x++) { let d = 0; for (let y = 0; y < h; y++) { if (px[y*w+x] < thr) d++; } colDark[x] = d / h; }
  const inD = Array.from(colDark, v => v > 0.05);
  const rs = []; let st = -1;
  for (let x = 0; x <= w; x++) { if (inD[x] && st < 0) st = x; else if (!inD[x] && st >= 0) { rs.push([st, x-1]); st = -1; } }
  const mg = []; for (const s of rs) { if (mg.length && s[0] - mg[mg.length-1][1] <= 1) mg[mg.length-1][1] = s[1]; else mg.push([...s]); }
  return mg.filter(([a,b]) => b - a >= 2);
}

function extractBitmap(w, h, px, s, e, thr) {
  // Find row bounds
  const dw = e - s + 1;
  let top = 0, bot = h - 1;
  for (let y = 0; y < h; y++) { let d = 0; for (let x = s; x <= e; x++) if (px[y*w+x] < thr) d++; if (d > 0) { top = y; break; } }
  for (let y = h - 1; y >= 0; y--) { let d = 0; for (let x = s; x <= e; x++) if (px[y*w+x] < thr) d++; if (d > 0) { bot = y; break; } }
  const rows = [];
  for (let y = top; y <= bot; y++) {
    let row = '';
    for (let x = s; x <= e; x++) row += px[y*w+x] < thr ? '#' : '.';
    rows.push(row);
  }
  return { top, bot, dw, dh: bot - top + 1, rows };
}

(async () => {
  const allDigits = [];
  for (let i = 0; i < 8; i++) {
    const cap = await fetchOne();
    if (!cap) continue;
    const {width: w, height: h, pixels: px} = cap;
    const segs = getSegments(w, h, px, 128);
    if (segs.length !== 3) { console.log('Cap ' + (i+1) + ': weird segments=' + segs.length); continue; }
    console.log('Cap ' + (i+1) + ':');
    for (let si = 0; si < 3; si++) {
      const [s, e] = segs[si];
      const bm = extractBitmap(w, h, px, s, e, 128);
      const key = bm.rows.join('|');
      allDigits.push({ cap: i+1, pos: si, key, rows: bm.rows, dw: bm.dw, dh: bm.dh });
      console.log('  D' + si + ' [' + s + '-' + e + '] ' + bm.dw + 'x' + bm.dh);
      for (const r of bm.rows) console.log('    ' + r);
    }
  }
  // Group unique bitmaps
  const groups = {};
  for (const d of allDigits) { if (!groups[d.key]) groups[d.key] = []; groups[d.key].push(d.cap + 'D' + d.pos); }
  console.log('\n=== UNIQUE DIGIT PATTERNS (' + Object.keys(groups).length + ') ===');
  let gi = 0;
  for (const [key, refs] of Object.entries(groups)) {
    gi++;
    const rows = key.split('|');
    console.log('\nPattern ' + gi + ' (' + refs.join(', ') + '):');
    for (const r of rows) console.log('  ' + r);
  }
})();
