const { USER_AGENT, normalizeExtractorUrl } = require('./common');

/**
 * VOE video extractor - ported from Python (mediaflow-proxy / MammaMia)
 * Flow: fetch page → follow redirect → extract obfuscated JSON payload + LUTs → decode → get direct URL
 */

function voeDecode(ct, lutsRaw) {
  // Parse LUTs from string like "['xx','yy','zz']"
  const luts = lutsRaw
    .slice(2, -2)
    .split("','")
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // ROT13 variant
  let txt = '';
  for (const ch of ct) {
    let x = ch.charCodeAt(0);
    if (x > 64 && x < 91) {
      x = ((x - 52) % 26) + 65;
    } else if (x > 96 && x < 123) {
      x = ((x - 84) % 26) + 97;
    }
    txt += String.fromCharCode(x);
  }

  // Strip LUT patterns
  for (const lut of luts) {
    txt = txt.replace(new RegExp(lut, 'g'), '');
  }

  // Base64 decode
  const decoded1 = Buffer.from(txt, 'base64').toString('utf-8');

  // Char shift (-3)
  let shifted = '';
  for (const ch of decoded1) {
    shifted += String.fromCharCode(ch.charCodeAt(0) - 3);
  }

  // Reverse + base64 decode
  const reversed = shifted.split('').reverse().join('');
  const finalJson = Buffer.from(reversed, 'base64').toString('utf-8');

  return JSON.parse(finalJson);
}

async function extractVoe(url) {
  try {
    url = normalizeExtractorUrl(url);
    if (!url) return null;

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': url,
      },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const html = await response.text();
    const finalUrl = response.url || url;

    // Check for redirect via window.location.href
    const redirectMatch = html.match(/window\.location\.href\s*=\s*'([^']+)'/);
    if (redirectMatch) {
      return extractVoe(redirectMatch[1]);
    }

    // Extract obfuscated payload and external script URL
    const codeAndScriptMatch = html.match(/json">\["([^"]+)"]<\/script>\s*<script\s*src="([^"]+)"/);
    if (!codeAndScriptMatch) {
      console.error('[Extractors] VOE: unable to locate obfuscated payload or script URL');
      return null;
    }

    const payload = codeAndScriptMatch[1];
    const scriptPath = codeAndScriptMatch[2];

    // Resolve script URL relative to the final page URL
    let scriptUrl;
    try {
      scriptUrl = new URL(scriptPath, finalUrl).toString();
    } catch {
      return null;
    }

    const scriptResponse = await fetch(scriptUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': finalUrl,
      },
    });
    if (!scriptResponse.ok) return null;
    const scriptText = await scriptResponse.text();

    // Extract LUTs from external script
    const lutsMatch = scriptText.match(/(\[(?:'\W{2}'[,\]]){1,9})/);
    if (!lutsMatch) {
      console.error('[Extractors] VOE: unable to locate LUTs in external script');
      return null;
    }

    const data = voeDecode(payload, lutsMatch[1]);
    const videoUrl = data && data.source;
    if (!videoUrl) {
      console.error('[Extractors] VOE: no source in decoded data');
      return null;
    }

    return {
      url: videoUrl,
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': finalUrl,
      },
    };
  } catch (e) {
    console.error('[Extractors] VOE extraction error:', e);
    return null;
  }
}

module.exports = { extractVoe };
