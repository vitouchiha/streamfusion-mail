# Chat History — MaxStream Fix & Smart Proxy

**Data:** 2026-03-14  
**Versioni:** v3.0.55 → v3.0.59  
**Commit finale:** `149bcc9`

---

## Problema Iniziale
MaxStream streams non apparivano in Stremio per serie TV italiane (CB01, EuroStreaming).

## Root Causes Trovate

1. **CF Worker regex rotta**: Non matchava attraverso tag `<button>` per il link CONTINUE
2. **Nessuno stripping honeypot**: Link decoy/honeypot matchati al posto del reale `#buttok`
3. **Vercel 60s timeout**: Captcha solve troppo lento (45-90s per digit sequenziale)
4. **`normalizeForSearch` non codifica `&`**: `?s=Will+&+Grace` spezzava il parametro
5. **CB01 `extractSeriesStreams`**: Solo sp-head parsato, link folder `/msfld/` in sp-body ignorato
6. **Cookie `/msfi/` separate**: `/msfi/` condivide sessione captcha con `/msf/` ma path mapping mancava
7. **Proxy rotating inaffidabile**: Solo 1-3 di 10 IP funzionano per uprot/maxstream (CF blocca il resto)

## Soluzioni Implementate

### v3.0.55: Uprot Captcha Auto-Solve
- Segmentazione per digit → OCR via CF Worker AI (Llama 3.2 Vision)
- KV cookie persistence (22h TTL) per evitare resolve ripetuti
- 3 tipi link uprot: DECOY, HONEYPOT, REALE (`#buttok`)

### v3.0.56: Fix `/msei/` Episode Links
- Path type diverso: captcha token-based (4 digit, no PHPSESSID)
- 5 retry per `/msei/` (accuratezza ~31-52% per tentativo)

### v3.0.59: Smart Proxy + Browser Fallback
- `src/utils/proxy.js`: Tenta PROXY_URL → cicla tutti IP da `proxies.json` → fallback diretto
- PROXY_URL fisso su `64.137.96.74:6641` (unico IP funzionante per tutti i path)
- Browser fallback Puppeteer+stealth in `maxstream.js` per CF 503/403
- HEAD redirect loop ridotto da 10→3 tentativi in `uprot.js`

## Test Confermati
- Will & Grace S01E01: **5 streams** (inclusi 2 MaxStream da EuroStreaming + CB01)
- Gladiator II: MaxStream HLS `master.m3u8` funzionante

## File Modificati
- `src/utils/proxy.js` (NUOVO)
- `src/extractors/maxstream.js` (browser fallback)
- `src/extractors/uprot.js` (shared proxyFetch, 3-try loop)
- `src/cb01/index.js` (normalizeForSearch, sp-body, resolveFolder)
- `cfworker.js` (regex fix, honeypot stripping, KV endpoints)
- `manifest.json` (→ v3.0.59)
