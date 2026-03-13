const zlib = require('zlib');
const fs = require('fs');

function decodePng(buf) {
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const chunkLen = buf.readUInt32BE(offset); offset += 4;
    const type = buf.slice(offset, offset + 4).toString('ascii'); offset += 4;
    const data = buf.slice(offset, offset + chunkLen); offset += chunkLen + 4;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idatChunks.push(data);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const channels = [0, 0, 3, 0, 2, 0, 4][colorType] || 1;
  const bpp = Math.ceil((bitDepth * channels) / 8);
  const stride = 1 + width * bpp;
  const pixels = new Uint8Array(width * height);
  let prev = new Uint8Array(width * bpp);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * stride];
    const cur = new Uint8Array(width * bpp);
    for (let i = 0; i < width * bpp; i++) {
      const b = raw[y * stride + 1 + i];
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
      const r2 = cur[x * bpp], g = channels >= 3 ? cur[x * bpp + 1] : r2, bv = channels >= 3 ? cur[x * bpp + 2] : r2;
      pixels[y * width + x] = Math.round(0.299 * r2 + 0.587 * g + 0.114 * bv);
    }
  }
  return { width, height, pixels };
}

async function main() {
  const cfUrl = 'https://kisskh-proxy.vitobsfm.workers.dev';
  const auth = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';
  const safegoUrl = 'https://safego.cc/safe.php?url=OEFSWGI4aStqNE5hclcvODd5d05EZXZraTVzNlltejFRa0dlazRFSTg4cGlzTjZXSzYvbUZmalVLTnczVWl3aw==';
  
  for (let i = 0; i < 3; i++) {
    console.log('\n=== Captcha #' + (i + 1) + ' ===');
    const u = new URL(cfUrl);
    u.searchParams.set('url', safegoUrl);
    u.searchParams.set('nofollow', '1');
    u.searchParams.set('wantCookie', '1');
    
    const r = await fetch(u.toString(), { headers: { 'x-worker-auth': auth } });
    const d = await r.json();
    const html = d.body || '';
    const m = html.match(/data:image\/png;base64,([^"]+)"/i);
    if (!m) { console.log('No image found'); continue; }
    const b64 = m[1].replace(/\s/g, '');
    
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync('_captcha_' + i + '.png', buf);
    
    const { width, height, pixels } = decodePng(buf);
    console.log('Size: ' + width + 'x' + height + ', bytes: ' + buf.length);
    
    for (let y = 0; y < height; y++) {
      let row = '';
      for (let x = 0; x < width; x++) {
        const v = pixels[y * width + x];
        row += v < 64 ? '#' : v < 128 ? '+' : v < 192 ? '.' : ' ';
      }
      console.log(row);
    }
  }
}

main().catch(console.error);
