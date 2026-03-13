const zlib=require('zlib');
const KNOWN={'0':'...##...|..####..|.##..##.|##....##|##....##|##....##|##....##|.##..##.|..####..|...##...','1':'..##|.###|####|..##|..##|..##|..##|..##|..##|####','2':'..####..|.##..##.|##....##|......##|.....##.|....##..|...##...|..##....|.##.....|########','3':'.#####..|##...##.|......##|.....##.|...###..|.....##.|......##|......##|##...##.|.#####..','4':'.....##|....###|...####|..##.##|.##..##|##...##|#######|.....##|.....##|.....##','5':'#######.|##......|##......|##.###..|###..##.|......##|......##|##....##|.##..##.|..####..','6':'..####..|.##..##.|##....#.|##......|##.###..|###..##.|##....##|##....##|.##..##.|..####..','7':'########|......##|......##|.....##.|....##..|...##...|..##....|.##.....|##......|##......','8':'..####..|.##..##.|##....##|.##..##.|..####..|.##..##.|##....##|##....##|.##..##.|..####..','9':'..####..|.##..##.|##....##|##....##|.##..###|..###.##|......##|.#....##|.##..##.|..####..'};
function decodePng(buf){let off=8,w=0,h=0,bd=0,ct=0;const idc=[];while(off<buf.length){const l=buf.readUInt32BE(off);off+=4;const t=buf.toString('ascii',off,off+4);off+=4;const d=buf.slice(off,off+l);off+=l+4;if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);bd=d[8];ct=d[9];}if(t==='IDAT')idc.push(d);if(t==='IEND')break;}const idat=Buffer.concat(idc);const inf=zlib.inflateSync(idat);const ch=[0,0,3,0,2,0,4][ct]||1;const bpp=Math.ceil((bd*ch)/8);const stride=1+w*bpp;const px=new Uint8Array(w*h);let prev=new Uint8Array(w*bpp);for(let y=0;y<h;y++){const ft=inf[y*stride];const cur=new Uint8Array(w*bpp);for(let i=0;i<w*bpp;i++){const b=inf[y*stride+1+i];const a=i>=bpp?cur[i-bpp]:0;const c=(i>=bpp&&y>0)?prev[i-bpp]:0;const p=prev[i];let v;if(ft===0)v=b;else if(ft===1)v=b+a;else if(ft===2)v=b+p;else if(ft===3)v=b+Math.floor((a+p)/2);else{const pa=Math.abs(p-c),pb=Math.abs(a-c),pc=Math.abs(a+p-2*c);v=b+(pa<=pb&&pa<=pc?a:pb<=pc?p:c);}cur[i]=v&0xFF;}prev=cur;for(let x=0;x<w;x++){const r=cur[x*bpp],g=ch>=3?cur[x*bpp+1]:r,bv=ch>=3?cur[x*bpp+2]:r;px[y*w+x]=Math.round(0.299*r+0.587*g+0.114*bv);}}return{w,h,px};}
function ocrDigits(w,h,px){const thr=128;const colDark=new Float32Array(w);for(let x=0;x<w;x++){let d=0;for(let y=0;y<h;y++)if(px[y*w+x]<thr)d++;colDark[x]=d/h;}const inD=Array.from(colDark,v=>v>0.05);const rs=[];let st=-1;for(let x=0;x<=w;x++){if(inD[x]&&st<0)st=x;else if(!inD[x]&&st>=0){rs.push([st,x-1]);st=-1;}}const mg=[];for(const s of rs){if(mg.length&&s[0]-mg[mg.length-1][1]<=1)mg[mg.length-1][1]=s[1];else mg.push([...s]);}const segs=mg.filter(([a,b])=>b-a>=2);let result='';for(const[s,e]of segs){let top=-1,bot=-1;for(let y=0;y<h;y++){let d=0;for(let x=s;x<=e;x++)if(px[y*w+x]<thr)d++;if(d>0){if(top<0)top=y;bot=y;}}if(top<0)continue;const rows=[];for(let y=top;y<=bot;y++){let r='';for(let x=s;x<=e;x++)r+=px[y*w+x]<thr?'#':'.';rows.push(r);}const key=rows.join('|');let m=null;for(const[c,t]of Object.entries(KNOWN)){if(t===key){m=c;break;}}if(!m){let best='?',bestD=Infinity;for(const[c,t]of Object.entries(KNOWN)){const tf=t.replace(/\|/g,''),kf=key.replace(/\|/g,'');if(tf.length!==kf.length)continue;let d=0;for(let i=0;i<tf.length;i++)if(tf[i]!==kf[i])d++;if(d<bestD){bestD=d;best=c;}}m=bestD<=12?best:'?';}result+=m;}return result;}

async function test(){
  const safegoUrl='https://safego.cc/safe.php?url=aHR0cHM6Ly93d3cua2lzc2toLmRvLw';
  // GET
  const r1=await fetch(safegoUrl,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'},redirect:'manual'});
  const sessid=(r1.headers.getSetCookie().join(';').match(/PHPSESSID=([^;]+)/)||[])[1];
  console.log('PHPSESSID:',sessid);
  const html=await r1.text();
  const imgMatch=html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  const cap=decodePng(Buffer.from(imgMatch[1],'base64'));
  const answer=ocrDigits(cap.w,cap.h,cap.px);
  console.log('OCR:',answer);
  // POST without redirect:manual — let it follow redirects  
  const r2=await fetch(safegoUrl,{method:'POST',headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36','Content-Type':'application/x-www-form-urlencoded','Cookie':'PHPSESSID='+sessid,'Origin':'https://safego.cc','Referer':safegoUrl},body:'captch5='+answer});
  console.log('POST final url:',r2.url);
  console.log('POST status:',r2.status);
  console.log('POST redirected:',r2.redirected);
  const body=await r2.text();
  console.log('Body contains captch:',body.includes('captch'));
  console.log('Body contains ncorrect:',body.includes('ncorrect'));
  console.log('Body (300):',body.substring(0,300));
  // Then try GET with both cookies
  const r3=await fetch(safegoUrl,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36','Cookie':'PHPSESSID='+sessid+'; captch5=whatever'},redirect:'manual'});
  console.log('\nGET with captch5 cookie - status:',r3.status,'location:',r3.headers.get('location'));
}
test().catch(e=>console.error(e));
