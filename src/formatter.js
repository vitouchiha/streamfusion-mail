const { buildProxyUrl, isHlsProxyPlaybackUrl } = require('./utils/hlsProxy');

function isMp4Url(rawUrl, depth = 0) {
    const url = String(rawUrl || '').trim();
    if (!url) return false;

    const directMatch = (value) => /\.mp4(?:[?#].*)?$/i.test(String(value || '').trim());
    if (directMatch(url)) return true;
    if (depth >= 1) return false;

    try {
        const parsed = new URL(url);
        if (String(parsed.pathname || '').toLowerCase().endsWith('.mp4')) return true;

        // Handle proxy URLs that carry the real media URL in query params
        const nestedKeys = ['url', 'src', 'file', 'link', 'stream'];
        for (const key of nestedKeys) {
            const nested = parsed.searchParams.get(key);
            if (!nested) continue;

            let decoded = nested;
            try {
                decoded = decodeURIComponent(nested);
            } catch (_) {
                decoded = nested;
            }
            if (isMp4Url(decoded, depth + 1)) return true;
        }
        return false;
    } catch {
        return directMatch(url);
    }
}

function shouldSetNotWebReady(url, headers, behaviorHints = {}) {
    if (behaviorHints.notWebReady === false) return false;
    if (behaviorHints.notWebReady === true && !isMp4Url(url)) return true;
    if (isHlsProxyPlaybackUrl(url)) return false;
    if (isMp4Url(url)) return false;
    const proxyHeaders = behaviorHints.proxyHeaders && behaviorHints.proxyHeaders.request;
    if (proxyHeaders && Object.keys(proxyHeaders).length > 0) return true;
    if (headers && Object.keys(headers).length > 0) return true;
    return true;
}

function cloneBehaviorHints(behaviorHints = {}) {
    const next = { ...behaviorHints };
    if (behaviorHints.proxyHeaders && typeof behaviorHints.proxyHeaders === 'object') {
        next.proxyHeaders = { ...behaviorHints.proxyHeaders };
        if (behaviorHints.proxyHeaders.request && typeof behaviorHints.proxyHeaders.request === 'object') {
            next.proxyHeaders.request = { ...behaviorHints.proxyHeaders.request };
        }
    }
    return next;
}

function hasHeaders(headers) {
    return !!(headers && typeof headers === 'object' && Object.keys(headers).length > 0);
}

function shouldProxyForWebPlayback(stream, url, headers, addonBaseUrl) {
    if (!addonBaseUrl) return false;
    if (isHlsProxyPlaybackUrl(url)) return false;
    if (stream.isExternal) return false; // Non proxare le pagine web esterne
    return !isMp4Url(url);
}

function formatStream(stream, providerName) {
    // Format resolution con tema cani 🐶
    let quality = stream.quality || '';
    if (quality === '2160p') quality = '🐺 4K UHD';
    else if (quality === '1440p') quality = '🐕‍🦺 QHD';
    else if (quality === '1080p') quality = '🐕 FHD';
    else if (quality === '720p') quality = '🐩 HD';
    else if (quality === '576p' || quality === '480p' || quality === '360p' || quality === '240p') quality = '🐾 SD Quality';
    else if (!quality || ['auto', 'unknown', 'unknow'].includes(String(quality).toLowerCase())) quality = 'Unknow';

    // Format title with emoji
    let title = `🦴 ${stream.title || 'Stream'}`;

    // Extract language if not present
    let language = stream.language;
    if (!language) {
        if (stream.name && (stream.name.includes('SUB ITA') || stream.name.includes('SUB'))) language = '🇯🇵 🇮🇹';
        else if (stream.title && (stream.title.includes('SUB ITA') || stream.title.includes('SUB'))) language = '🇯🇵 🇮🇹';
        else language = '🇮🇹';
    }

    // Dettagli ricchi (Bitrate, Codec Video/Audio, FPS) - Tutte le info possibili
    let details = [];
    if (stream.size) details.push(`🥩 ${stream.size}`);
    if (stream.videoCodec) details.push(`🎞 ${stream.videoCodec}`);
    if (stream.audioCodec) details.push(`🔊 ${stream.audioCodec}`);
    if (stream.bitrate) details.push(`📶 ${stream.bitrate}`);
    if (stream.fps) details.push(`🎬 ${stream.fps} fps`);

    const desc = details.join(' | ');

    // Construct Name: Quality + Provider
    let pName = stream.name || stream.server || providerName;

    // Clean SUB ITA or ITA from provider name if present
    if (pName) {
        pName = pName
            .replace(/\s*\[?\(?\s*SUB\s*ITA\s*\)?\]?/i, '') 
            .replace(/\s*\[?\(?\s*ITA\s*\)?\]?/i, '')     
            .replace(/\s*\[?\(?\s*SUB\s*\)?\]?/i, '')     
            .replace(/\(\s*\)/g, '')                      
            .replace(/\[\s*\]/g, '')                      
            .trim();
    }

    // Capitalize if using the key name
    if (pName === providerName) {
        pName = pName.charAt(0).toUpperCase() + pName.slice(1);
    }

    // Aggiungi zampa cane se esiste il provider
    if (pName) {
        pName = `🐾 ${pName}`;
    }

    // Move headers to behaviorHints if present, but keep original for compatibility
    const behaviorHints = cloneBehaviorHints(stream.behaviorHints || {});
    const addonBaseUrl = String(stream.addonBaseUrl || stream.providerContext?.addonBaseUrl || '').trim();
    let finalHeaders = stream.headers;
    let finalUrl = stream.url;

    if (behaviorHints.proxyHeaders && behaviorHints.proxyHeaders.request) {
        finalHeaders = behaviorHints.proxyHeaders.request;
    } else if (behaviorHints.headers) {
        finalHeaders = behaviorHints.headers;
    }

    if (shouldProxyForWebPlayback(stream, finalUrl, finalHeaders, addonBaseUrl)) {
        const proxiedUrl = buildProxyUrl(addonBaseUrl, finalUrl, finalHeaders);
        if (proxiedUrl) {
            finalUrl = proxiedUrl;
            finalHeaders = null;
            delete behaviorHints.proxyHeaders;
            delete behaviorHints.headers;
            behaviorHints.notWebReady = false;
        }
    }

    if (finalHeaders) {
        behaviorHints.proxyHeaders = behaviorHints.proxyHeaders || {};
        behaviorHints.proxyHeaders.request = finalHeaders;
        // Also support "headers" in behaviorHints directly (Stremio extension)
        behaviorHints.headers = finalHeaders;
    } else {
        delete behaviorHints.proxyHeaders;
        delete behaviorHints.headers;
    }

    behaviorHints.notWebReady = shouldSetNotWebReady(finalUrl, finalHeaders, behaviorHints);

    let providerLabel = pName || (typeof providerName === 'string' ? providerName.charAt(0).toUpperCase() + providerName.slice(1) : 'Provider');
    if (!providerLabel.includes('🐾')) {
        providerLabel = `🐾 ${providerLabel}`;
    }

    // Qualità con faccine
    let finalName = quality && quality !== 'Unknow' ? quality : providerLabel;
    if (finalName === 'Unknow' || !finalName) finalName = '🐶 ' + providerLabel;
    
    // Titolo arricchito con Osso
    let finalTitle = `🦴 ${stream.title || 'Stream'}`;
    finalTitle += `\n${providerLabel}`;

    if (language) {
        let langStr = language;
        if (langStr.includes('🦮')) {
            finalTitle += `\n${langStr} 🎾 StreamFusion`;
        } else {
            langStr = langStr.replace('🇮🇹', 'IT').replace('🇯🇵', 'JP').trim();
            finalTitle += `\n🦮 ${langStr} 🎾 StreamFusion`;
        }
    } else {
         finalTitle += `\n🦮 IT 🎾 StreamFusion`;
    }

    // Altre info
    if (desc) finalTitle += `\n${desc}`;

    const responseStream = {
        url: finalUrl,
        name: finalName,
        title: finalTitle,
        behaviorHints: behaviorHints,
    };

    if (stream.subtitles) {
        responseStream.subtitles = stream.subtitles;
    }
    if (stream.description) {
        responseStream.description = stream.description;
    }

    return responseStream;
}

module.exports = { formatStream };
