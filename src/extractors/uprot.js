/**
 * Uprot.net → MaxStream resolver
 * 
 * Attempts to bypass uprot.net using webshare proxy (Spanish IP).
 * If the proxy IP is in a "trusted" geo, uprot may skip the captcha
 * and redirect directly to the MaxStream embed.
 *
 * Flow: POST to uprot link → look for "CONTINUE" link → follow redirects → extract MaxStream URL
 */

const { extractMaxStream } = require('./maxstream');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function getWebshareProxy() {
  const raw = (process.env.WEBSHARE_PROXIES || '').trim();
  if (!raw) return null;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Try to resolve an uprot.net link to a MaxStream embed URL.
 * Returns { url, headers } or null.
 */
async function extractUprot(uprotUrl) {
  try {
    // Normalize mse → msf (as in Python ref)
    let link = String(uprotUrl).trim();
    if (link.includes('/mse/')) {
      link = link.replace('/mse/', '/msf/');
    }

    const proxy = getWebshareProxy();
    const fetchOptions = {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': new URL(link).origin,
        'Referer': link,
      },
      redirect: 'follow',
    };

    // If we have a proxy, use it via the CF Worker proxy
    // Otherwise try direct (might get captcha)
    let html;
    const cfProxy = process.env.CF_PROXY_URL || (typeof global !== 'undefined' && global.CF_PROXY_URL);

    if (cfProxy) {
      // Route through CF Worker which can use the proxy
      const sep = cfProxy.includes('?') ? '&' : '?';
      const proxyUrl = `${cfProxy}${sep}url=${encodeURIComponent(link)}`;
      const resp = await fetch(proxyUrl, {
        headers: { 'User-Agent': UA, 'Referer': link },
        redirect: 'follow',
      });
      if (!resp.ok) return null;
      html = await resp.text();
    } else {
      const resp = await fetch(link, fetchOptions);
      if (!resp.ok) return null;
      html = await resp.text();
    }

    // Look for the "C O N T I N U E" link that leads to MaxStream
    const continueMatch = html.match(/<a[^>]+href="([^"]+)"[^>]*>[^<]*C\s*O\s*N\s*T\s*I\s*N\s*U\s*E[^<]*<\/a>/i);
    if (!continueMatch) {
      // Check if we got a captcha page instead
      if (html.includes('captcha') || html.includes('CAPTCHA')) {
        console.log('[Extractors] Uprot: captcha required, cannot bypass');
        return null;
      }
      console.log('[Extractors] Uprot: no CONTINUE link found');
      return null;
    }

    let maxstreamUrl = continueMatch[1];

    // Follow redirects from uprots domain to get final MaxStream URL
    if (maxstreamUrl.includes('uprots')) {
      try {
        const redirectResp = await fetch(maxstreamUrl, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
        });
        const finalUrl = redirectResp.url;
        // Convert to maxstream embed URL
        if (finalUrl.includes('watchfree/')) {
          const parts = finalUrl.split('watchfree/');
          if (parts[1]) {
            const videoId = parts[1].split('/')[1];
            if (videoId) {
              maxstreamUrl = `https://maxstream.video/emvvv/${videoId}`;
            }
          }
        } else {
          maxstreamUrl = finalUrl;
        }
      } catch {
        // If redirect following fails, skip
        return null;
      }
    }

    // Now extract the actual video URL from MaxStream
    if (maxstreamUrl.includes('maxstream')) {
      return extractMaxStream(maxstreamUrl);
    }

    return null;
  } catch (e) {
    console.error('[Extractors] Uprot extraction error:', e);
    return null;
  }
}

module.exports = { extractUprot };
