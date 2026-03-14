# KissKH

**URL:** `kisskh.co`  
**Codice:** `src/providers/kisskh.js`  
**Stato:** ⚠️ Fragile

## Funzionamento
- K-drama e Asian drama provider
- API diretta del sito (JSON endpoints)
- Proxato via CF Worker (bypassa CF Bot Management)
- API key statica nel codice

## Comunicazione
```
Stremio → Vercel → CF Worker → kisskh.co API → JSON → parse
```

## Cataloghi
- `kisskh_catalog` — Asian Drama
- `rama_catalog` — Korean Drama

## Problemi
- API key statica → se cambia, provider rotto
- 45s browser timeout per CF bypass
- CF challenge su IP non Cloudflare

## Variabili Env
- `CF_WORKER_URL` — URL del proxy worker
- `CF_WORKER_AUTH` — Token auth
- `CF_CLEARANCE_KISSKH` — Cookie CF clearance (opzionale)
