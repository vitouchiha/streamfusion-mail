# MediaFlow Proxy

**Codice:** `src/toonitalia/raw.js`, `src/utils/config.js`  
**Stato:** Usato per ToonItalia HLS proxy

## Uso
- Proxy per flussi HLS che richiedono header specifici
- ToonItalia usa MFP per proxare stream con referer corretto
- Riscrive playlist m3u8 per passare attraverso il proxy

## Variabili Env
- `MFP_URL` o `MEDIAFLOW_PROXY_URL` — URL del proxy MediaFlow
- `MFP_API_PASSWORD` o `MEDIAFLOW_PROXY_PASSWORD` — Password API

## Note
- Self-hosted o hosted (es. su Render)
- Necessario per player che controllano referer/origin
