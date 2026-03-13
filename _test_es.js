process.env.CF_WORKER_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';
process.env.CF_WORKER_AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';
const es = require('./src/eurostreaming/index');

async function main() {
  const start = Date.now();
  console.log('Testing Eurostreaming getStreams for Snowpiercer S4E1...');
  const streams = await es.getStreams('tt6156584', 'series', 4, 1, {
    imdbId: 'tt6156584',
    tmdbId: '79680',
    primaryTitle: 'Snowpiercer',
    titleCandidates: ['Snowpiercer'],
  });
  console.log('Time:', (Date.now()-start)+'ms');
  console.log('Streams found:', streams.length);
  streams.forEach(s => console.log(' ', s.name, '|', s.title?.split('\n')[0]));
}
main().catch(e => console.error('ERROR:', e.message, e.stack));
