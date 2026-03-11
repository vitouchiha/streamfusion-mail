const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const PACKER_PATTERNS = [
  /}\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'(.*)'\.split\('\|'\),\s*(\d+),\s*(.*)\)\)/s,
  /}\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'(.*)'\.split\('\|'\)/s,
];

/**
 * Get a proxied URL if a Cloudflare Worker proxy is configured
 * @param {string} url The target URL
 * @param {string} [referer] Optional Referer to pass to the proxy (for cross-origin embeds like VixCloud)
 * @returns {string} The proxied URL or original URL
 */
function getProxiedUrl(url, referer) {
  let proxyUrl = null;
  try {
    // Check global variable (set by stremio_addon.js)
    if (typeof global !== 'undefined' && global.CF_PROXY_URL) {
      proxyUrl = global.CF_PROXY_URL;
    } else if (typeof process !== 'undefined' && process.env && process.env.CF_PROXY_URL) {
      proxyUrl = process.env.CF_PROXY_URL;
    }
  } catch (e) {
    // Safety for some RN environments
  }
  
  if (proxyUrl && url) {
    const separator = proxyUrl.includes('?') ? '&' : '?';
    let result = `${proxyUrl}${separator}url=${encodeURIComponent(url)}`;
    if (referer) result += `&referer=${encodeURIComponent(referer)}`;
    return result;
  }
  return url;
}

function normalizeExtractorUrl(url, baseUrl = null) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  const normalized = raw.startsWith('//') ? `https:${raw}` : raw;
  if (/^https?:\/\//i.test(normalized)) return normalized;

  if (baseUrl) {
    try {
      return new URL(normalized, baseUrl).toString();
    } catch {
      return null;
    }
  }

  return null;
}

function getUrlOrigin(url) {
  try {
    return new URL(String(url || '').trim()).origin;
  } catch {
    return '';
  }
}

function getRefererBase(url, fallback = null) {
  const origin = getUrlOrigin(url);
  if (origin) return `${origin}/`;
  return fallback || null;
}

function unPack(p, a, c, k, e, d) {
  e = function (c2) {
    return (c2 < a ? "" : e(parseInt(c2 / a))) + ((c2 = c2 % a) > 35 ? String.fromCharCode(c2 + 29) : c2.toString(36));
  };
  if (!"".replace(/^/, String)) {
    while (c--) {
      d[e(c)] = k[c] || e(c);
    }
    k = [function (e2) {
      return d[e2] || e2;
    }];
    e = function () {
      return "\\w+";
    };
    c = 1;
  }
  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp("\\b" + e(c) + "\\b", "g"), k[c]);
    }
  }
  return p;
}

function replaceLookupStrings(source) {
  const text = String(source || '');
  const match = /var\s*(_\w+)\s*=\s*\["(.*?)"\];/s.exec(text);
  if (!match) return text;

  const variableName = match[1];
  const values = match[2].split('","');
  let replaced = text;
  for (let index = 0; index < values.length; index += 1) {
    replaced = replaced.replaceAll(`${variableName}[${index}]`, `"${values[index]}"`);
  }

  return replaced.slice(match.index + match[0].length);
}

function unpackPackedSource(source) {
  const text = String(source || '');
  if (!text.includes('eval(function(p,a,c,k,e,d)')) return null;

  for (const pattern of PACKER_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const payload = String(match[1] || '')
      .replace(/\\\\/g, '\\')
      .replace(/\\'/g, "'");
    const radix = match[2] === '[]' ? 62 : Number.parseInt(match[2], 10);
    const count = Number.parseInt(match[3], 10);
    const symtab = String(match[4] || '').split('|');

    if (!Number.isInteger(radix) || !Number.isInteger(count) || symtab.length < count) {
      continue;
    }

    try {
      return replaceLookupStrings(unPack(payload, radix, count, symtab, null, {}));
    } catch {
      continue;
    }
  }

  return null;
}

function getScriptBlocks(html) {
  const blocks = [];
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    if (match[1]) blocks.push(match[1]);
  }
  return blocks;
}

function extractPackedValue(html, patterns = []) {
  const sources = [String(html || ''), ...getScriptBlocks(html)];

  for (const source of sources) {
    const unpacked = unpackPackedSource(source);
    if (!unpacked) continue;

    for (const pattern of patterns) {
      const regex = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags) : null;
      const match = regex ? regex.exec(unpacked) : null;
      if (match && match[1]) {
        return {
          unpacked,
          value: match[1],
        };
      }
    }
  }

  return null;
}

module.exports = {
  USER_AGENT,
  unPack,
  extractPackedValue,
  getProxiedUrl,
  getRefererBase,
  getUrlOrigin,
  normalizeExtractorUrl,
  unpackPackedSource,
};
