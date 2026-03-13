const W='https://kisskh-proxy.vitobsfm.workers.dev';
const H={'x-worker-auth':'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3'};
async function test(){
  const r=await fetch(W+'/?url='+encodeURIComponent('https://safego.cc/safe.php?url=aHR0cHM6Ly93d3cua2lzc2toLmRvLw')+'&wantCookie=1',{headers:H});
  const j=await r.json();
  console.log('Full Set-Cookie:', j.setCookie);
  console.log('Location:', j.location);
  const html=j.body;
  // Look for script tags
  const scripts=[...html.matchAll(/<script[\s\S]*?<\/script>/gi)];
  console.log('\nSCRIPT tags:', scripts.length);
  for(const s of scripts) console.log(s[0].substring(0,300));
  // Look for cookie-related JS
  if(html.includes('document.cookie')) console.log('\nFound document.cookie!');
  // Look for meta refresh
  if(html.includes('http-equiv')) console.log('\nFound meta http-equiv!');
  // Full HTML structure
  console.log('\n=== Full HTML length:', html.length, '===');
  console.log(html.substring(0, 500));
  console.log('---');
  console.log(html.substring(html.length - 200));
}
test().catch(e=>console.error(e));
