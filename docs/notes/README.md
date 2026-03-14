# Servizi e Siti — Indice

Documentazione per ogni sito e servizio esterno usato da Nello Stream.

---

## Provider Streaming (Siti sorgente)

| Sito | File | Stato |
|------|------|-------|
| [StreamingCommunity](streamingcommunity.md) | `src/streamingcommunity/` | ✅ Funzionante |
| [EuroStreaming](eurostreaming.md) | `src/eurostreaming/` | ✅ Funzionante (via CF Worker) |
| [CB01](cb01.md) | `src/cb01/` | ✅ Funzionante |
| [GuardaSerie](guardaserie.md) | `src/guardaserie/` | ✅ Funzionante (~20s) |
| [GuardaFlix](guardaflix.md) | `src/guardaflix/` | ⚠️ Fragile |
| [GuardoSerie](guardoserie.md) | `src/guardoserie/` | ⚠️ Solo cached |
| [GuardaHD](guardahd.md) | `src/guardahd/` | ⚠️ Richiede proxy |
| [Loonex](loonex.md) | `src/loonex/` | ✅ Cartoni |
| [ToonItalia](toonitalia.md) | `src/toonitalia/` | ✅ Funzionante |
| [AnimeSaturn](animesaturn.md) | `src/animesaturn/` | ✅ Funzionante |
| [AnimeUnity](animeunity.md) | `src/animeunity/` | ✅ CF Worker fallback |
| [AnimeWorld](animeworld.md) | `src/animeworld/` | ✅ Funzionante |
| [KissKH](kisskh.md) | `src/providers/kisskh.js` | ⚠️ Fragile |

## Servizi Esterni

| Servizio | File | Uso |
|----------|------|-----|
| [Vercel](vercel.md) | `vercel.json` | Hosting serverless |
| [Cloudflare Worker](cfworker.md) | `cfworker.js` | Proxy, KV cache, OCR |
| [WebShare Proxy](webshare.md) | `proxies.json` | Proxy residenziali |
| [TMDB](tmdb.md) | `src/metadata/` | Metadata film/serie |
| [Browserless](browserless.md) | `src/utils/browser.js` | Chrome remoto |
| [MediaFlow Proxy](mediaflow.md) | `src/toonitalia/raw.js` | HLS proxy |
| [Fribb anime-lists](fribb.md) | `src/mapping/` | Mapping anime offline |

## Estrattori Video

| Estrattore | File | Usato da |
|-----------|------|----------|
| [MaxStream](maxstream.md) | `src/extractors/maxstream.js` | CB01, EuroStreaming |
| [Uprot](uprot.md) | `src/extractors/uprot.js` | CB01, EuroStreaming |
| [MixDrop](mixdrop.md) | `src/extractors/mixdrop.js` | CB01, GuardaHD, Loonex |
| [SuperVideo](supervideo.md) | `src/extractors/supervideo.js` | GuardaSerie |
| [Turbovid/DeltaBit](turbovid.md) | `src/extractors/turbovidda.js` | EuroStreaming |
