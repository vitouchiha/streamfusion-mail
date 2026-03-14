# Uprot.net — Estrattore

**Codice:** `src/extractors/uprot.js`  
**Stato:** ✅ Funzionante (v3.0.55+)

## Funzionamento
Uprot.net è un URL shortener con captcha che protegge link a MaxStream.

## Catena Redirect
```
uprot.net/msf/xxx → captcha page → bypass → uprots redirect
  → maxstream.video/uprots/xxx → watchfree URL → emvvv embed → HLS m3u8
```

## Tipi di Path

| Path | Captcha | Digit | Cache | Note |
|------|---------|-------|-------|------|
| `/msf/` | PHPSESSID | 3 | ✅ 22h KV | File singolo |
| `/mse/` | → redirect `/msf/` | — | ✅ | Alias |
| `/msei/` | Token-based | 4 | ❌ | Per episodio, no cache |
| `/msfi/` | Condivide `/msf/` | — | ✅ | Item da folder |
| `/msfld/` | n/a | — | — | Folder → lista `/msfi/` |

## Captcha OCR
1. GET pagina captcha → immagine PNG
2. Preprocesso: threshold 80, binarizzazione, noise removal
3. Segmentazione per digit (column projection)
4. Ogni digit → CF Worker AI (Llama 3.2 Vision)
5. POST risposta → bypass page → estrai link reale

## 3 Tipi di Link nella Bypass Page
1. **DECOY:** `<a>` vuoto con URL statico morto (appare 2x)
2. **HONEYPOT:** In `<div style="display:none">`
3. **REALE:** Dentro `<button id="buttok">C O N T I N U E</button>`

## Cookie Pinning
- PHPSESSID legato a IP di creazione
- Cookies devono essere create via stesso IP usato per il bypass
- KV persistence via CF Worker (`?uprot_kv=1`)

## Variabili Env
- `PROXY_URL` — Necessario (uprot blocca IP datacenter)
- `CF_WORKER_AUTH` — Per KV cookie storage
- `CF_WORKER_URL` — Per OCR e KV endpoints
