# StreamFusion Mail

![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvitouchiha%2Fstreamfusion-mail)
[![Vercel Status](https://img.shields.io/badge/vercel-deployed-brightgreen?style=flat-square&logo=vercel)](https://streamfusion-mail.vercel.app)

> Aggregatore flussi streaming multi-provider per [Stremio](https://www.stremio.com/)  
> Korean Drama & Asian Drama da **Rama Oriental Fansub** e **KissKH**
>
> 🔗 **Live:** https://streamfusion-mail.vercel.app  
> 📦 **GitHub:** https://github.com/vitouchiha/streamfusion-mail  
> 📡 **Manifest:** https://streamfusion-mail.vercel.app/manifest.json

---

## Descrizione tecnica

**StreamFusion Mail** è un addon Stremio scritto in **Node.js 18+ (CommonJS)** che aggrega
stream video da due sorgenti:

| Provider | Sito | Tipo contenuto | Tecnica estrazione |
|----------|------|----------------|--------------------|
| **Rama** | `ramaorientalfansub.live` | Korean Drama (sub ITA) | cloudscraper + cheerio |
| **KissKH** | `kisskh.co` | Asian Drama (sub ITA) | Axios API + Puppeteer stealth |

---

## Architettura

```
StreamFusion Mail
├── server.js                  ← Entry point (Express + Stremio SDK)
├── manifest.json              ← Stremio manifest (catalogs, types, resources)
├── src/
│   ├── providers/
│   │   ├── index.js           ← Aggregatore: routing, fallback, deduplication
│   │   ├── rama.js            ← Provider Rama Oriental Fansub
│   │   └── kisskh.js          ← Provider KissKH
│   └── utils/
│       ├── logger.js          ← Logger strutturato (JSON prod / human dev)
│       ├── cache.js           ← TTL cache LRU in-memory
│       ├── fetcher.js         ← HTTP: cloudscraper + axios + timeout wrapper
│       ├── cloudflare.js      ← CF bypass via Puppeteer (cf_clearance)
│       ├── subDecrypter.js    ← Decrittazione sottotitoli KissKH (AES-128-CBC)
│       └── titleHelper.js     ← Similarity, slug, ID normalization
```

---

## Diagramma flusso logico

```
Stremio Client
      │
      ▼
  GET /manifest.json
  GET /catalog/:type/:id.json?extra=…
  GET /meta/:type/:id.json
  GET /stream/:type/:id.json
      │
      ▼
  server.js (Express)
      │
      ├─ type=kdrama / id=rama_*  ──► rama.js
      │                                 └─ fetchWithCloudscraper
      │                                 └─ cheerio scraping
      │                                 └─ iframe / video / regex extraction
      │
      └─ type=series / id=kisskh_* ──► kisskh.js
                                        └─ axios → kisskh.co API
                                        └─ Puppeteer (intercept .m3u8)
                                        └─ subtitle decrypt (AES-128-CBC)
```

---

## Endpoint disponibili

| Metodo | Path | Descrizione |
|--------|------|-------------|
| `GET` | `/` | Landing page HTML con pulsante install |
| `GET` | `/manifest.json` | Manifest Stremio |
| `GET` | `/health` | Health check JSON |
| `GET` | `/catalog/:type/:id.json` | Lista serie (con `?search=` e `?skip=`) |
| `GET` | `/meta/:type/:id.json` | Dettaglio serie + episodi |
| `GET` | `/stream/:type/:id.json` | Stream per episodio |

---

## Esempio risposta JSON stream

```json
{
  "streams": [
    {
      "name": "KissKH",
      "title": "Episode 3",
      "url": "https://cdn.kisskh.co/stream/abc123.m3u8?v=XYZ",
      "subtitles": [
        { "lang": "it", "content": "1\r\n00:00:01,000 --> 00:00:04,000\r\nCiao mondo!\r\n" }
      ],
      "behaviorHints": {
        "notWebReady": false,
        "bingeGroup": "streamfusion-kisskh-kisskh_1234"
      }
    }
  ]
}
```

---

## Sviluppo locale

### Prerequisiti

- Node.js ≥ 18
- npm ≥ 9
- Google Chrome / Chromium (per Puppeteer — scaricato automaticamente da npm)

### Setup

```bash
# 1. Clona il repo
git clone https://github.com/YOUR_USERNAME/streamfusion-mail.git
cd streamfusion-mail

# 2. Installa dipendenze
npm install

# 3. Copia e configura variabili ambiente
cp .env.example .env
# Modifica .env secondo necessità

# 4. Avvia il server
npm start
# oppure in watch mode
npm run dev
```

Il server sarà disponibile su `http://localhost:3000`  
Installa su Stremio: `stremio://localhost:3000/manifest.json`

---

## Deploy su Vercel

### Prerequisiti

- Account [Vercel](https://vercel.com)
- [Vercel CLI](https://vercel.com/cli): `npm i -g vercel`

### Steps

```bash
# Login
vercel login

# Deploy (prima volta)
vercel

# Deploy in produzione
vercel --prod
```

> **ℹ️ Puppeteer su Vercel** — Risolto tramite `@sparticuz/chromium` + `puppeteer-core`.
> Il pacchetto include un Chromium leggero (~45MB) ottimizzato per Lambda/serverless.
> Richiede **Vercel Pro** per il `maxDuration: 60` configurato in `vercel.json`.
> Sul piano **Hobby** il timeout è 10s — sufficiente per catalog/meta ma non per stream con Puppeteer.
> In quel caso usa **Railway** o **Render** (vedi sotto).

**Variabili d'ambiente da impostare su Vercel:**

```bash
vercel env add NODE_ENV      # → production
vercel env add LOG_LEVEL     # → info
vercel env add STREAM_TIMEOUT # → 55000
```

---

## Variabili d'ambiente

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `PORT` | `3000` | Porta del server HTTP |
| `NODE_ENV` | `development` | Ambiente (`production` abilita JSON logging) |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `CATALOG_TIMEOUT` | `20000` | Timeout catalog handler (ms) |
| `META_TIMEOUT` | `30000` | Timeout meta handler (ms) |
| `STREAM_TIMEOUT` | `45000` | Timeout stream handler (ms) |
| `CF_COOKIE_MAX_AGE` | `3600000` | Validità cache cookie Cloudflare (ms) |
| `CF_MAX_RETRY` | `3` | Tentativi massimi bypass CF |
| `CF_RETRY_DELAY` | `5000` | Delay base retry bypass CF (ms) |
| `PUPPETEER_EXECUTABLE_PATH` | _(auto)_ | Path Chromium custom. In produzione Vercel è gestito da `@sparticuz/chromium` |

---

## Licenza

MIT — vedi [LICENSE](LICENSE)

---

> ℹ️ Questo addon funziona come un browser che accede a contenuti pubblicamente disponibili su internet.  
> Non ospita né distribuisce alcun contenuto multimediale.
