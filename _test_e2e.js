process.env.CF_WORKER_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';
process.env.CF_WORKER_AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';
const { bypassSafego, extractTurbovidda } = require('./src/extractors/turbovidda');

async function main() {
  const start = Date.now();
  console.log('Testing bypassSafego with real clicka.cc delta link...');
  const deltaUrl = await bypassSafego('https://clicka.cc/delta/ok6eum3o05ck');
  console.log('bypassSafego result:', deltaUrl, '('+(Date.now()-start)+'ms)');
  if (deltaUrl) {
    console.log('Testing extractTurbovidda...');
    const result = await extractTurbovidda(deltaUrl);
    console.log('extractTurbovidda result:', result, '('+(Date.now()-start)+'ms total)');
  }
}
main().catch(e => console.error(e.message));
