'use strict';

const { USER_AGENT } = require('./common');

/**
 * Extract a direct video stream URL from a MaxStream page.
 * MaxStream hosts video via a simple sources[{src: "..."}] structure.
 * @param {string} url  Full URL to the MaxStream embed page
 * @returns {Promise<{url:string, headers:object}|null>}
 */
async function extractMaxStream(url) {
  try {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl.startsWith('http')) return null;

    const resp = await fetch(normalizedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });

    if (!resp.ok) return null;
    const html = await resp.text();

    // Primary pattern: sources[{src: "..."}] (JWPlayer style)
    const primaryMatch = /sources\W+src\W+(https?:\/\/[^"']+)["']/i.exec(html);
    if (primaryMatch && primaryMatch[1]) {
      const videoUrl = primaryMatch[1].trim();
      const origin = new URL(normalizedUrl).origin;
      return {
        url: videoUrl,
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': `${origin}/`,
        },
      };
    }

    // Fallback: file:"..." pattern
    const fallbackMatch = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/i.exec(html);
    if (fallbackMatch && fallbackMatch[1]) {
      const videoUrl = fallbackMatch[1].trim();
      if (videoUrl.startsWith('http')) {
        const origin = new URL(normalizedUrl).origin;
        return {
          url: videoUrl,
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': `${origin}/`,
          },
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

module.exports = { extractMaxStream };
