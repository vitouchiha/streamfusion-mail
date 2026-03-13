const W='https://kisskh-proxy.vitobsfm.workers.dev';
const H={'x-worker-auth':'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3'};
async function test(){
  const r=await fetch(W+'/?url='+encodeURIComponent('https://safego.cc/safe.php?url=aHR0cHM6Ly93d3cua2lzc2toLmRvLw')+'&wantCookie=1',{headers:H});
  const j=await r.json();
  const html=j.body;
  // Find key patterns
  const formMatch=html.match(/<form[\s\S]*?<\/form>/i);
  if(formMatch) console.log('FORM:', formMatch[0].substring(0,2000));
  else console.log('No form found');
  // All input fields
  const inputs=[...html.matchAll(/<input[^>]*>/gi)];
  console.log('\nINPUT FIELDS:');
  for(const m of inputs) console.log(m[0]);
  // Any "Incorrect" text
  if(html.includes('ncorrect')) console.log('\nFound Incorrect text');
  // Check for hidden fields
  const hiddens=[...html.matchAll(/type=.hidden.[^>]*>/gi)];
  console.log('\nHIDDEN FIELDS:',hiddens.length);
  for(const m of hiddens) console.log(m[0]);
}
test().catch(e=>console.error(e));
