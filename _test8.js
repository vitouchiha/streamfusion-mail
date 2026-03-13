async function main(){
  // Test follow-up GET with real captch5 cookie
  const safegoUrl='https://safego.cc/safe.php?url=ZWx1b0N3dG91eklSMmhPNk13SXM5dmxoMno1c3FwSWpSMTVSTGRKbHlxaU9uZDBQSHBRalB6RFNqT0hMeTJrRUR1K2hvelFxcVBmK21MZkI1TTlMS2c9PQ==';
  // Use a real PHPSESSID + captch5 cookie from a previous successful solve
  const r=await fetch(safegoUrl,{
    headers:{
      'User-Agent':'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0',
      'Cookie':'PHPSESSID=2eo3nucssco62lm1e3i133t1vd; captch5=bc8d1c842971c384ac842434cb48b4bc',
      'Accept':'text/html,application/xhtml+xml'
    },
    redirect:'manual'
  });
  console.log('Status:',r.status);
  console.log('Location:',r.headers.get('location'));
  const body=await r.text();
  const href=body.match(/<a\s+href="([^"]+)"/i);
  console.log('Has captch:',body.includes('captch'));
  console.log('Href:',href?href[1]:'none');
  console.log('Body(300):',body.substring(0,300));
}
main().catch(e=>console.error(e));
