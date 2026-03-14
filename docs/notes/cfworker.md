# Cloudflare Worker

**URL:** `kisskh-proxy.vitobsfm.workers.dev`  
**Codice:** `cfworker.js`  
**Config:** `wrangler.toml`

## Funzioni

### 1. Proxy KissKH
- Bypassa CF Bot Management proxando dall'interno della rete Cloudflare
- `GET /?url=<encoded_kisskh_api_url>`
- Header opzionali: `&xhr=1`, `&referer=<url>`

### 2. Proxy EuroStreaming
- `?es_stream=<url>` → 302 redirect a MP4 (DeltaBit/Turbovid)
- `?es_resolve=<url>` → JSON resolve per MixDrop

### 3. KV Cache EuroStreaming
- Namespace: `ES_CACHE` (ID `77d345738f28442c8a19fadc030eb92e`)
- TTL 24h per link eurostream.ing/clicka.cc

### 4. Uprot KV Cookie Persistence
- `?uprot_kv=1` → Salva/carica cookies captcha solved in KV
- PHPSESSID + captcha hash, TTL 22h
- Evita re-solve captcha su ogni cold start Vercel

### 5. AnimeUnity Search
- `?au_search=<query>` → POST search con CSRF session
- Gestisce CSRF token + session cookie internamente

### 6. OCR Captcha
- CF Worker AI binding per OCR digit captcha
- Modello primario: `@cf/meta/llama-3.2-11b-vision-instruct`
- Fallback: `@cf/llava-hf/llava-1.5-7b-hf`

## Autenticazione
- `AUTH_TOKEN` (env CF Worker) → header `x-worker-auth` o `?auth=`
- Variabile Vercel: `CF_WORKER_AUTH`

## KV Namespaces
| Namespace | ID | Uso |
|-----------|-----|-----|
| ES_CACHE | `77d345738f28442c8a19fadc030eb92e` | Cache link EuroStreaming |
| UPROT_KV | (nel binding) | Cookie captcha uprot |

## Deploy
```bash
npx wrangler deploy cfworker.js --name kisskh-proxy --compatibility-date 2024-01-01
```
