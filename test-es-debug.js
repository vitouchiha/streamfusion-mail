'use strict';

// Simulate Vercel environment — force Worker path
process.env.CF_WORKER_URL = 'https://kisskh-proxy.vitobsfm.workers.dev';
process.env.CF_WORKER_AUTH = 'PJxVzfuySO5IkMGec1pZsFvWDNbiHRE6jULnB2t3';

const eurostreaming = require('./src/eurostreaming');

async function test() {
  const start = Date.now();
  console.log('Testing Eurostreaming getStreams for The Witcher S1E1...');
  console.log('Using Worker path (simulating Vercel)\n');

  const providerContext = {
    __requestContext: true,
    idType: 'imdb',
    imdbId: 'tt5180504',
    tmdbId: '71912',
    primaryTitle: 'The Witcher',
    titleCandidates: ['The Witcher'],
    mfpUrl: 'https://easy.koyeb.app/',
    addonBaseUrl: '',
  };

  try {
    const streams = await eurostreaming.getStreams(
      'tt5180504', 'series', 1, 1, providerContext
    );
    console.log(`\nResult: ${streams.length} streams in ${Date.now() - start}ms`);
    for (const s of streams) {
      console.log(`  - ${s.name} | ${(s.title || '').substring(0, 80)}`);
    }
  } catch (err) {
    console.error('Error:', err.message, err.stack);
  }
}

test();
