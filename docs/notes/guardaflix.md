# GuardaFlix

**URL:** `guardaplay.space`  
**Codice:** `src/guardaflix/`  
**Stato:** ⚠️ Fragile

## Funzionamento
- Funziona da Vercel
- Nonce hardcoded per API calls
- Year matching stretto (può fallire se anno diverso tra TMDB e sito)

## Note
- Se il nonce cambia, il provider smette di funzionare
- Richiede monitoraggio manuale del nonce
