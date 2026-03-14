# TMDB (The Movie Database)

**API:** `api.themoviedb.org/3`  
**Codice:** `src/metadata/tmdb_client.js`, `src/tmdb_helper.js`

## Uso
- Metadata film/serie (titolo, poster, overview, anno)
- Ricerca titoli per nome
- Mapping IMDB ID → TMDB ID → metadata ITA

## Chiavi API
Attualmente **2 chiavi hardcoded** nel codice (da centralizzare):
- Chiave A: usata in 12+ file sotto `src/`
- Chiave B: usata come `DEFAULT_CONFIG.tmdbKey`

**TODO:** Centralizzare in `process.env.TMDB_API_KEY` e rimuovere hardcoded.

## Variabili Env
- `TMDB_API_KEY` — NON presente in `.env.example` (da aggiungere)

## Note
- Le chiavi TMDB v3 sono gratuite ma hanno rate limit
- Se revocata, tutti i provider perdono metadata ITA
