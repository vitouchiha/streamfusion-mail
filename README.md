# 🐶 Nello Stream (StreamFusion Mail)

<!-- release:meta:start -->
- Release: `v3.0.58`
- Date: `2026-03-14`
- Remote smoke target: `https://streamfusion-mail.vercel.app`
<!-- release:meta:end -->

> Il motore di aggregazione definitivo ispirato a Nello 🐶 per lo streaming italiano su Stremio.  
> Film, Serie TV, Anime, K-Drama — tutto da un unico addon, con captcha auto-risolti e zero configurazione manuale.

---

## ✨ Perché Nello Stream?

Nello Stream nasce dall'unione del meglio di **MammaMia**, **EasyStreams** e **StreamViX**, superandoli tutti in automazione, copertura siti e funzionalità.

### 🏆 Tabella Comparativa

| Funzionalità | 🐶 Nello Stream | 🍕 MammaMia | 📺 EasyStreams | 🎬 StreamViX |
|:---|:---:|:---:|:---:|:---:|
| **Siti Italiani** | 12 provider | 10 provider | 7 provider | 6 provider |
| **Extractor Video** | 14 | 12 | 7 | ~5 |
| **Film** | ✅ | ✅ | ✅ | ✅ |
| **Serie TV** | ✅ | ✅ | ✅ | ✅ |
| **Anime (ITA)** | ✅ 3 siti | ✅ 1 sito | ✅ 3 siti | ✅ 2 siti |
| **K-Drama / Drama Asiatici** | ✅ KissKH + Rama | ❌ | ❌ | ❌ |
| **Live TV / Sport** | ❌ | ❌ | ❌ | ✅ |
| **Captcha Uprot (MaxStream)** | 🤖 Auto (OCR + AI) | 🖐️ Manuale | ❌ Non supportato | ❌ Non supportato |
| **Captcha SafeGo** | 🤖 Auto (CF Worker) | ❌ | ❌ | ❌ |
| **Bypass Cloudflare** | 🔄 4 livelli | 🔄 Basic proxy | 🔄 CF Worker | 🔄 CF Worker |
| **Mapping Anime interno** | ✅ 7 sistemi ID | ❌ Nessuno | ❌ Nessuno | ❌ Esterno |
| **Domini auto-aggiornati** | ✅ Cron CF Worker | ❌ Manuale | ❌ Manuale | ❌ Manuale |
| **Proxy HLS integrato** | ✅ HMAC firmato | ❌ | ❌ | ✅ via MFP |
| **Config criptata** | 🔒 AES-256-GCM | ❌ Plaintext | ❌ N/A | ❌ Plaintext |
| **Sottotitoli criptati** | ✅ AES-128-CBC | ❌ | ❌ | ❌ |
| **TMDB Metadata (IT)** | ✅ Poster RPDB | ✅ Basic | ❌ | ✅ Basic |
| **Deploy Serverless** | ✅ Vercel native | ⚠️ HuggingFace | ❌ Solo locale/Docker | ⚠️ ElfHosted |
| **Linguaggio** | Node.js | Python | Node.js | Node.js + TS + Python |
| **MediaFlow Proxy** | ✅ Opzionale | ❌ | ❌ | ✅ Richiesto |

---

## 🌐 Provider Supportati (12)

### 🇮🇹 Siti Italiani

| Provider | Contenuti | Extractor | Note |
|:---------|:----------|:----------|:-----|
| 🎬 **StreamingCommunity** | Film, Serie | VixCloud | MediaFlow Proxy + HLS proxy integrato |
| 🎬 **GuardaHD** | Film, Serie | MixDrop, SuperVideo, DropLoad | Qualità auto-detect da HLS |
| 🎬 **GuardaFlix** | Film | MixDrop, SuperVideo | WordPress AJAX con nonce |
| 📺 **GuardaSerie** | Serie | SuperVideo, MixDrop, DropLoad | Browser fallback per CF |
| 📺 **GuardoSerie** | Film, Serie | MixDrop, SuperVideo | KV cache su CF Worker |
| 📺 **Eurostreaming** | Serie (ITA/SUB) | MixDrop, Turbovidda, MaxStream | CF Worker bypass chain |
| 🎬 **CB01** | Film, Serie (ITA) | MixDrop, MaxStream/Uprot | Captcha auto + stayonline resolver |
| 🎨 **ToonItalia** | Cartoni/Anime (ITA) | MixDrop, DropLoad | Alias titoli configurabili |
| 🎨 **Loonex** | Cartoni (ITA) | MixDrop | Sistema mapping titoli |

### ⛩️ Anime Italiani

| Provider | Extractor | Mapping ID |
|:---------|:----------|:-----------|
| **AnimeUnity** | VixCloud | AniList, Kitsu, Fribb |
| **AnimeWorld** | Link diretti | Kitsu, Fribb |
| **AnimeSaturn** | Link diretti | Kitsu, Fribb |

### 🇰🇷 Drama Asiatici (esclusiva Nello Stream)

| Provider | Contenuti | Note |
|:---------|:----------|:-----|
| **KissKH** | K-Drama, C-Drama, J-Drama, Thai | Catalogo nativo, sub criptati AES, multi-mirror |
| **Rama** | K-Drama (sub ITA) | Catalogo nativo, metadata TMDB |

---

## 🤖 Captcha Auto-Solver (esclusiva)

A differenza di MammaMia (che richiede all'utente di risolvere manualmente il captcha uprot), Nello Stream risolve **automaticamente** tutti i captcha:

| Tipo | Sito | Metodo |
|:-----|:-----|:-------|
| **Uprot 3 cifre** (`/msf/`, `/msfi/`) | CB01, Eurostreaming | OCR pixel locale → AI per-digit fallback |
| **Uprot 4 cifre** (`/msei/`) | CB01 (stayonline) | Token-based, OCR per-URL |
| **SafeGo** | Eurostreaming | CF Worker auto-solve |

**Pipeline OCR a 3 livelli:**
1. 🔢 Template matching locale (istantaneo)
2. 🧠 Segmentazione per-digit + AI CF Worker (fallback)
3. 🖼️ Immagine preprocessata + AI (ultimo fallback)

---

## 🔧 14 Video Extractor

| Extractor | Host | Output |
|:----------|:-----|:-------|
| MixDrop | `mixdrop.to`, `m1xdrop.net` | MP4 |
| MaxStream | `maxstream.video` | HLS |
| Uprot → MaxStream | `uprot.net` | HLS (via captcha auto) |
| VixCloud | `vixcloud.co` | HLS |
| SuperVideo | `supervideo.cc` | HLS/MP4 |
| Turbovidda | `turbovid.eu` | HLS/MP4 |
| DropLoad | `dropload.io` | MP4 |
| StreamTape | `streamtape.com` | MP4 |
| Uqload | `uqload.to` | MP4 |
| Upstream | `upstream.to` | MP4 |
| Vidoza | `vidoza.net` | MP4 |
| Loadm | `loadm.to` | MP4 |
| VOE | `voe.sx` | HLS/MP4 |
| KissKH nativo | `kisskh.do` | HLS (AES encrypted) |

---

## 🗺️ Motore Mapping Anime Interno

Nello Stream include un **motore di mapping completo** che sostituisce le API esterne:

- 📊 **7 sistemi ID:** Kitsu, TMDB, IMDb, MAL, AniList, TVDB, AniDB
- 📦 **Database offline:** Fribb/anime-lists + Kometa-Team/Anime-IDs (~7MB)
- 🔄 **Auto-aggiornamento** con ETag (scarica solo quando cambia)
- 🎯 **Risoluzione per stagione:** TVDB season → corretto Kitsu/AniList ID

---

## 🛡️ Infrastruttura Proxy & Bypass

### Pipeline Cloudflare (4 livelli)
```
CF Worker → Cloudscraper → FlareSolverr → Puppeteer (Browserless)
```

### Proxy HLS Integrato
- 🔑 Token HMAC-SHA256 firmati con scadenza
- 📝 Riscrittura playlist (segmenti proxied)
- 🔄 Supporto proxy per-stream (CDN IP-locked)

### CF Worker Multifunzione
- 🌐 Proxy generico con allowlist domini
- ⏰ Cron job: aggiornamento domini, warm-up cache, pre-solve captcha
- 🔍 OCR AI per risoluzione captcha
- 💾 KV caching: Eurostreaming (48h), GuardoSerie (12h), domini, cookies

### Domini Auto-Aggiornati
- Risoluzione automatica via **cron CF Worker**
- 3 livelli merge: GitHub → CF Worker → locale
- Probe candidati con redirect chain
- Zero intervento manuale quando un sito cambia dominio

---

## 🔒 Sicurezza

- **Config criptata AES-256-GCM** — credenziali mai esposte in URL/log
- **Token HLS firmati HMAC-SHA256** con scadenza automatica
- **CF Worker con allowlist** — solo 18 domini autorizzati
- **Nessuna dipendenza esterna per OCR** — engine puro JS + AI on-edge

---

## 💾 Sistema Cache Multi-Livello

| Livello | Tipo | TTL |
|:--------|:-----|:----|
| In-memory LRU | Per provider | 15min–24h |
| Cache Layer | LRU 1500 entry | TMDB 24h, Catalog 1h, Stream 15m |
| CF Worker KV | Edge Cloudflare | Eurostreaming 48h, GuardoSerie 12h |
| File locale | Anime list | 24h con ETag |
| Cookie cache | Uprot per path-type | 22h |

---

## 🚀 Deploy

### Vercel (consigliato)

1. Importa il repository su Vercel
2. Imposta le variabili d'ambiente necessarie
3. Pubblica → apri `https://<tuo-deploy>.vercel.app/configure`

```text
https://<tuo-deploy>.vercel.app/install/v3.0.58/manifest.json
```

### Variabili d'Ambiente

| Variabile | Descrizione | Obbligatoria |
|:----------|:------------|:---:|
| `CF_WORKER_URL` | URL Cloudflare Worker | ✅ |
| `CF_WORKER_AUTH` | Chiave auth CF Worker | ✅ |
| `TMDB_API_KEY` | Chiave TMDB per metadata | ⚡ Consigliata |
| `PROXY_URL` | Proxy HTTP/SOCKS | ❌ |
| `FLARESOLVERR_URL` | Endpoint FlareSolverr | ❌ |
| `BROWSERLESS_URL` | Browserless.io WSS | ❌ |
| `MFP_URL` | MediaFlow Proxy URL | ❌ |

---

## 📋 Workflow Rilascio

```bash
# Applica modifiche → release automatico
npm run release

# Solo test remoto
npm run test:vercel
```

`npm run release` aggiorna README, dashboard, CHANGELOG ed esegue smoke test sul deploy Vercel.

---

## 📝 Note Operative

- La landing `/configure` genera URL install versionati `/install/vX.Y.Z/manifest.json`
- Le risposte `/stream/...` usano `Cache-Control: no-store`
- I manifest configurati hanno ID dedicato per coesistere con il manifest base
- Il formatter usa emoji per quality: 🚀 FHD, 💿 HD, 📀 SD
- Debug endpoints: `/debug/providers`, `/debug/cf-guardoserie`, `/health`
