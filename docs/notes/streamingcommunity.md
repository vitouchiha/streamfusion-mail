# StreamingCommunity

**URL:** `streamingcommunity.computer` (dominio cambia frequentemente)  
**Codice:** `src/streamingcommunity/`  
**Stato:** ✅ Funzionante  
**Timeout:** 14s

## Funzionamento
- Ricerca titoli via API interna del sito
- Estrazione video tramite VixCloud (player integrato)
- Pure HTTP — nessun browser necessario
- Il più veloce tra i provider italiani

## Estrazione
1. Search → pagina titolo → parse episodi
2. VixCloud embed → token URL → HLS master playlist
3. Return `m3u8` diretto

## Problemi Noti
- Dominio cambia spesso (auto-risoluzione implementata in `src/config/`)
- VixCloud usa token con scadenza → non cachabile a lungo

## Variabili Env
Nessuna specifica — usa le globali (`PROXY_URL`, `STREAM_TIMEOUT`)
