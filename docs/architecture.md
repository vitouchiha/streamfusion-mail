# Nello Stream — Architettura

## Panoramica

Nello Stream è un addon Stremio per l'aggregazione di flussi streaming italiani (serie TV, film, anime, K-drama).  
ID addon: `org.nello.drama` | Versione corrente: **3.0.59**

---

## Stack Tecnologico

| Componente | Tecnologia | Note |
|------------|-----------|------|
| Runtime | Node.js ≥18 | Vercel usa v22.16.0 |
| Framework | Express.js | Entry point: `server.js` |
| Hosting | Vercel (fra1) | Serverless, maxDuration 60s |
| CF Worker | Cloudflare Workers | `kisskh-proxy.vitobsfm.workers.dev` |
| Browser | Puppeteer + @sparticuz/chromium | Stealth plugin per CF bypass |
| Proxy | WebShare.io (10 IP statici) | Solo `64.137.96.74` funziona per tutti i path |
| Cache | LRU in-memory + KV (CF Worker) | TTL per-provider |
| OCR | CF Worker AI (Llama 3.2 Vision) | Per captcha uprot.net |

---

## Struttura Cartelle

```
StreamFusionMail/
├── server.js                 # Entry point Express
├── cfworker.js               # Cloudflare Worker proxy (KissKH, EuroStreaming, uprot)
├── manifest.json             # Manifest Stremio addon
├── vercel.json               # Config deploy Vercel
├── wrangler.toml             # Config deploy CF Worker
├── proxies.json              # 10 IP statici WebShare
├── api/
│   └── index.js              # Vercel serverless handler
├── public/                   # Asset statici (logo, bg)
├── scripts/                  # Utility scripts (smoke test, release)
├── src/
│   ├── index.js              # Router principale provider
│   ├── providers/            # Provider aggregation layer
│   │   ├── index.js          # Orchestratore multi-provider
│   │   └── kisskh.js         # Provider KissKH (K-drama)
│   ├── cb01/                 # Provider CB01
│   ├── eurostreaming/        # Provider EuroStreaming
│   ├── guardaserie/          # Provider GuardaSerie
│   ├── guardaflix/           # Provider GuardaFlix
│   ├── guardahd/             # Provider GuardaHD
│   ├── guardoserie/          # Provider GuardoSerie
│   ├── loonex/               # Provider Loonex (cartoni)
│   ├── streamingcommunity/   # Provider StreamingCommunity
│   ├── toonitalia/           # Provider ToonItalia
│   ├── animesaturn/          # Provider AnimeSaturn
│   ├── animeunity/           # Provider AnimeUnity
│   ├── animeworld/           # Provider AnimeWorld
│   ├── extractors/           # Estrattori video
│   │   ├── maxstream.js      # MaxStream + browser fallback
│   │   ├── uprot.js          # Uprot captcha solver
│   │   ├── mixdrop.js        # MixDrop unpacker
│   │   ├── supervideo.js     # SuperVideo HLS
│   │   ├── turbovidda.js     # Turbovid/DeltaBit
│   │   └── common.js         # Utility condivise
│   ├── mapping/              # Anime ID mapping (Fribb offline index)
│   ├── metadata/             # TMDB metadata client
│   ├── cache/                # Cache layer
│   ├── scrapers/             # Web scraping utilities
│   ├── stream_engine/        # Stream processing engine
│   ├── formatter/            # Response formatters
│   ├── config/               # Provider URL config
│   └── utils/                # Utility modules
│       ├── browser.js        # Puppeteer launcher
│       ├── cache.js          # LRU cache
│       ├── cloudflare.js     # CF bypass utilities
│       ├── config.js         # User config decode/encrypt
│       ├── fetcher.js        # HTTP fetch + proxy agent
│       ├── hlsProxy.js       # HLS proxy rewriter
│       ├── logger.js         # Structured logger
│       ├── ocr.js            # Captcha OCR (PNG encode + preprocess)
│       ├── proxy.js          # Smart proxy rotation
│       └── flaresolverr.js   # FlareSolverr client
└── docs/                     # Documentazione
```

---

## Flusso Richiesta Stremio

```
Stremio → GET /stream/series/tt12345:1:1.json
  → server.js: decode config, route to provider
    → src/index.js: parallel provider calls (timeout per-provider)
      → Provider (es. CB01): search → parse → extract
        → Extractor (es. uprot.js): captcha solve → redirect chain → HLS URL
    → Dedup + format → JSON response → Stremio
```

---

## Provider Status (v3.0.59)

| Provider | Stato | Extractor | Note |
|----------|-------|-----------|------|
| StreamingCommunity | ✅ | VixCloud (HTTP) | Più veloce, ~14s timeout |
| EuroStreaming | ✅ | DeltaBit, MixDrop via CF Worker | 3-layer cache (batch+KV+memory) |
| CB01 | ✅ | MixDrop, MaxStream/Uprot | Uprot auto-solve v3.0.55+ |
| GuardaSerie | ✅ | SuperVideo → HLS | ~20s, cascade token refresh |
| GuardaFlix | ⚠️ | Nonce hardcoded | Year matching stretto |
| GuardoSerie | ⚠️ | CF Worker KV only | CF Bot Fight blocca cloud IP |
| GuardaHD | ⚠️ | MixDrop | Richiede proxy |
| Loonex | ✅ | MixDrop | Cartoni, 8s timeout |
| ToonItalia | ✅ | MediaFlow Proxy | 8s timeout |
| AnimeSaturn | ✅ | Direct | Mapping Fribb v3.0.48+ |
| AnimeUnity | ✅ | Direct | CF Worker fallback per search |
| AnimeWorld | ✅ | Direct | Mapping internalizzato |
| KissKH | ⚠️ | API diretta via CF Worker | API key statica, fragile |

---

## Servizi Esterni

| Servizio | Uso | Config |
|----------|-----|--------|
| Vercel | Hosting serverless | `vercel.json`, env vars |
| CF Worker | Proxy KissKH, EuroStreaming, uprot KV | `cfworker.js`, `wrangler.toml` |
| WebShare.io | Proxy residenziali (10 IP statici) | `PROXY_URL`, `WEBSHARE_PROXIES` |
| TMDB API | Metadata film/serie | `TMDB_API_KEY` (2 chiavi) |
| Browserless.io | Chrome remoto per CF bypass | `BROWSERLESS_URL` |
| MediaFlow Proxy | Proxy HLS per ToonItalia | `MFP_URL`, `MFP_API_PASSWORD` |
| Fribb anime-lists | Mapping anime offline (41k entries) | GitHub raw JSON |
| FlareSolverr | CF bypass alternativo | `FLARESOLVERR_URL` |
