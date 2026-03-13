async function main(){
  // Follow clicka.cc delta link
  const clickaUrl='https://clicka.cc/delta/ok6eum3o05ck';
  const r1=await fetch(clickaUrl,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'},redirect:'manual'});
  console.log('clicka status:',r1.status);
  console.log('clicka location:',r1.headers.get('location'));
  // Follow all redirects
  let loc=r1.headers.get('location');
  let hops=0;
  while(loc&&hops<10){
    console.log('hop',hops+1,':',loc);
    if(loc.includes('safego')){
      console.log('\n=== SAFEGO URL FOUND ===');
      console.log(loc);
      break;
    }
    const r2=await fetch(loc,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'},redirect:'manual'});
    loc=r2.headers.get('location');
    hops++;
  }
}
main().catch(e=>console.error(e));
