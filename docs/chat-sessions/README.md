# Chat Session — Problema MaxStream in Stremio

**Session ID:** `bc14a7ec-dabd-4ad6-a732-0ca479b6d0a8`
**Data:** 2026-03-14
**File JSONL:** [chat-sessions/bc14a7ec-dabd-4ad6-a732-0ca479b6d0a8.jsonl](../chat-sessions/bc14a7ec-dabd-4ad6-a732-0ca479b6d0a8.jsonl)

---

## Obiettivo
Risolvere la mancanza di flussi MaxStream nei risultati Stremio per serie TV italiane (test: Will & Grace).

## Bug Trovati e Risolti

### 1. CF Worker regex rotta (pre-sessione)
- Il regex per il pulsante CONTINUE non matchava tag `<button>`
- **Fix:** Regex aggiornato nel CF Worker

### 2. Nessuno stripping honeypot (pre-sessione)
- Link decoy/honeypot venivano matchati al posto del vero link `buttok`
- **Fix:** Stripping honeypot aggiunto

### 3. Vercel 60s timeout (pre-sessione)
- Captcha solve troppo lento per cold start
- **Fix:** KV cookie persistence tramite CF Worker

### 4. `normalizeForSearch` non codifica `&`
- `?s=Will+&+Grace` → il parametro si spezza su `&`
- **Fix:** Usa `encodeURIComponent(...).replace(/%20/g, '+')`
- **File:** `src/cb01/index.js`

### 5. `extractSeriesStreams` non legge sp-body
- Solo sp-head veniva parsato, ma il link folder `/msfld/` è nello sp-body
- **Fix:** Aggiunto fallback sp-body + `resolveFolder()` helper per risolvere `/msfld/`
- **File:** `src/cb01/index.js`

### 6. `/msfi/` cookies separate da `/msf/`
- `/msfi/` (item da folder) condivide la sessione captcha con `/msf/`
- **Fix:** `_getPathType` mappa `/msfi/` → `/msf/`
- **File:** `src/extractors/uprot.js`

### 7. Vercel cron Hobby plan
- `0 */12 * * *` supera il limite giornaliero Hobby
- **Fix:** Cron rimosso da vercel.json (da re-aggiungere come daily)

### 8. CRON_SECRET whitespace
- Variabile env con trailing whitespace/newline
- **Fix:** Rimossa e ri-aggiunta (possibile problema newline ancora)

## Stato Attuale

- ✅ Test locale per Will & Grace S01E01: 1 stream MaxStream trovato (1.8s)
- ❌ Vercel production: MaxStream NON appare (solo 3 stream: EuroStreaming, GuardaSerie, SC)
- 🔄 Diagnostic logging deployato ma log non ancora letti completamente
- Il problema su Vercel: `_bypassUprot` carica cookies KV, POST a `/msfi/`, captcha non mostrato (cookies accettati), ma **nessun redirect link trovato** nella risposta HTML

## Commit Rilevanti

| Commit | Descrizione |
|--------|-------------|
| `ed5f010` | Fix CF Worker regex + honeypot |
| `2ed239a` | KV cookie persistence |
| `0f377a2` | Fix normalizeForSearch + sp-body + /msfi/ |
| `7167b8c` | Fix CB01 folder resolution |
| `c2ad81e` | Cron daily fix |
| `20f33a6` | Remove cron to unblock deploy |
| `b696c7b` | Increase CB01 timeout 12→25s |
| `76dd83d` | Enhanced diagnostic logging |

## Prossimi Passi

1. Leggere i log diagnostici Vercel per capire il fallimento redirect
2. Fixare il bypass su Vercel
3. Re-aggiungere cron (daily, CRON_SECRET pulito)
4. Aggiornare versione release
5. Cleanup file temporanei
