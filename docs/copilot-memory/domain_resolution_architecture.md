# Provider Domain/URL Resolution Architecture - Comprehensive Exploration

## Overview
Multiple domain resolution strategies across three main projects (StreamFusionMail, tmp_easystreams, tmp_streamvix, tmp_mammamia).

## 1. StreamFusionMail Architecture

### Core Component: provider_urls.js
**Path:** `StreamFusionMail/src/provider_urls.js`

**Strategy:** Hybrid local + remote resolution with fallback chain
- **Local:** Loads from `provider_urls.json` (embedded in bundles, watched for file changes via `fs.statSync`)
- **Remote:** Fetches from GitHub raw URL `https://raw.githubusercontent.com/realbestia1/easystreams/refs/heads/main/provider_urls.json`
- **Reload Strategy:**
  - Local check every 1.5 seconds (RELOAD_INTERVAL_MS)
  - Remote check every 10 seconds (REMOTE_RELOAD_INTERVAL_MS)
  - Remote fetch timeout: 5 seconds
  - Uses AbortSignal.timeout() for safe cancellation

**Aliases:** Supports multiple key variants:
- animeunity: ["animeunuty", "anime_unity"]
- animeworld: ["anime_world"]
- animesaturn: ["anime_saturn"]
- streamingcommunity: ["streaming_community"]
- guardahd: ["guarda_hd"]
- guardaserie: ["guarda_serie"]
- guardoserie: ["guardo_serie"]
- mapping_api: ["mappingapi", "mapping_api_url", "mapping_url"]

**Default provider_urls.json:**
```json
{
  "animeunity": "https://www.animeunity.so",
  "animeworld": "https://www.animeworld.ac",
  "animesaturn": "https://www.animesaturn.cx",
  "streamingcommunity": "https://vixsrc.to",
  "guardahd": "https://mostraguarda.stream",
  "guardaserie": "https://guardaserietv.skin",
  "guardoserie": "https://guardoserie.best",
  "toonitalia": "https://toonitalia.xyz",
  "loonex": "https://loonex.eu",
  "mapping_api": "https://animemapping.stremio.dpdns.org",
  "eurostreaming": "https://eurostream.ing",
  "cb01": "https://cb01uno.digital",
  "guardaflix": "https://guardaplay.space"
}
```

### How Each Scraper Gets Base URL

All scrapers use consistent pattern: `getProviderUrl('provider_key')`

| Scraper | Function | Module Import | Current Domain |
|---------|----------|----------------|-----------------|
| AnimeUnity | `getUnityBaseUrl()` | `require("../provider_urls.js")` | https://www.animeunity.so |
| AnimeWorld | `getWorldBaseUrl()` | `require("../provider_urls.js")` | https://www.animeworld.ac |
| AnimeSaturn | `getSaturnBaseUrl()` | `require("../provider_urls.js")` | https://www.animesaturn.cx |
| StreamingCommunity | `getStreamingCommunityBaseUrl()` | `require("../provider_urls.js")` | https://vixsrc.to |
| Guardaserie | `getGuardaserieBaseUrl()` | `require("../provider_urls.js")` | https://guardaserietv.skin |
| Guardoserie | `getGuardoserieBaseUrl()` | `require("../provider_urls.js")` | https://guardoserie.best |
| GuardaHD | `getGuardaHdBaseUrl()` | `require("../provider_urls.js")` | https://mostraguarda.stream |
| Eurostreaming | `getEsBaseUrl()` | `require("../provider_urls.js")` with fallback | https://eurostream.ing |
| CB01 | `getCb01BaseUrl()` | `require("../provider_urls.js")` with fallback | https://cb01uno.digital |
| Toonitalia | `getBaseUrl()` | `require("../provider_urls.js")` | https://toonitalia.xyz |

**Fallback patterns:**
```javascript
// Example: Eurostreaming
function getEsBaseUrl() {
  return (getProviderUrl('eurostreaming') || 'https://eurostreamings.life').replace(/\/+$/, '');
}

// Example: CB01
function getCb01BaseUrl() {
  return (getProviderUrl('cb01') || 'https://cb01uno.uno').replace(/\/+$/, '');
}
```

### Cloudflare Worker (cfworker.js)

**Path:** `StreamFusionMail/cfworker.js`

**Purpose:** Proxy requests to Cloudflare-protected sites + cache + bypass captchas

**No domain auto-update mechanism** - but has:
1. **KV Cache for responses** (12h for eurostreaming/guardoserie)
   - Keys: `p:${url}` for page caching
   - TTLs: guardoserie/eurostreaming (86400s), deltabit (3600s)
   
2. **Scheduled cron for Eurostreaming resource warming:**
   - Function: `async scheduled(event, env, ctx)`
   - Caches all WordPress posts periodically
   - Uses Cache API for state tracking (24h cooldown)
   - Stores batches in KV: `es:page:${pageNum}`

3. **Hardcoded ALLOWED_HOSTS whitelist** (no auto-discovery):
```javascript
const ALLOWED_HOSTS = new Set([
  'kisskh.do', 'www.kisskh.do', 'kisskh.co', 'www.kisskh.co',
  'eurostream.ing', 'www.eurostream.ing',
  'eurostreamings.life', 'www.eurostreamings.life',
  'clicka.cc', 'www.clicka.cc',
  'safego.cc', 'www.safego.cc',
  'deltabit.co', 'www.deltabit.co',
  'turbovid.me', 'www.turbovid.me',
  'uprot.net', 'www.uprot.net',
  'maxstream.video', 'www.maxstream.video',
  'guardoserie.digital', 'www.guardoserie.digital',
  'guardoserie.best', 'www.guardoserie.best',
  'animeunity.so', 'www.animeunity.so',
]);
```

---

## 2. tmp_easystreams Project

**Location:** `tmp_easystreams/providers/`
**Files:** animesaturn.js, animeunity.js, animeworld.js, cb01.js, guardahd.js, guardaserie.js, guardoserie.js, streamingcommunity.js, index.js

**Strategy:** Embedded static provider_urls.json (built-in defaults)

**Structure:** Built/compiled JavaScript (bundled from source). Contains embedded provider_urls.json:
```json
{
  "animeunity": "https://www.animeunity.so",
  "animeworld": "https://www.animeworld.ac",
  "animesaturn": "https://www.animesaturn.cx",
  "streamingcommunity": "https://vixsrc.to",
  "guardahd": "https://guardahd.stream",
  "guardaserie": "https://guardaserietv.autos",
  "guardoserie": "https://guardoserie.space",
  "mapping_api": "https://animemapping.stremio.dpdns.org"
}
```

**Key difference:** No remote fetching, only embedded defaults (used in browser context where fs API not available).

---

## 3. tmp_streamvix Project

**Location:** `tmp_streamvix/src/providers/*.ts` + `tmp_streamvix/config/domains.json`

**Strategy:** Configuration file-based domain resolution with reload mechanism

**Core Implementation:**
- **File:** `src/utils/domains.ts`
- **Cache:** In-memory with 12-hour TTL
- **Location:** `config/domains.json`

**domains.json Content:**
```json
{
  "animesaturn": "animesaturn.cx",
  "vixsrc": "vixsrc.to",
  "animeunity": "animeunity.so",
  "animeworld": "animeworld.ac",
  "vavoo": "vavoo.to",
  "guardaserie": "guardaserietv.autos",
  "guardahd": "mostraguarda.stream",
  "eurostreaming": "eurostreamings.life",
  "guardaflix": "guardaplay.space",
  "guardoserie": "guardoserie.surf"
}
```

**API:**
```typescript
export function getDomain(key: string): string | undefined;
export function getFullUrl(key: string, protocol: 'https'|'http' = 'https'): string | undefined;
export function forceReloadDomains(): void;  // Reload from file
```

**Usage Example (Guardoserie.ts):**
```typescript
const getTargetDomain = () => `https://${getDomain('guardoserie') || 'guardoserie.bar'}`;
```

**Characteristics:**
- Hosts stored WITHOUT protocol (allows flexible `https://` or `http://`)
- Graceful fallback to hardcoded defaults
- Manual reload function available for runtime updates

---

## 4. tmp_mammamia Project

**Location:** `tmp_mammamia/` (Python-based)

**Strategy:** Remote URL validation + config merge with redirect following

**Update Mechanism: update_domains.py**

**How it works:**
1. Downloads `provider_urls.json` from GitHub remote:
   ```
   https://raw.githubusercontent.com/UrloMythus/MammaMia/main/config.json
   ```
   
2. For each site, follows HTTP redirects to find final URL:
   ```python
   def follow_redirect(url: str) -> str | None:
       r = requests.get(url, allow_redirects=True, headers=HEADERS,
                        timeout=REQUEST_TIMEOUT, verify=False)
       return normalize_url(r.url)  # Extract domain only
   ```

3. Parses local `config.json` as text (line-by-line)
4. Finds "url" lines within provider sections
5. **Preserves entire JSON structure** - only replaces quoted URL values
6. Creates timestamped backup before overwriting

**config.py pattern (Python API usage):**
```python
SITE = config["Siti"]  # "Siti" = Italian for "Sites"
SC_DOMAIN = SITE["StreamingCommunity"]['url']
AW_DOMAIN = SITE['AnimeWorld']['url']
CB_DOMAIN = SITE['CB01']['url']
GS_DOMAIN = SITE['Guardaserie']['url']
# ... etc for each provider
```

---

## 5. Domain Resolution Comparison Matrix

| Project | Storage | Update Mechanism | Remote Source | Fallback | Auto-Reload | Cache TTL |
|---------|---------|------------------|---------------|----------|-------------|-----------|
| **StreamFusionMail** | provider_urls.json | Hybrid (local + remote fetch) | GitHub (realbestia1/easystreams) | ✅ (hardcoded) | ✅ (1.5s/10s) | 10s remote |
| **tmp_easystreams** | Embedded JSON | Static (bundled) | None | ✅ (embedded) | ❌ | N/A |
| **tmp_streamvix** | config/domains.json | File-based | None | ✅ (hardcoded) | ✅ (manual) | 12h |
| **tmp_mammamia** | config.json | Python script (manual) | GitHub (UrloMythus/MammaMia) | ❌ | ❌ | N/A |

---

## 6. Domain Update/Resolution Strategies Summary

### Strategy 1: Remote GitHub Fetch (StreamFusionMail)
- ✅ Pro: Most current, distributed updates
- ✅ Pro: Automatic fallback to local
- ❌ Con: Requires network access
- **Best for:** Production deployments on Vercel/cloud

### Strategy 2: Config File (tmp_streamvix)
- ✅ Pro: Simple local management
- ✅ Pro: Predictable, no network delays
- ❌ Con: Manual updates required
- **Best for:** Self-hosted/containerized deployments

### Strategy 3: Python Script (tmp_mammamia)
- ✅ Pro: Follows redirects automatically
- ✅ Pro: Text-safe JSON manipulation (preserves formatting)
- ❌ Con: Manual execution required
- **Best for:** Scheduled jobs/CI/DevOps workflows

### Strategy 4: Embedded Static (tmp_easystreams)
- ✅ Pro: No dependencies, works offline
- ✅ Pro: Fastest (no resolution overhead)
- ❌ Con: Hardcoded, requires rebuild to update
- **Best for:** Browser/Stremio addons

---

## Key Findings

1. **No domain exists in loonex directory** - only referenced in config but not implemented as provider
2. **Loonex referenced in provider_urls.json** with URL `https://loonex.eu`
3. **Eurostreaming KV warming** in cfworker is about caching *content*, not updating domains
4. **All StreamFusionMail scrapers** use unified getProviderUrl() - any config change applies globally
5. **Mapping API** also follows same pattern (reserved key in provider_urls.json)
