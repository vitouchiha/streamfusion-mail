const W='https://kisskh-proxy.vitobsfm.workers.dev';
const H={'x-worker-auth':'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3'};
async function test(){
  // Step 1: GET safego page via worker proxy (get session + captcha)
  const safegoUrl='https://safego.cc/safe.php?url=aHR0cHM6Ly93d3cua2lzc2toLmRvLw';
  const r1=await fetch(W+'/?url='+encodeURIComponent(safegoUrl)+'&wantCookie=1',{headers:H});
  const j1=await r1.json();
  const sessid=(j1.setCookie||'').match(/PHPSESSID=([^;,\s]+)/)?.[1];
  console.log('PHPSESSID:',sessid);
  const html=j1.body||'';
  const cField=(html.match(/name="(captch[45])"/)||[])[1]||'captch5';
  console.log('Field:',cField);
  const imgMatch=html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if(!imgMatch){console.log('No captcha found');return;}
  // Step 2: OCR locally
  const zlib=require('zlib');
  const buf=Buffer.from(imgMatch[1],'base64');
  let off=8,width=0,height=0,bitDepth=0,colorType=0;
  const idc=[];
  while(off<buf.length){const l=buf.readUInt32BE(off);off+=4;const t=buf.toString('ascii',off,off+4);off+=4;const d=buf.slice(off,off+l);off+=l+4;if(t==='IHDR'){width=d.readUInt32BE(0);height=d.readUInt32BE(4);bitDepth=d[8];colorType=d[9];}if(t==='IDAT')idc.push(d);if(t==='IEND')break;}
  const idat=Buffer.concat(idc);const inf=zlib.inflateSync(idat);const ch=[0,0,3,0,2,0,4][colorType]||1;const bpp=Math.ceil((bitDepth*ch)/8);const stride=1+width*bpp;
  const px=new Uint8Array(width*height);let prev=new Uint8Array(width*bpp);
  for(let y=0;y<height;y++){const ft=inf[y*stride];const cur=new Uint8Array(width*bpp);for(let i=0;i<width*bpp;i++){const b=inf[y*stride+1+i];const a=i>=bpp?cur[i-bpp]:0;const c=(i>=bpp&&y>0)?prev[i-bpp]:0;const p=prev[i];let v;if(ft===0)v=b;else if(ft===1)v=b+a;else if(ft===2)v=b+p;else if(ft===3)v=b+Math.floor((a+p)/2);else{const pa=Math.abs(p-c),pb=Math.abs(a-c),pc=Math.abs(a+p-2*c);v=b+(pa<=pb&&pa<=pc?a:pb<=pc?p:c);}cur[i]=v&0xFF;}prev=cur;for(let x=0;x<width;x++){const r=cur[x*bpp],g=ch>=3?cur[x*bpp+1]:r,bv=ch>=3?cur[x*bpp+2]:r;px[y*width+x]=Math.round(0.299*r+0.587*g+0.114*bv);}}
  // Show captcha
  for(let y=8;y<18;y++){let l='';for(let x=0;x<35;x++)l+=px[y*width+x]<128?'#':'.';console.log(l);}
  // OCR (use find2 templates)
  const KNOWN={'0':'...##...|..####..|.##..##.|##....##|##....##|##....##|##....##|.##..##.|..####..|...##...','1':'..##|.###|####|..##|..##|..##|..##|..##|..##|####','2':'..####..|.##..##.|##....##|......##|.....##.|....##..|...##...|..##....|.##.....|########','3':'.#####..|##...##.|......##|.....##.|...###..|.....##.|......##|......##|##...##.|.#####..','4':'.....##|....###|...####|..##.##|.##..##|##...##|#######|.....##|.....##|.....##','5':'#######.|##......|##......|##.###..|###..##.|......##|......##|##....##|.##..##.|..####..','6':'..####..|.##..##.|##....#.|##......|##.###..|###..##.|##....##|##....##|.##..##.|..####..','7':'########|......##|......##|.....##.|....##..|...##...|..##....|.##.....|##......|##......','8':'..####..|.##..##.|##....##|.##..##.|..####..|.##..##.|##....##|##....##|.##..##.|..####..','9':'..####..|.##..##.|##....##|##....##|.##..###|..###.##|......##|.#....##|.##..##.|..####..'};
  // Segment + match
  const thr=128;const colDark=new Float32Array(width);for(let x=0;x<width;x++){let d=0;for(let y=0;y<height;y++)if(px[y*width+x]<thr)d++;colDark[x]=d/height;}
  const inD=Array.from(colDark,v=>v>0.05);const rs=[];let st=-1;for(let x=0;x<=width;x++){if(inD[x]&&st<0)st=x;else if(!inD[x]&&st>=0){rs.push([st,x-1]);st=-1;}}
  const mg=[];for(const s of rs){if(mg.length&&s[0]-mg[mg.length-1][1]<=1)mg[mg.length-1][1]=s[1];else mg.push([...s]);}
  const segs=mg.filter(([a,b])=>b-a>=2);
  let answer='';
  for(const[s,e]of segs){let top=-1,bot=-1;for(let y=0;y<height;y++){let d=0;for(let x=s;x<=e;x++)if(px[y*width+x]<thr)d++;if(d>0){if(top<0)top=y;bot=y;}}if(top<0)continue;const rows=[];for(let y=top;y<=bot;y++){let r='';for(let x=s;x<=e;x++)r+=px[y*width+x]<thr?'#':'.';rows.push(r);}const key=rows.join('|');let m=null;for(const[c,t]of Object.entries(KNOWN)){if(t===key){m=c;break;}}if(!m){let best='?',bestD=Infinity;for(const[c,t]of Object.entries(KNOWN)){const tf=t.replace(/\|/g,''),kf=key.replace(/\|/g,'');if(tf.length!==kf.length)continue;let d=0;for(let i=0;i<tf.length;i++)if(tf[i]!==kf[i])d++;if(d<bestD){bestD=d;best=c;}}m=bestD<=12?best:'?';}answer+=m;}
  console.log('Local OCR:',answer);
  // Step 3: POST answer via worker
  const postUrl=W+'/?url='+encodeURIComponent(safegoUrl);
  const r2=await fetch(postUrl,{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':'PHPSESSID='+sessid,'Origin':'https://safego.cc','Referer':safegoUrl},body:cField+'='+answer})});
  console.log('POST status:',r2.status);
  const j2=await r2.json();
  console.log('POST result:',JSON.stringify(j2).substring(0,500));
}
test().catch(e=>console.error(e));
