# CB01 & StreamVix Research Findings

## 1. CB01 Module (StreamFusionMail/src/cb01/index.js)

### Main Extraction Flow
- **Search Phase**: Searches CB01 website for movies/series by title + year
- **Stream Resolution**: Uses stayonline.pro as URL indirection service
- **Extractors Used** (priority order):
  1. MixDrop (extractMixDrop)
  2. MaxStream (extractMaxStream) 
  3. Uprot (extractUprot - requires webshare proxy, often fails with captcha)

### CB01 Stream Output Format
CB01 returns simple stream objects:
```javascript
{
  name: 'CB01',
  title: `🎬 CB01\n▶️ ${label} [Extractor]`,
  // Examples: 
  // - `🎬 CB01\n▶️ Link1 [MixDrop]`
  // - `🎬 CB01\n▶️ Link2 [MaxStream]`
  // - `🎬 CB01\n▶️ HD [MaxStream via Uprot]`
  url: streamUrl,
  behaviorHints?: { notWebReady: true, proxyHeaders: { request: headers } }
}
```

## 2. StreamFusionMail Extractors

**All Extractors** (StreamFusionMail/src/extractors/):
- common.js - shared utilities, USER_AGENT, extractPackedValue(), normalizeExtractorUrl()
- mixdrop.js - extracts MDCore.wurl value from iframe
- maxstream.js - looks for sources[{src: "..."}] pattern
- uprot.js - uses webshare proxy to bypass captcha, returns MaxStream URL
- turbovidda.js, supervideo.js, vixcloud.js, etc.
- dropload.js, loadm.js, streamtape.js, upstream.js, uqload.js, vidoza.js, voe.js

## 3. Webshare Proxy Integration

**Location**: StreamFusionMail/src/extractors/uprot.js

**Function**: getWebshareProxy()
```javascript
function getWebshareProxy() {
  const raw = (process.env.WEBSHARE_PROXIES || '').trim();
  if (!raw) return null;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)]; // random selection
}
```

**Configuration Files**:
- .env.production: `PROXY_URL="http://sdfmtjis-rotate:y7hpwm1hw1km@p.webshare.io:80"`
- .env.vercel.prod: Same proxy URL format
- .env.example: References WebShare.io as option

**Purpose**: Spanish IP proxy for uprot.net bypass (to avoid captcha - often still fails)

## 4. Mixdrop Extraction

**File**: StreamFusionMail/src/extractors/mixdrop.js

**Logic**:
1. Can be disabled via DISABLE_MIXDROP env var or global flag
2. Looks for packed value in HTML: MDCore.wurl, wurl patterns
3. Extracts packed JavaScript value and decodes it
4. Returns video URL with referer headers

## 5. StreamVix Stream Formatter (Comparison)

**File**: tmp_streamvix/src/utils/unifiedNames.ts

**buildUnifiedStreamName Function** creates multi-line stream names:

```
🎬 <baseTitle>
🗣 <langFlag/[ITA]>
💾 <size>              (optional)
▶️ <playerName>         (optional)
🌐 Proxy (ON/OFF)
🤌 <ProviderLabel>
```

**Provider Labels**:
```javascript
Switch cases for:
- vixsrc: "🤌 StreamingCommunity 🍿${isFhd ? ' 🅵🅷🅳' : ''}"
- animeunity: "🤌 Anime Unity ⛩️${isFhd ? ' 🅵🅷🅳' : ''}"
- cb01: "🤌 CB01 🎞️"
- guardaserie, guardahd, eurostreaming, etc.
```

**Input Parameters**:
- baseTitle: string (includes season/episode if series)
- isSub: boolean (true=[SUB], false=[ITA])
- sizeBytes?: number (file size in bytes)
- playerName?: string (extractor/host name)
- proxyOn: boolean (proxy enabled status)
- provider: string (provider key like 'cb01', 'vixsrc')
- isFhdOrDual?: boolean (FHD marker)
- langFlag?: string (override language display)

## 6. Extractors in tmp_streamvix

**Available Extractors** (tmp_streamvix/src/extractors/):
- base.ts - base extractor class
- mixdrop.ts - matches file, searches for player patterns
- supervideo.ts, streamtape.ts, vixcloud.ts
- dlhd.ts, doodstream.ts, dropload.ts
- mediahosting.ts, gdplayerRuntime.ts, sponTeamMatch.ts, etc.

## Key Differences: CB01 vs StreamVix Format

| Aspect | CB01 | StreamVix |
|--------|------|----------|
| **Name Line** | Single line: `🎬 CB01\n▶️ Label [Extractor]` | Multi-line with multiple emojis |
| **Provider Badge** | Not included | Shows provider label with emojis |
| **Size** | Not included | Optional size in MB/GB |
| **Quality Badge** | Not included | FHD marker when applicable |
| **Proxy Status** | Not displayed | Explicit "🌐 Proxy (ON/OFF)" line |
| **Language** | Not displayed | Language flag (🇮🇹, 🇬🇧, etc.) |

## Notes

- CB01 uses stayonline.pro as intermediate URL resolver
- Webshare proxy only configured for uprot.net bypass attempts
- MixDrop is most reliable for CB01
- uprot.net frequently requires captcha despite proxy attempts
