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
    // MP4 URLs that require custom headers (e.g. Referer/Origin for MixDrop)
    // MUST be notWebReady so Stremio applies proxyHeaders.
    if (isMp4Url(url)) {
        const proxyHeaders = behaviorHints.proxyHeaders && behaviorHints.proxyHeaders.request;
        if (proxyHeaders && Object.keys(proxyHeaders).length > 0) return true;
        if (headers && Object.keys(headers).length > 0) return true;
        return false;
    }
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
    if (stream.behaviorHints && stream.behaviorHints.proxyPlaybackDisabled) return false;
    if (stream.mfpHandled) return false; // Already handled by MediaFlow Proxy
    return !isMp4Url(url);
}

// ─── Provider display identity ────────────────────────────────────────────
// Each provider gets a unique geometric icon — no shared emojis with other addons
const PROVIDER_DISPLAY = {
    streamingcommunity: { label: 'StreamingCommunity', icon: '◈' },
    guardaserie:        { label: 'GuardaSerie',        icon: '◆' },
    guardoserie:        { label: 'Guardoserie',        icon: '◇' },
    guardahd:           { label: 'GuardaHD',           icon: '▣' },
    guardaflix:         { label: 'Guardaflix',          icon: '◆' },
    cb01:               { label: 'CB01',               icon: '▩' },
    eurostreaming:      { label: 'EuroStreaming',      icon: '◉' },
    loonex:             { label: 'Loonex',             icon: '◎' },
    toonitalia:         { label: 'ToonItalia',         icon: '✦' },
    animeunity:         { label: 'AnimeUnity',         icon: '⛩' },
    animeworld:         { label: 'AnimeWorld',         icon: '◈' },
    animesaturn:        { label: 'AnimeSaturn',        icon: '◇' },
    kisskh:             { label: 'KissKH',             icon: '♦' },
    rama:               { label: 'Rama',               icon: '❖' },
    drammatica:         { label: 'Drammatica',         icon: '◈' },
};

// Quality tiers — visual dot meter (unique to NelloStream)
const QUALITY_TIERS = {
    '2160p': { dots: '⬤⬤⬤⬤⬤', tag: '4K' },
    '4k':    { dots: '⬤⬤⬤⬤⬤', tag: '4K' },
    '1440p': { dots: '⬤⬤⬤⬤○', tag: 'QHD' },
    '1080p': { dots: '⬤⬤⬤⬤○', tag: 'FHD' },
    'fhd':   { dots: '⬤⬤⬤⬤○', tag: 'FHD' },
    '720p':  { dots: '⬤⬤⬤○○', tag: 'HD' },
    'hd':    { dots: '⬤⬤⬤○○', tag: 'HD' },
    '576p':  { dots: '⬤⬤○○○', tag: 'SD' },
    '480p':  { dots: '⬤⬤○○○', tag: 'SD' },
    '360p':  { dots: '⬤○○○○', tag: 'SD' },
    '240p':  { dots: '⬤○○○○', tag: 'SD' },
    'sd':    { dots: '⬤⬤○○○', tag: 'SD' },
};

function _cleanLangTags(str) {
    return String(str || '')
        .replace(/\s*\[?\(?\s*SUB\s*ITA\s*\)?\]?/i, '')
        .replace(/\s*\[?\(?\s*ITA\s*\)?\]?/i, '')
        .replace(/\s*\[?\(?\s*SUB\s*\)?\]?/i, '')
        .replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').trim();
}

function formatStream(stream, providerName) {
    // ─── Quality tier ───────────────────────────────────────────────────
    const rawQ = String(stream.quality || '').toLowerCase();
    const tier = QUALITY_TIERS[rawQ] || null;

    // ─── Language detection ─────────────────────────────────────────────
    const lang  = stream.language || '';
    const sName = String(stream.name  || '').toLowerCase();
    const sTitle = String(stream.title || '').toLowerCase();
    let langFlag = '🇮🇹 ITA';
    if (lang.includes('SUB') || sName.includes('sub ita') ||
        sTitle.includes('sub ita') || sTitle.includes('sub'))
        langFlag = '🇰🇷 SUB ITA';

    // ─── Provider identity ──────────────────────────────────────────────
    const pKey = String(providerName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const pInfo = PROVIDER_DISPLAY[pKey] || {
        label: providerName
            ? providerName.charAt(0).toUpperCase() + providerName.slice(1)
            : 'Provider',
        icon: '◆',
    };

    // ─── Server / extractor (parsed from stream.name "Provider - Server") ─
    let serverName = '';
    const rawName = _cleanLangTags(stream.name);
    if (rawName.includes(' - ')) {
        serverName = rawName.split(' - ').slice(1).join(' - ').trim();
    } else if (stream.server) {
        serverName = _cleanLangTags(stream.server);
    } else if (stream.extractor) {
        serverName = _cleanLangTags(stream.extractor);
    }
    // Don't repeat the provider name as server
    if (serverName && serverName.toLowerCase() === pInfo.label.toLowerCase()) {
        serverName = '';
    }

    // ─── Build NAME (left badge in Stremio) ─────────────────────────────
    //  Line 1: Branded identity
    //  Line 2: Visual quality meter (unique dot indicator)
    const nameLines = ['NelloStream'];
    if (tier) nameLines.push(`${tier.dots} ${tier.tag}`);
    const finalName = nameLines.join('\n');

    // ─── Build TITLE (right info card, 3 lines) ────────────────────────
    //  Line 1: Content title
    //  Line 2: ◆ Provider ▸ Server
    //  Line 3: 🇮🇹 ITA │ FHD │ 1.2 GB │ ⚡ Proxy
    const titleParts = [];

    titleParts.push(stream.title || 'Stream');

    let provLine = `${pInfo.icon} ${pInfo.label}`;
    if (serverName) provLine += ` ▸ ${serverName}`;
    titleParts.push(provLine);

    const hasProxy = !!(process.env.PROXY_URL || process.env.PROXY);
    const chips = [langFlag];
    if (tier) chips.push(tier.tag);
    if (stream.size) chips.push(stream.size);
    const extras = [];
    if (stream.videoCodec) extras.push(stream.videoCodec);
    if (stream.audioCodec) extras.push(stream.audioCodec);
    if (stream.bitrate)    extras.push(stream.bitrate);
    if (stream.fps)        extras.push(`${stream.fps}fps`);
    if (extras.length) chips.push(extras.join('/'));
    chips.push(`⚡ ${hasProxy ? 'Proxy' : 'Direct'}`);
    titleParts.push(chips.join(' │ '));

    const finalTitle = titleParts.join('\n');

    // ─── Behavior hints / proxy / headers ───────────────────────────────
    const behaviorHints = cloneBehaviorHints(stream.behaviorHints || {});
    const addonBaseUrl = String(
        stream.addonBaseUrl || stream.providerContext?.addonBaseUrl || ''
    ).trim();
    let finalHeaders = stream.headers;
    let finalUrl = stream.url;

    if (behaviorHints.proxyHeaders && behaviorHints.proxyHeaders.request) {
        finalHeaders = behaviorHints.proxyHeaders.request;
    } else if (behaviorHints.headers) {
        finalHeaders = behaviorHints.headers;
    }

    if (shouldProxyForWebPlayback(stream, finalUrl, finalHeaders, addonBaseUrl)) {
        const proxiedUrl = buildProxyUrl(
            addonBaseUrl, finalUrl, finalHeaders, undefined,
            stream.proxyUrl, stream.manifestBody
        );
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
        behaviorHints.headers = finalHeaders;
    } else {
        delete behaviorHints.proxyHeaders;
        delete behaviorHints.headers;
    }

    behaviorHints.notWebReady = shouldSetNotWebReady(finalUrl, finalHeaders, behaviorHints);

    // MFP extractor URLs are fully proxied — always web-ready
    if (stream.mfpHandled) behaviorHints.notWebReady = false;

    const out = {
        name: finalName,
        title: finalTitle,
        behaviorHints,
    };

    if (stream.isExternal) out.externalUrl = finalUrl;
    else out.url = finalUrl;

    if (stream.subtitles)  out.subtitles = stream.subtitles;
    if (stream.description) out.description = stream.description;

    return out;
}

module.exports = { formatStream };
