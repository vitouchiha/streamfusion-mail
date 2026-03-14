# GuardaSerie

**URL:** `guardaserietv.autos`  
**Codice:** `src/guardaserie/`  
**Stato:** ✅ Funzionante (~20s)

## Funzionamento
- Funziona da Vercel (niente CF Bot Fight Mode)
- Estrazione via SuperVideo → HLS con token refresh
- Lento: ~20s per risultati

## Estrazione
1. Search → pagina serie → parse episodi
2. SuperVideo embed → supervideo.cc → serversicuro.cc manifest
3. Token `i=0.0` necessario per HLS manifest
4. Se token mancante/expired → degrade a `isExternal` browser fallback

## Note
- SuperVideo packed JavaScript necessita unpacking
- serversicuro.cc manifest senza token → 403 garantito
- Browser fallback cattura manifest reale con token
