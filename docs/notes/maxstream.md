# MaxStream — Estrattore

**Codice:** `src/extractors/maxstream.js`  
**Stato:** ✅ Funzionante (v3.0.59)

## Funzionamento
MaxStream è un video hosting che serve HLS stream. Protetto da Cloudflare.

## Catena Estrazione
```
maxstream.video/uprots/xxx → HTTP redirect → watchfree URL
  → costruisci /emvvv/ embed URL → parse pagina → HLS master.m3u8
```

## Metodi di Estrazione

### 1. HTTP (principale)
- Segui redirect chain uprots → watchfree → emvvv
- Parse HTML per URL m3u8 con regex/cheerio
- Rapido (~1-2s con cookie cached)

### 2. Browser Fallback (v3.0.59)
- Attivato su Cloudflare 503/403
- Puppeteer + stealth plugin + proxy
- Genera la pagina completa, gestisce redirect JavaScript
- Più lento (~10-15s) ma affidabile

## Problemi Noti
- Cloudflare blocca la maggior parte degli IP datacenter
- Solo proxy `64.137.96.74` funziona per tutti i path
- I token nelle URL m3u8 scadono dopo ~6h

## Variabili Env
- `PROXY_URL` — Necessario per bypass CF
- `PUPPETEER_EXECUTABLE_PATH` — Per browser fallback
