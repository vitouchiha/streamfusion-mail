const W='https://kisskh-proxy.vitobsfm.workers.dev';
const H={'x-worker-auth':'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3'};
async function test(){
  const r=await fetch(W+'/?safego_diag=1&url='+encodeURIComponent('https://safego.cc/safe.php?url=TEST'),{headers:H});
  const j=await r.json();
  console.log('Size:',j.width+'x'+j.height,'Answer:',j.answer,'b64len:',j.b64len);
  if(j.ascii) for(const l of j.ascii) console.log(l);
  if(j.error) console.log('ERROR:',j.error);
}
test().catch(e=>console.error(e));
