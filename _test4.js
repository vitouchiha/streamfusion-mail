// Get a real safego URL from Eurostreaming's Snowpiercer S4E1 page
async function main(){
  // Step 1: Get the eurostreaming episode page
  const epUrl='https://eurostream.ing/serie/snowpiercer-streaming/stagione-4/episodio-1/';
  const r=await fetch(epUrl,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'}});
  const html=await r.text();
  console.log('Page status:',r.status,'length:',html.length);
  
  // Find all clicka.cc delta links
  const links=[...html.matchAll(/href=["']([^"']*clicka[^"']*delta[^"']*)/gi)].map(m=>m[1]);
  console.log('Delta links:',links.length);
  links.forEach(l=>console.log(' ',l));
  
  if(links.length===0){
    // Try to find any clicka link or safego link
    const allClicka=[...html.matchAll(/href=["']([^"']*clicka[^"']*)/gi)].map(m=>m[1]);
    console.log('All clicka links:',allClicka.length);
    allClicka.forEach(l=>console.log(' ',l));
    const allSafego=[...html.matchAll(/href=["']([^"']*safego[^"']*)/gi)].map(m=>m[1]);
    console.log('All safego links:',allSafego.length);
    allSafego.forEach(l=>console.log(' ',l));
  }
  
  if(links.length>0){
    // Step 2: Follow the first clicka link to find safego URL
    const clickaUrl=links[0];
    console.log('\nFollowing:',clickaUrl);
    const r2=await fetch(clickaUrl,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'},redirect:'manual'});
    console.log('Status:',r2.status,'Location:',r2.headers.get('location'));
  }
}
main().catch(e=>console.error(e));
