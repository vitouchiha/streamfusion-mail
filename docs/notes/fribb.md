# Fribb anime-lists

**Sorgente:** `https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json`  
**Codice:** `src/mapping/anime_list.js`

## Uso
- Index offline per mapping tra ID anime (Kitsu, MAL, AniList, IMDB, TMDB, TVDB, AniDB)
- 41,826 entries, ~7MB JSON
- Pre-caricato all'avvio del server
- Auto-refresh ogni 24h con ETag check (evita re-download se non cambiato)

## Indici Costruiti
| Tipo | Entries |
|------|---------|
| Kitsu | 21,800 |
| MAL | 29,900 |
| AniList | 20,300 |
| IMDB | 5,100 |
| TMDB | 5,300 |
| TVDB | 4,200 |
| AniDB | 15,600 |

## Fallback Chain
1. Offline list (Fribb)
2. Kitsu API
3. TMDB API
4. Title search

## Note
- Il campo `season.tvdb` è usato per risolvere stagioni specifiche
- Nessuna variabile env necessaria (fetch diretto da GitHub)
