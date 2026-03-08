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

function shouldProxyForWebPlayback(url, headers, addonBaseUrl) {
    if (!addonBaseUrl) return false;
    if (isHlsProxyPlaybackUrl(url)) return false;
    return !isMp4Url(url);
}

function formatStream(stream, providerName) {
    // 1. Filter MixDrop (removed from shared formatter, handled in Stremio addon separately)
    // const server = (stream.server || "").toLowerCase();
    // const sName = (stream.name || "").toLowerCase();
    // const sTitle = (stream.title || "").toLowerCase();
    // if (server.includes('mixdrop') || sName.includes('mixdrop') || sTitle.includes('mixdrop')) {
    //     return null;
    // }

    // Format resolution
    let quality = stream.quality || '';
    if (quality === '2160p') quality = '🔥4K UHD';
    else if (quality === '1440p') quality = '✨ QHD';
    else if (quality === '1080p') quality = '🚀 FHD';
    else if (quality === '720p') quality = '💿 HD';
    else if (quality === '576p' || quality === '480p' || quality === '360p' || quality === '240p') quality = '💩 Low Quality';
    else if (!quality || ['auto', 'unknown', 'unknow'].includes(String(quality).toLowerCase())) quality = 'Unknow';

    // Format title with emoji
    let title = `📁 ${stream.title || 'Stream'}`;

    // Extract language if not present
    let language = stream.language;
    if (!language) {
        if (stream.name && (stream.name.includes('SUB ITA') || stream.name.includes('SUB'))) language = '🇯🇵 🇮🇹';
        else if (stream.title && (stream.title.includes('SUB ITA') || stream.title.includes('SUB'))) language = '🇯🇵 🇮🇹';
        else language = '🇮🇹';
    }

    // Add details
    let details = [];
    if (stream.size) details.push(`📦 ${stream.size}`);

    const desc = details.join(' | ');

    // Construct Name: Quality + Provider
    // e.g. "FHD (ProviderName)"
    // Use stream.name as provider name if it's not the quality, otherwise use providerName
    // In providers, stream.name is often the server name (e.g. "VixCloud")
    let pName = stream.name || stream.server || providerName;

    // Clean SUB ITA or ITA from provider name if present
    if (pName) {
        pName = pName
            .replace(/\s*\[?\(?\s*SUB\s*ITA\s*\)?\]?/i, '') // Remove SUB ITA with optional brackets/parens
            .replace(/\s*\[?\(?\s*ITA\s*\)?\]?/i, '')     // Remove ITA with optional brackets/parens
            .replace(/\s*\[?\(?\s*SUB\s*\)?\]?/i, '')     // Remove SUB with optional brackets/parens
            .replace(/\(\s*\)/g, '')                      // Remove empty parentheses
            .replace(/\[\s*\]/g, '')                      // Remove empty brackets
            .trim();
    }

    // Capitalize if using the key name
    if (pName === providerName) {
        pName = pName.charAt(0).toUpperCase() + pName.slice(1);
    }

    // Add antenna emoji if provider exists
    if (pName) {
        pName = `📡 ${pName}`;
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

    if (shouldProxyForWebPlayback(finalUrl, finalHeaders, addonBaseUrl)) {
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
    if (!providerLabel.includes('📡')) {
        providerLabel = `📡 ${providerLabel}`;
    }

    // finalName is the resolution/quality displayed in bold. Like EasyStreams.
    // Quality already includes "🚀" or "💿" from lines 78-83. So we only prepend if it's missing emojis.
    let finalName = quality && quality !== 'Unknow' ? quality : providerLabel;
    if (finalName === 'Unknow' || !finalName) finalName = '🚀 ' + providerLabel;
    
    // finalTitle is the rich multi-line description
    let finalTitle = `📁 ${stream.title || 'Stream'}`;
    finalTitle += `\n${providerLabel}`;

    if (language) {
        let langStr = language;
        // Se c'è già l'emoji, non la rimetto due volte.
        if (langStr.includes('🗣')) {
            finalTitle += `\n${langStr} 🔍 StreamFusion`;
        } else {
            // Alcuni vecchi flussi hanno bandiere 🇮🇹, rimuoviamo solo per simulare "IT" pulito o le lasciamo.
            // EasyStreams usa "🗣 IT". Proviamo a ripulire o aggiungere solo l'emoji.
            langStr = langStr.replace('🇮🇹', 'IT').replace('🇯🇵', 'JP').trim();
            finalTitle += `\n🗣 ${langStr} 🔍 StreamFusion`;
        }
    } else {
         finalTitle += `\n🗣 IT 🔍 StreamFusion`;
    }

    if (desc) finalTitle += `\n📝 ${desc}`;

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
