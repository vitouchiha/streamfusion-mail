const W='https://kisskh-proxy.vitobsfm.workers.dev';
const H={'x-worker-auth':'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3'};
async function test(){
  const r=await fetch(W+'/?safego=1&url='+encodeURIComponent('https://safego.cc/safe.php?url=aHR0cHM6Ly93d3cua2lzc2toLmRvLw'),{headers:H});
  const j=await r.json();
  console.log(JSON.stringify(j, null, 2));
}
test().catch(e=>console.error(e));
