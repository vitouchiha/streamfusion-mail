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
  return { width, height, pixels, colorType, bitDepth, channels };
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

function analyzeDigit(width, height, pixels, s, e, threshold) {
  const dw = e - s + 1;
  const rowDark = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let d = 0;
    for (let x = s; x <= e; x++) if (pixels[y * width + x] < threshold) d++;
    rowDark[y] = d / dw;
  }
  let top = 0, bot = height - 1;
  for (let y = 0; y < height; y++) { if (rowDark[y] > 0.1) { top = y; break; } }
  for (let y = height - 1; y >= 0; y--) { if (rowDark[y] > 0.1) { bot = y; break; } }
  const dh = bot - top + 1;
  const t1 = top + Math.floor(dh / 3), t2 = top + Math.floor(2 * dh / 3);
  const zones = {};
  for (const [zi, ya, yb] of [['T', top, t1], ['M', t1 + 1, t2], ['B', t2 + 1, bot]]) {
    let L = 0, R = 0, cnt = 0;
    const mid = Math.floor((s + e) / 2);
    for (let y = ya; y <= yb; y++) {
      for (let x = s; x <= e; x++) {
        if (pixels[y * width + x] < threshold) { if (x <= mid) L++; else R++; }
        cnt++;
      }
    }
    zones[zi + 'L'] = L / (cnt / 2 + 0.01);
    zones[zi + 'R'] = R / (cnt / 2 + 0.01);
  }
  return { ...zones, ratio: dw / dh, dw, dh };
}

(async () => {
  console.log('Fetching captchas...');
  for (let i = 0; i < 5; i++) {
    const cap = await fetchOne();
    if (!cap) { console.log('SKIP - no captcha'); continue; }
    const { width, height, pixels } = cap;
    console.log('\n' + '='.repeat(70));
    console.log('CAPTCHA #' + (i + 1) + '  ' + width + 'x' + height + '  ct=' + cap.colorType);
    for (let y = 0; y < height; y++) {
      let line = '';
      for (let x = 0; x < width; x++) line += pixels[y * width + x] < 128 ? '#' : '.';
      console.log(line);
    }
    const threshold = 128;
    const colDark = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let d = 0;
      for (let y = 0; y < height; y++) { if (pixels[y * width + x] < threshold) d++; }
      colDark[x] = d / height;
    }
    const inDigit = Array.from(colDark, v => v > 0.05);
    const raw_segs = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (inDigit[x] && start < 0) start = x;
      else if (!inDigit[x] && start >= 0) { raw_segs.push([start, x - 1]); start = -1; }
    }
    const merged = [];
    for (const seg of raw_segs) {
      if (merged.length && seg[0] - merged[merged.length - 1][1] <= 1) merged[merged.length - 1][1] = seg[1];
      else merged.push([...seg]);
    }
    const segs = merged.filter(([s, e]) => e - s >= 2);
    console.log('Segments: ' + segs.map(([s, e]) => '[' + s + '-' + e + '] w=' + (e - s + 1)).join(', '));
    for (let si = 0; si < segs.length; si++) {
      const [s, e] = segs[si];
      const z = analyzeDigit(width, height, pixels, s, e, threshold);
      console.log('  D' + si + ': TL=' + z.TL.toFixed(3) + ' TR=' + z.TR.toFixed(3) +
        ' ML=' + z.ML.toFixed(3) + ' MR=' + z.MR.toFixed(3) +
        ' BL=' + z.BL.toFixed(3) + ' BR=' + z.BR.toFixed(3) +
        ' ratio=' + z.ratio.toFixed(3));
    }
  }
})();
