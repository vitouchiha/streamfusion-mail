const { createTimeoutSignal } = require("./fetch_helper.js");
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

async function checkQualityFromPlaylist(url, headers = {}, proxyUrl) {
  try {
    if (!url.includes('.m3u8')) return null;
    
    const finalHeaders = { ...headers };
    if (!finalHeaders['User-Agent']) {
        finalHeaders['User-Agent'] = USER_AGENT;
    }

    // Use axios with proxy agent when a proxy URL is provided (for IP-locked CDNs)
    if (proxyUrl) {
      try {
        const axios = require('axios');
        const { makeProxyAgent } = require('./utils/fetcher');
        const agent = makeProxyAgent(proxyUrl);
        const resp = await axios.get(url, {
          headers: finalHeaders,
          timeout: 4000,
          ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}),
        });
        const text = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
        const quality = checkQualityFromText(text);
        if (quality) console.log(`[QualityHelper] Detected ${quality} from playlist (via proxy): ${url}`);
        return quality;
      } catch {
        return null;
      }
    }

    const timeoutConfig = createTimeoutSignal(3000);
    try {
      const response = await fetch(url, { 
        headers: finalHeaders,
        signal: timeoutConfig.signal
      });

      if (!response.ok) return null;
      const text = await response.text();

      const quality = checkQualityFromText(text);
      
      if (quality) console.log(`[QualityHelper] Detected ${quality} from playlist: ${url}`);
      return quality;
    } finally {
      if (typeof timeoutConfig.cleanup === "function") {
        timeoutConfig.cleanup();
      }
    }
  } catch (e) {
    return null;
  }
}

function checkQualityFromText(text) {
    if (!text) return null;
    if (/RESOLUTION=\d+x2160/i.test(text) || /RESOLUTION=2160/i.test(text)) return '4K';
    if (/RESOLUTION=\d+x1440/i.test(text) || /RESOLUTION=1440/i.test(text)) return '1440p';
    if (/RESOLUTION=\d+x1080/i.test(text) || /RESOLUTION=1080/i.test(text)) return '1080p';
    if (/RESOLUTION=\d+x720/i.test(text) || /RESOLUTION=720/i.test(text)) return '720p';
    if (/RESOLUTION=\d+x480/i.test(text) || /RESOLUTION=480/i.test(text)) return '480p';
    // Fallback: infer quality from BANDWIDTH when RESOLUTION is absent (e.g. serversicuro.cc)
    const bwMatches = text.match(/BANDWIDTH=(\d+)/gi);
    if (bwMatches && bwMatches.length > 0) {
      const maxBw = Math.max(...bwMatches.map(m => parseInt(m.replace(/BANDWIDTH=/i, ''), 10)));
      if (maxBw >= 8000000) return '4K';
      if (maxBw >= 3500000) return '1080p';
      if (maxBw >= 1500000) return '720p';
      if (maxBw >= 500000) return '480p';
      return '360p';
    }
    return null;
}

function getQualityFromUrl(url) {
    if (!url) return null;
    const urlPath = url.split('?')[0].toLowerCase();
    
    if (urlPath.includes("4k") || urlPath.includes("2160")) return "4K";
    if (urlPath.includes("1440") || urlPath.includes("2k")) return "1440p";
    if (urlPath.includes("1080") || urlPath.includes("fhd")) return "1080p";
    if (urlPath.includes("720") || urlPath.includes("hd")) return "720p";
    if (urlPath.includes("480") || urlPath.includes("sd")) return "480p";
    if (urlPath.includes("360")) return "360p";
    
    return null; // Don't default to HD, return null so provider can decide fallback
}

module.exports = { checkQualityFromPlaylist, getQualityFromUrl, checkQualityFromText };
