const { extractMixDrop } = require('./mixdrop');
const { extractDropLoad } = require('./dropload');
const { extractSuperVideo } = require('./supervideo');
const { extractStreamTape } = require('./streamtape');
const { extractUqload } = require('./uqload');
const { extractUpstream } = require('./upstream');
const { extractVidoza } = require('./vidoza');
const { extractVixCloud } = require('./vixcloud');
const { extractLoadm } = require('./loadm');
const { USER_AGENT, unPack } = require('./common');

const EXTRACTOR_REGISTRY = [
  {
    name: 'MixDrop',
    match: /(mixdrop|m1xdrop)/i,
    run: (url, options = {}) => extractMixDrop(url, options.refererBase),
  },
  {
    name: 'DropLoad',
    match: /dropload/i,
    run: (url, options = {}) => extractDropLoad(url, options.refererBase),
  },
  {
    name: 'SuperVideo',
    match: /supervideo/i,
    run: (url, options = {}) => extractSuperVideo(url, options),
  },
  {
    name: 'StreamTape',
    match: /streamtape/i,
    run: (url) => extractStreamTape(url),
  },
  {
    name: 'Uqload',
    match: /uqload/i,
    run: (url, options = {}) => extractUqload(url, options.refererBase),
  },
  {
    name: 'Upstream',
    match: /upstream/i,
    run: (url, options = {}) => extractUpstream(url, options.refererBase),
  },
  {
    name: 'Vidoza',
    match: /vidoza/i,
    run: (url) => extractVidoza(url),
  },
  {
    name: 'VixCloud',
    match: /vixcloud/i,
    run: (url) => extractVixCloud(url),
  },
  {
    name: 'Loadm',
    match: /loadm/i,
    run: (url, options = {}) => extractLoadm(url, options.loadmReferer || options.refererBase),
  },
];

function normalizeExtractorResults(result, fallbackName) {
  const values = Array.isArray(result) ? result : [result];
  return values
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === 'string') {
        return {
          name: fallbackName,
          url: entry,
        };
      }

      if (!entry.url) return null;
      return {
        ...entry,
        name: entry.name || fallbackName,
      };
    })
    .filter(Boolean);
}

async function extractFromUrl(url, options = {}) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return [];

  const extractor = EXTRACTOR_REGISTRY.find((entry) => entry.match.test(rawUrl));
  if (!extractor) return [];

  try {
    const result = await extractor.run(rawUrl, options);
    return normalizeExtractorResults(result, extractor.name);
  } catch (error) {
    console.error(`[Extractors] ${extractor.name} dispatch error:`, error);
    return [];
  }
}

module.exports = {
  extractMixDrop,
  extractDropLoad,
  extractSuperVideo,
  extractStreamTape,
  extractUqload,
  extractUpstream,
  extractVidoza,
  extractVixCloud,
  extractLoadm,
  extractFromUrl,
  USER_AGENT,
  unPack
};
