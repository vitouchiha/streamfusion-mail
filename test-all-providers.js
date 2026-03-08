const { performance } = require('perf_hooks');
const providers = [
  { name: 'StreamingCommunity', module: require('./src/streamingcommunity/index.js') },
  { name: 'GuardaHD', module: require('./src/guardahd/index.js') },
  { name: 'Guardaserie', module: require('./src/guardaserie/index.js') },
  { name: 'Guardoserie', module: require('./src/guardoserie/index.js') },
  { name: 'AnimeUnity', module: require('./src/animeunity/index.js') },
  { name: 'AnimeWorld', module: require('./src/animeworld/index.js') },
  { name: 'AnimeSaturn', module: require('./src/animesaturn/index.js') }
];

async function checkAll() {
  const imdbId = 'tt3909224'; // Nanatsu no Taizai
  const context = {
        __requestContext: true,
        idType: 'imdb',
        providerId: 'tt3909224',
        requestedSeason: 3,
        seasonProvided: true,
        kitsuId: '42263',
        tmdbId: '62104',
        imdbId: 'tt3909224',
        mappedSeason: 3,
        canonicalSeason: 1 // Note: Season 3 in Kitsu is Season 1 in some mappings or just S3 for standard TV? Wait, Kitsu has absolute numbers sometimes. But we pass mappedSeason.
  };
  
  console.log('--- STARTING PROVIDER CHECK (Nanatsu no Taizai) ---');
  for (const p of providers) {
      const t0 = performance.now();
      try {
          const res = await p.module.getStreams(imdbId, 'series', 3, 1, context);
          const t1 = performance.now();
          console.log('[' + p.name + '] Success! Found ' + (res ? res.length : 0) + ' streams. Time: ' + (t1 - t0).toFixed(2) + 'ms');
          if (res && res.length > 0) {
              console.log('   -> Formatted Stream Preview:');
              console.log(JSON.stringify(res[0], null, 2).replace(/^/gm, '      '));
          }
      } catch (e) {
          const t1 = performance.now();
          console.log('[' + p.name + '] FAILED. Time: ' + (t1 - t0).toFixed(2) + 'ms');
          console.log('   -> Error: ', e.message);
      }
  }

  // LET'S TEST A NORMAL SERIES TOO
  const context2 = {
        __requestContext: true,
        idType: 'imdb',
        providerId: 'tt0903747', // Breaking Bad
        requestedSeason: 1,
        seasonProvided: true,
        tmdbId: '1396',
        imdbId: 'tt0903747',
        mappedSeason: 1,
        canonicalSeason: 1
  };
  console.log('\n--- STARTING PROVIDER CHECK (Breaking Bad) ---');
  for (const p of providers) {
      const t0 = performance.now();
      try {
          const res = await p.module.getStreams('tt0903747', 'series', 1, 1, context2);
          const t1 = performance.now();
          console.log('[' + p.name + '] Success! Found ' + (res ? res.length : 0) + ' streams. Time: ' + (t1 - t0).toFixed(2) + 'ms');
          if (res && res.length > 0) {
              console.log('   -> Formatted Stream Preview:');
              console.log(JSON.stringify(res[0], null, 2).replace(/^/gm, '      '));
          }
      } catch (e) {
          const t1 = performance.now();
          console.log('[' + p.name + '] FAILED. Time: ' + (t1 - t0).toFixed(2) + 'ms');
          console.log('   -> Error: ', e.message);
      }
  }
}
checkAll();

