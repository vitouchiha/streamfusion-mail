async function main(){
  const safegoUrl='https://safego.cc/safe.php?url=ZWx1b0N3dG91eklSMmhPNk13SXM5dmxoMno1c3FwSWpSMTVSTGRKbHlxaU9uZDBQSHBRalB6RFNqT0hMeTJrRUR1K2hvelFxcVBmK21MZkI1TTlMS2c9PQ==';
  const workerUrl='https://kisskh-proxy.vitobsfm.workers.dev/?safego=1&url='+encodeURIComponent(safegoUrl);
  console.log('Testing Worker safego solver...');
  const r=await fetch(workerUrl,{headers:{'x-worker-auth':'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3'}});
  const data=await r.json();
  console.log('Result:',JSON.stringify(data,null,2));
}
main().catch(e=>console.error(e));
