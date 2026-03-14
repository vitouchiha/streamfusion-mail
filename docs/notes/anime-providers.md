# Anime Provider (AnimeSaturn, AnimeUnity, AnimeWorld)

## AnimeSaturn
**Codice:** `src/animesaturn/`  
**Stato:** ✅ Funzionante (v3.0.50+)
- Parsing `item-archivio` per lista anime
- Fix: filtro related paths per season (evita leak S1 quando cerca S2)
- Stream diretti (nessun extractor esterno)

## AnimeUnity
**Codice:** `src/animeunity/`  
**Stato:** ✅ Funzionante con CF Worker fallback
- Search via POST `/archivio/get-animes` con CSRF session
- CF blocking su Vercel → 3-tier fallback: direct → cloudscraper → CF Worker `au_search`
- CF Worker gestisce internamente CSRF token + session cookie

## AnimeWorld
**Codice:** `src/animeworld/`  
**Stato:** ✅ Funzionante
- Scraping diretto
- Mapping via Fribb anime-lists

## Mapping Anime (condiviso)
**Codice:** `src/mapping/index.js`, `src/mapping/anime_list.js`
- Fribb anime-lists offline: 41,826 entries, 7MB JSON
- Index: Kitsu (21.8k), MAL (29.9k), AniList (20.3k), IMDB (5.1k), TMDB (5.3k), TVDB (4.2k), AniDB (15.6k)
- Auto-refresh 24h con ETag check
- Fallback chain: offline list → Kitsu API → TMDB API → title search
- Season-specific: usa `season.tvdb` per entry corretta per stagione
