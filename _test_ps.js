const zlib = require('zlib');
const KNOWN={'0':'...##...|..####..|.##..##.|##....##|##....##|##....##|##....##|.##..##.|..####..|...##...','1':'..##|.###|####|..##|..##|..##|..##|..##|..##|####','2':'..####..|.##..##.|##....##|......##|.....##.|....##..|...##...|..##....|.##.....|########','3':'.#####..|##...##.|......##|.....##.|...###..|.....##.|......##|......##|##...##.|.#####..','4':'.....##|....###|...####|..##.##|.##..##|##...##|#######|.....##|.....##|.....##','5':'#######.|##......|##......|##.###..|###..##.|......##|......##|##....##|.##..##.|..####..','6':'..####..|.##..##.|##....#.|##......|##.###..|###..##.|##....##|##....##|.##..##.|..####..','7':'########|......##|......##|.....##.|....##..|...##...|..##....|.##.....|##......|##......','8':'..####..|.##..##.|##....##|.##..##.|..####..|.##..##.|##....##|##....##|.##..##.|..####..','9':'..####..|.##..##.|##....##|##....##|.##..###|..###.##|......##|.#....##|.##..##.|..####..'};
function decodePng(buf){let off=8,w=0,h=0,bd=0,ct=0;const idc=[];while(off<buf.length){const l=buf.readUInt32BE(off);off+=4;const t=buf.toString('ascii',off,off+4);off+=4;const d=buf.slice(off,off+l);off+=l+4;if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);bd=d[8];ct=d[9];}if(t==='IDAT')idc.push(d);if(t==='IEND')break;}const idat=Buffer.concat(idc);const inf=zlib.inflateSync(idat);const ch=[0,0,3,0,2,0,4][ct]||1;const bpp=Math.ceil((bd*ch)/8);const stride=1+w*bpp;const px=new Uint8Array(w*h);let prev=new Uint8Array(w*bpp);for(let y=0;y<h;y++){const ft=inf[y*stride];const cur=new Uint8Array(w*bpp);for(let i=0;i<w*bpp;i++){const b=inf[y*stride+1+i];const a=i>=bpp?cur[i-bpp]:0;const c=(i>=bpp&&y>0)?prev[i-bpp]:0;const p=prev[i];let v;if(ft===0)v=b;else if(ft===1)v=b+a;else if(ft===2)v=b+p;else if(ft===3)v=b+Math.floor((a+p)/2);else{const pa=Math.abs(p-c),pb=Math.abs(a-c),pc=Math.abs(a+p-2*c);v=b+(pa<=pb&&pa<=pc?a:pb<=pc?p:c);}cur[i]=v&0xFF;}prev=cur;for(let x=0;x<w;x++){const r=cur[x*bpp],g=ch>=3?cur[x*bpp+1]:r,bv=ch>=3?cur[x*bpp+2]:r;px[y*w+x]=Math.round(0.299*r+0.587*g+0.114*bv);}}return{w,h,px};}
function ocrDigits(w,h,px){const thr=128;const colDark=new Float32Array(w);for(let x=0;x<w;x++){let d=0;for(let y=0;y<h;y++)if(px[y*w+x]<thr)d++;colDark[x]=d/h;}const inD=Array.from(colDark,v=>v>0.05);const rs=[];let st=-1;for(let x=0;x<=w;x++){if(inD[x]&&st<0)st=x;else if(!inD[x]&&st>=0){rs.push([st,x-1]);st=-1;}}const mg=[];for(const s of rs){if(mg.length&&s[0]-mg[mg.length-1][1]<=1)mg[mg.length-1][1]=s[1];else mg.push([...s]);}const segs=mg.filter(([a,b])=>b-a>=2);let result='';for(const[s,e]of segs){let top=-1,bot=-1;for(let y=0;y<h;y++){let d=0;for(let x=s;x<=e;x++)if(px[y*w+x]<thr)d++;if(d>0){if(top<0)top=y;bot=y;}}if(top<0)continue;const rows=[];for(let y=top;y<=bot;y++){let r='';for(let x=s;x<=e;x++)r+=px[y*w+x]<thr?'#':'.';rows.push(r);}const key=rows.join('|');let m=null;for(const[c,t]of Object.entries(KNOWN)){if(t===key){m=c;break;}}if(!m){let best='?',bestD=Infinity;for(const[c,t]of Object.entries(KNOWN)){const tf=t.replace(/\|/g,''),kf=key.replace(/\|/g,'');if(tf.length!==kf.length)continue;let d=0;for(let i=0;i<tf.length;i++)if(tf[i]!==kf[i])d++;if(d<bestD){bestD=d;best=c;}}m=bestD<=12?best:'?';}result+=m;}return result;}

// Use PowerShell to POST (different TLS stack)
const {execSync}=require('child_process');

async function testViaPS(){
  const safegoUrl='https://safego.cc/safe.php?url=aHR0cHM6Ly93d3cua2lzc2toLmRvLw';
  // 1. GET via PS
  console.log('1. GET via PowerShell...');
  const getCmd=$r = Invoke-WebRequest -Uri '' -UseBasicParsing -SessionVariable s; @{status=@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.StatusCode; cookies=(.Cookies.GetCookies('')|ForEach-Object{.Name+'='+.Value}); body=@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.Content} | ConvertTo-Json -Depth 3;
  const getResult=JSON.parse(execSync('powershell -Command "'+getCmd.replace(/"/g,'\\"')+'"',{encoding:'utf8',maxBuffer:1024*1024}));
  console.log('Status:',getResult.status);
  console.log('Cookies:',getResult.cookies);
  const sessid=(Array.isArray(getResult.cookies)?getResult.cookies:[getResult.cookies]).find(c=>c?.startsWith('PHPSESSID='))?.split('=')[1];
  console.log('PHPSESSID:',sessid);
  const html=getResult.body;
  const imgMatch=html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if(!imgMatch){console.log('No captcha');return;}
  const cap=decodePng(Buffer.from(imgMatch[1],'base64'));
  const answer=ocrDigits(cap.w,cap.h,cap.px);
  console.log('OCR answer:',answer);
  // 2. POST via PS with same session
  console.log('\n2. POST via PowerShell...');
  const postCmd=$s=New-Object Microsoft.PowerShell.Commands.WebRequestSession; =New-Object System.Net.Cookie('PHPSESSID','','/','safego.cc'); .Cookies.Add(); @{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}=Invoke-WebRequest -Uri '' -Method POST -Body 'captch5=' -ContentType 'application/x-www-form-urlencoded' -WebSession  -UseBasicParsing -MaximumRedirection 0 -ErrorAction SilentlyContinue; @{status=[int]@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.StatusCode; location=@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.Headers['Location']; cookies=(@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.Headers['Set-Cookie']); bodyLen=@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.Content.Length; bodyStart=@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.Content.Substring(0,[Math]::Min(300,@{eurostream_wp=; safego=; clickaCC=; deltabit=; eurostream_viaCF=; mostraguarda=; clickaCC_viaCF=; cb01=; safego_viaCF=; guardoserie=; guardaserie=; guardaflix=}.Content.Length))} | ConvertTo-Json;
  try{
    const postResult=JSON.parse(execSync('powershell -Command "'+postCmd.replace(/"/g,'\\"')+'"',{encoding:'utf8',maxBuffer:1024*1024}));
    console.log(JSON.stringify(postResult,null,2));
  }catch(e){
    console.log('POST error:',e.message.substring(0,500));
    console.log('stdout:',e.stdout?.toString().substring(0,500));
    console.log('stderr:',e.stderr?.toString().substring(0,500));
  }
}
testViaPS();
