const W='https://kisskh-proxy.vitobsfm.workers.dev';
const H={'x-worker-auth':'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3'};
async function test(){
  let ok=0,tot=0;
  for(let i=0;i<10;i++){
    const r=await fetch(W+'/?safego=1&url='+encodeURIComponent('https://safego.cc/safe.php?url=TESTPARAM'),{headers:H});
    const j=await r.json();
    tot++;
    const won=!!j.url;
    if(won) ok++;
    const last=j.attempts?j.attempts[j.attempts.length-1]:j;
    console.log('#'+tot, won?'WIN':'FAIL', 'method:'+(last.ocrMethod||'?'), 'answer:'+(last.answer||j.answer||'?'), won?'url:'+j.url:'status:'+(last.postStatus||'?'));
  }
  console.log('\nScore:',ok+'/'+tot);
}
test().catch(e=>console.error(e));
