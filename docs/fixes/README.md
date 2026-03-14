# Fixes Log

Registro cronologico dei fix principali applicati al progetto.

---

## 2026-03-14

### v3.0.59 — Smart Proxy + Browser Fallback MaxStream
- **Problema:** Proxy rotating assegna IP random, solo 1/10 funziona per uprot
- **Fix:** Smart proxy (`src/utils/proxy.js`) + PROXY_URL statico + Puppeteer fallback
- **Commit:** `149bcc9`

### v3.0.56 — Fix uprot `/msei/` episode links
- **Problema:** CB01 serie usano path `/msei/` con captcha diverso (token-based, 4 digit)
- **Fix:** Nuovo `_extractMseiUprot()` con 5 retry
- **Commit:** nella serie v3.0.55-59

### v3.0.55 — Uprot Captcha Auto-Solve
- **Problema:** Uprot captcha bloccava MaxStream su Vercel (timeout 60s)
- **Fix:** OCR per digit via CF Worker AI + KV cookie cache
- **Commit:** nella serie v3.0.55

## 2026-03-13

### v3.0.50 — AnimeSaturn S1 Leak + AnimeUnity CF Block
- **Problema:** S2 con 0 episodi fallback a path S1; AnimeUnity search bloccato da CF
- **Fix:** Filtro season su related paths; 3-tier fallback (direct → cloudscraper → CF Worker)
- **Commit:** `6e4e47c`

### v3.0.48 — Season-Specific Anime Resolution
- **Problema:** Anime multi-season risolvevano alla entry sbagliata
- **Fix:** Usa Fribb `season.tvdb` per trovare entry Kitsu/AniList corretta per stagione
- **Commit:** `e99cdd4`

### v3.0.44 — Anime Mapping Internalizzato
- **Problema:** API mapping esterna inaffidabile
- **Fix:** Fribb anime-lists offline (41k entries), auto-refresh 24h con ETag
- **Commit:** nella serie v3.0.42-44

## 2026-03-10

### v3.0.37 — EuroStreaming Fix Completo
- **Problema:** CF Bot Fight Mode blocca tutti gli IP datacenter
- **Fix:** CF Worker KV cache 3-layer + batch warming locale
- **Commit:** nella serie v3.0.37

### GuardaSerie SuperVideo Fix
- **Problema:** Packed `serversicuro.cc` reconstruction sbagliata; manifest senza token → 403
- **Fix:** Browser fallback per catturare manifest reale; degrade a `isExternal` se fallisce
