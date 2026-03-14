# EuroStreaming

**URL:** `eurostream.ing` / `clicka.cc`  
**Codice:** `src/eurostreaming/`  
**Stato:** ✅ Funzionante (via CF Worker)

## Funzionamento
- Cloudflare Bot Fight Mode blocca TUTTI gli IP datacenter
- Soluzione: 3-layer cache architecture

## Architettura Cache (3 livelli)

### Livello 1: Batch Warming (locale)
```
node _warm.js <showname>   # Da PC con IP italiano
```
Scalda link clicka.cc/delta, /mix, /tv nel KV del CF Worker.

### Livello 2: CF Worker KV Cache
- Namespace: `ES_CACHE` (ID `77d345738f28442c8a19fadc030eb92e`)
- TTL: 24h per link eurostream.ing/clicka.cc
- Endpoint: `?es_stream=<url>` → 302 redirect a MP4
- Endpoint: `?es_resolve=<url>` → JSON con URL player

### Livello 3: Memory Cache (runtime)
- LRU in-memory su Vercel per hit rapidi

## Player Supportati
| Player | Metodo | Output |
|--------|--------|--------|
| DeltaBit/Turbovid | `es_stream` → 302 | MP4 diretto |
| MixDrop | `es_resolve` → MFP | URL MediaFlow Proxy |

## Parsing Episodi
- `findEpisodeStreams` parsa sezioni spoiler per lingua (ITA/SUB-ITA)
- Parallelo: tutti i player estratti contemporaneamente

## Variabili Env
- `CF_WORKER_URL` — URL del CF Worker
- `CF_WORKER_AUTH` — Token autenticazione worker
