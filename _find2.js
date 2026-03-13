const W = 'https://kisskh-proxy.vitobsfm.workers.dev';
const H = { 'x-worker-auth': 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3' };
const zlib = require('zlib');
function decodePng(raw) {
  let off = 8, w = 0, h = 0, bd = 0, ct = 0; const idc = [];
  while (off < raw.length) { const len = raw.readUInt32BE(off); off += 4; const t = raw.toString('ascii', off, off + 4); off += 4; const d = raw.slice(off, off + len); off += len + 4; if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; } if (t === 'IDAT') idc.push(d); if (t === 'IEND') break; }
  const idat = Buffer.concat(idc); const inf = zlib.inflateSync(idat); const ch = [0,0,3,0,2,0,4][ct] || 1; const bpp = Math.ceil((bd*ch)/8); const stride = 1+w*bpp;
  const px = new Uint8Array(w*h); let prev = new Uint8Array(w*bpp);
  for (let y = 0; y < h; y++) { const ft = inf[y*stride]; const cur = new Uint8Array(w*bpp); for (let i = 0; i < w*bpp; i++) { const b = inf[y*stride+1+i]; const a = i >= bpp ? cur[i-bpp] : 0; const c = (i >= bpp && y > 0) ? prev[i-bpp] : 0; const p = prev[i]; let v; if (ft===0) v=b; else if (ft===1) v=b+a; else if (ft===2) v=b+p; else if (ft===3) v=b+Math.floor((a+p)/2); else { const pa=Math.abs(p-c),pb=Math.abs(a-c),pc=Math.abs(a+p-2*c); v=b+(pa<=pb&&pa<=pc?a:pb<=pc?p:c); } cur[i]=v&0xFF; } prev=cur; for (let x = 0; x < w; x++) { const r = cur[x*bpp], g = ch >= 3 ? cur[x*bpp+1] : r, bv = ch >= 3 ? cur[x*bpp+2] : r; px[y*w+x] = Math.round(0.299*r+0.587*g+0.114*bv); } }
  return { w, h, px };
}
function getSegs(w, h, px) {
  const cd = new Float32Array(w); for (let x = 0; x < w; x++) { let d = 0; for (let y = 0; y < h; y++) if (px[y*w+x]<128) d++; cd[x]=d/h; }
  const rs = []; let st = -1; for (let x = 0; x <= w; x++) { if (cd[x]>0.05 && st<0) st=x; else if (!(cd[x]>0.05) && st>=0) { rs.push([st,x-1]); st=-1; } }
  const mg = []; for (const s of rs) { if (mg.length && s[0]-mg[mg.length-1][1]<=1) mg[mg.length-1][1]=s[1]; else mg.push([...s]); }
  return mg.filter(([a,b])=>b-a>=2);
}
function getBitmap(w, h, px, s, e) {
  let top=0, bot=h-1;
  for (let y=0;y<h;y++){let d=0;for(let x=s;x<=e;x++)if(px[y*w+x]<128)d++;if(d>0){top=y;break;}}
  for (let y=h-1;y>=0;y--){let d=0;for(let x=s;x<=e;x++)if(px[y*w+x]<128)d++;if(d>0){bot=y;break;}}
  const rows = []; for (let y=top;y<=bot;y++){let r='';for(let x=s;x<=e;x++)r+=px[y*w+x]<128?'#':'.';rows.push(r);}
  return rows;
}
const KNOWN = {
  '3': '.#####..|##...##.|......##|.....##.|...###..|.....##.|......##|......##|##...##.|.#####..',
  '7': '########|......##|......##|.....##.|....##..|...##...|..##....|.##.....|##......|##......',
  '9': '..####..|.##..##.|##....##|##....##|.##..###|..###.##|......##|.#....##|.##..##.|..####..',
  '5': '#######.|##......|##......|##.###..|###..##.|......##|......##|##....##|.##..##.|..####..',
  '1': '..##|.###|####|..##|..##|..##|..##|..##|..##|####',
  '8': '..####..|.##..##.|##....##|.##..##.|..####..|.##..##.|##....##|##....##|.##..##.|..####..',
  '6': '..####..|.##..##.|##....#.|##......|##.###..|###..##.|##....##|##....##|.##..##.|..####..',
  '0': '...##...|..####..|.##..##.|##....##|##....##|##....##|##....##|.##..##.|..####..|...##...',
  '4': '.....##|....###|...####|..##.##|.##..##|##...##|#######|.....##|.....##|.....##',
};
function ocrDigit(rows) {
  const key = rows.join('|');
  for (const [d, tmpl] of Object.entries(KNOWN)) { if (tmpl === key) return d; }
  // Hamming distance fallback
  let best = '?', bestD = Infinity;
  for (const [d, tmpl] of Object.entries(KNOWN)) {
    const t = tmpl.replace(/\|/g, '');
    const k = key.replace(/\|/g, '');
    if (t.length !== k.length) continue;
    let dist = 0; for (let i = 0; i < t.length; i++) if (t[i] !== k[i]) dist++;
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return bestD <= 10 ? best : '?';
}
async function fetchOne() {
  const r = await fetch(W + '/?url=' + encodeURIComponent('https://safego.cc/safe.php?url=TEST') + '&wantCookie=1', { headers: H });
  const j = await r.json(); const html = j.body || '';
  const m = html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  return decodePng(Buffer.from(m[1], 'base64'));
}
(async () => {
  let found2 = false;
  for (let i = 0; i < 15; i++) {
    const cap = await fetchOne(); if (!cap) continue;
    const segs = getSegs(cap.w, cap.h, cap.px); if (segs.length !== 3) continue;
    let ans = '';
    for (const [s, e] of segs) { const bm = getBitmap(cap.w, cap.h, cap.px, s, e); ans += ocrDigit(bm); }
    const has2 = ans.includes('2') || ans.includes('?');
    if (has2) {
      console.log('Cap ' + (i+1) + ': ' + ans);
      for (let si = 0; si < 3; si++) {
        const [s,e] = segs[si]; const bm = getBitmap(cap.w, cap.h, cap.px, s, e);
        if (ocrDigit(bm) === '?' || ocrDigit(bm) === '2') {
          console.log('  Unknown digit ' + si + ' (' + (e-s+1) + 'x' + bm.length + '):');
          for (const r of bm) console.log('    ' + r);
          found2 = true;
        }
      }
    } else {
      process.stdout.write('Cap ' + (i+1) + ': ' + ans + '\n');
    }
  }
  if (!found2) console.log('No digit 2 found in 15 captchas');
})();
