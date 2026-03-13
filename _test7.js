async function main(){
  let url='https://clicka.cc/adelta/VDhRWVJiaFRtNzBBQzNxS2hSNmdaQT09';
  for(let i=0;i<10;i++){
    console.log('hop',i,':',url);
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36','Referer':'https://safego.cc/'},redirect:'manual'});
    console.log('  status:',r.status);
    const loc=r.headers.get('location');
    if(loc){console.log('  location:',loc);url=loc;}
    else{const b=await r.text();console.log('  body(200):',b.substring(0,200));break;}
  }
}
main().catch(e=>console.error(e));
