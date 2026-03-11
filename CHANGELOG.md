## [3.0.22] - 2026-03-10

### Fixed
- **Guardaserie inline playback in Stremio** - Quando esiste un flusso HLS diretto valido, l'addon ora elimina i fallback `Web Browser` e passa i link SuperVideo header-protected attraverso il proxy HLS interno, così Stremio riproduce dentro l'app invece di aprire la pagina esterna.

---

## [3.0.19] - 2026-03-09
- Feat: Aggiunto formatter globale con tema Cane per tutti i provider.

## [3.0.18] - 2026-03-09

### Fixed
- **Browserless Quota & Guardaserie Playback** - Disabilitato temporaneamente il fallback Browserless oneroso per i flussi SuperVideo (che consumava l'intera quota API a causa di fail continui su Cloudflare). Sostituito con un reindirizzamento al player nativo web-browser di Guardaserie, risolvendo i problemi di stream non riproducibile dovuti ai check di IP-lock originati da Browserless.
- **ToonItalia Search & Extraction** - Sistemata l'estrazione TV show di ToonItalia ottimizzando il matching RegEx dell'HTML degli episodi e introducendo la normalizzazione corretta delle chiavi in stringa minuscola per permettere il recupero della libreria serie tv.

---
﻿## [3.0.16] - 2026-03-08

### Fixed
- **UI Formatting Fix** - Risolto il problema delle doppie emoji nei nomi dei provider e nelle etichette dei server. Le grafiche ora riproducono fedelmente lo stile originale EasyStreams con etichette perfette come \🚀 FHD\ o \💿 HD\ senza duplicazioni visive.

---
## [3.0.15] - 2026-03-08

### Added
- **Enhanced Stream UI** - Aggiornato il formatter per mostrare la risoluzione con emoji in evidenza (es. \🚀 1080p\) e un titolo multilinea più ricco con informazioni sul provider, server, lingua e altri dettagli. Simile ad EasyStreams.
- **IMDb to Kitsu Mapping** - Integrazione API nimemapping.stremio.dpdns.org per risolvere le richieste Anime tramite cataloghi standard IMDb e sbloccare provider italiani quali AnimeSaturn e AnimeUnity.

---
# Changelog

All notable changes to **StreamFusion Mail** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) Â· Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.6.9] â€” 2026-03-06

### Fixed
- **Safety-net globale meta KissKH** â€” l'aggregatore ora garantisce fallback `meta` valido per ogni ID `kisskh_*` anche in caso di timeout/eccezioni provider, evitando definitivamente il rendering bloccante *"No metadata was found"* nella sezione Scopri.
- **Diagnostica produzione migliorata** â€” aggiunto log `meta response` con `provider`, `hasMeta` e `videos` per verificare in tempo reale cosa viene realmente restituito a Stremio su ogni richiesta dettaglio.

---

## [1.6.8] â€” 2026-03-06

### Fixed
- **Schermata Stremio "No metadata was found" su ID KissKH** â€” quando il fetch meta upstream falliva/intermittente, il provider restituiva `meta: null` e la UI mostrava errore totale.
- `kisskh.getMeta()` ora restituisce sempre un **meta fallback valido** per ID `kisskh_*` (mai `null`), con descrizione di retry e `videos: []`, evitando la schermata di errore bloccante.

---

## [1.6.7] â€” 2026-03-06

### Fixed
- **KissKH "No metadata was found" intermittente** â€” `getMeta` ora usa fallback multi-mirror per i dettagli serie (`DramaList/Drama`) e cast (`DramaList/Cast`), provando sia `kisskh.do` che `kisskh.co` prima di ritornare `meta: null`.
- **Retry robusto con bypass CF** â€” se il fast-path JSON fallisce, `getMeta` ritenta automaticamente con catena CF Worker/FlareSolverr, riducendo i casi in cui Stremio apre la card ma non riceve metadati.

---

## [1.6.6] â€” 2026-03-06

### Fixed
- **Catalogo Rama compatibile con Stremio Home/Discover** â€” il provider Rama restituiva item/meta con `type: "kdrama"` mentre il manifest espone solo `series`. Questo causava errori UI tipo *"No addons were requested for this meta!"* quando si apriva una card Rama dalla home.
- Allineati i tipi in `src/providers/rama.js` (`catalog item`, `meta`, fallback `_emptyMeta`) da `kdrama` a `series`.

---

## [1.6.5] â€” 2026-03-06

### Fixed
- **Bypass 403 `.png` nel fallback browser** â€” dopo il load pagina, il resolver effettua una fetch della `.png` direttamente nel contesto browser (cookie/challenge live), estraendo `Video/Video_tmp` anche quando le chiamate server-side ricevono `403`.
- Migliorata la resilienza di estrazione stream per episodi che non emettono subito richieste `.m3u8` in rete.

---

## [1.6.4] â€” 2026-03-06

### Fixed
- **`.png` probing multi-endpoint** â€” il resolver ora prova varianti endpoint `kisskh.do` e `kisskh.co` con query minima (`?kkey=`) e query legacy (`err/ts/time`) per aumentare la compatibilita tra mirror e anti-bot path.
- **Fallback `.png` piu resiliente** â€” sia CF Worker che axios diretto iterano su tutte le varianti prima di dichiarare il ramo `.png` fallito.

---

## [1.6.3] â€” 2026-03-06

### Changed
- **Browser fallback piu persistente su Vercel** â€” timeout estrazione stream aumentato da `32s` a `45s` per lasciare margine alla risoluzione challenge/player su episodi lenti.
- **Player nudge automatico** â€” dopo il caricamento pagina, il resolver prova a cliccare i controlli play piu comuni (`vjs/jw/plyr/video`) per forzare l'emissione delle richieste stream lazy.

---

## [1.6.2] â€” 2026-03-06

### Fixed
- **KissKH stream candidate validation piu tollerante** â€” il resolver ora testa sia URL raw che URL tokenizzati (`?v=`) per evitare falsi negativi quando il token non e necessario o non e valido per quell'episodio.
- **Parsing `.png` esteso** â€” oltre a `Video` supporta anche `Video_tmp`, `ThirdParty`, `url`, `stream` e URL protocol-relative (`//...`) con normalizzazione automatica.
- **Browser fallback piu robusto** â€” se la pagina non emette subito la richiesta `.m3u8`, il browser intercetta la risposta JSON di `/Episode/{id}.png` e usa direttamente il campo video come stream candidate.
- **Probe HLS piu realistico** â€” aggiunti header `Referer/Origin/UA` nel controllo di playability per ridurre casi di `streams=0` dovuti a check troppo strict lato CDN.

---

## [1.6.1] â€” 2026-03-06

### Fixed
- **KissKH `.png` stream endpoint di nuovo funzionante** â€” aggiornati i `kkey` statici (`EPISODE_KKEY`, `SUB_KKEY`) ai valori correnti intercettati dal player live.
- **Parsing payload `.png` robusto** â€” ora gestisce payload `Buffer`/`text`/`object` in modo consistente e forza `responseType: text` nelle chiamate axios per evitare falsi null parsing.

---

## [1.6.0] â€” 2026-03-06

### Changed
- **Ottimizzazione budget timeout stream** â€” `getMeta` e l'estrazione token `v=` ora sono lazy (on-demand) invece che sempre upfront. Questo lascia piÃ¹ tempo utile al percorso stream reale (API/HTML/browser) dentro i limiti serverless di Vercel.
- Migliorata la prioritÃ  delle operazioni nel ramo stream per ridurre i casi `streams: []` causati da timeout cumulativi.

---

## [1.5.9] â€” 2026-03-06

### Changed
- **Stream path ottimizzato per Vercel/Browserless** â€” quando `BROWSERLESS_URL` Ã¨ configurato, il ramo FlareSolverr stream viene saltato (evita timeout inutili) e viene data prioritÃ  all'estrazione browser reale.
- Timeout browser fallback portato da `20s` a `32s` per aumentare la probabilitÃ  di intercettare `.m3u8` su episodi piÃ¹ lenti.

---

## [1.5.8] â€” 2026-03-06

### Fixed
- **Browser fallback non intercettava alcuni flussi `.m3u8`** â€” l'handler Puppeteer abortiva le richieste `resourceType=media` prima del controllo URL, quindi su alcuni episodi KissKH il flusso non veniva mai catturato. Ora l'intercettazione `.m3u8` avviene prima delle regole di abort, e le richieste media non-m3u8 restano bloccate.

---

## [1.5.7] â€” 2026-03-06

### Changed
- **KissKH API stream selection migliorata** â€” invece di usare solo una URL (`Video`), il provider ora considera tutte le candidate restituite dall'API (`Video_tmp`, `Video`, `ThirdParty`, `video`, ecc.) e sceglie la prima realmente riproducibile.
- Le candidate API vengono tokenizzate con il `v=` estratto (quando disponibile) prima del probe playability.

---

## [1.5.6] â€” 2026-03-06

### Added
- **Estrazione token reale `v=` da player script** â€” il provider KissKH ora analizza la pagina episodio e i bundle JS collegati per cercare il token usato negli URL HLS (`?v=...`).

### Changed
- Quando un URL stream non contiene `v=`, il token estratto viene applicato automaticamente (`_withVToken`) prima della validazione playability.
- Fallback predittivo/HTML ora beneficia dello stesso token reale invece di restituire link non firmati.

---

## [1.5.5] â€” 2026-03-06

### Fixed
- **Stream KissKH visibile ma non avviabile** â€” alcuni fallback (es. URL HLS predittivo) potevano produrre link `404`, quindi Stremio mostrava la sorgente ma la riproduzione falliva. Aggiunta validazione server-side dell'URL HLS (`GET` breve + verifica `#EXTM3U`) prima di restituire lo stream.
- **Riduzione stream "falsi positivi"** â€” se l'URL non Ã¨ realmente riproducibile, il provider non lo espone e continua con i fallback; guard finale prima del cache/set per evitare dead links.

---

## [1.5.4] â€” 2026-03-06

### Changed
- **Ordine fallback stream KissKH ottimizzato per Vercel** â€” il fallback HLS predittivo ora viene applicato **prima** del browser fallback. In questo modo, quando i path API/HTML falliscono, la risposta non resta bloccata in timeout Puppeteer (`504`) e restituisce comunque uno stream candidato invece di `streams: []`.

---

## [1.5.3] â€” 2026-03-06

### Added
- **Heuristic HLS fallback per KissKH** â€” se i percorsi stream standard falliscono (`.png`, legacy API, HTML, browser), il provider costruisce un URL HLS predittivo usando `serieId + numero episodio` dai metadata (`https://hls.cdnvideo11.shop/hls07/{serieId}/Ep{N}_index.m3u8`). Evita risposte vuote (`streams: []`) nei casi in cui il source path Ã¨ temporaneamente bloccato su Vercel.

---

## [1.5.2] â€” 2026-03-06

### Added
- **KissKH HTML stream fallback** â€” quando `.png`/legacy API falliscono, il provider prova a leggere la pagina episodio (`/Drama/Any/Episode-Any`) e a estrarre direttamente URL `.m3u8` dal markup (formato normale o escaped JSON). Questo percorso usa `PROXY_URL` come gli altri endpoint e riduce la dipendenza da FlareSolverr/Puppeteer su Vercel.

### Changed
- Fallback order stream KissKH: `API (.png + legacy)` â†’ `HTML extraction` â†’ `browser extraction`.

---

## [1.5.1] â€” 2026-03-06

### Added
- **Diagnostica produzione Cinemeta â†’ KissKH** â€” aggiunti log dettagliati nel percorso `tt*`: inizio/fine ricerca titolo, count risultati, meta video count, episode match e stream count finale. Serve a isolare con precisione il punto di fallimento su Vercel senza test locali.

---

## [1.5.0] â€” 2026-03-06

### Fixed
- **CF Worker path ignorato su stream KissKH** â€” il Worker poteva restituire JSON come `string` (soprattutto endpoint `.png` con content-type `image/png`) e `_cfWorkerGet` accettava solo oggetti. Risultato: fallback Worker scartato come `null`, poi `.png` diretto 403 e browser fallback spesso senza stream su Vercel. Ora `_cfWorkerGet` usa `responseType: text`, parse JSON anche da stringa e logga status/error upstream.
- **Worker requests stream piÃ¹ compatibili** â€” aggiunti parametri `xhr=1` e `referer` esplicito nelle chiamate stream (`.png` e legacy episode API) per allineare gli header al comportamento browser.

---

## [1.4.9] â€” 2026-03-06

### Fixed
- **KissKH stream 0 in produzione anche con meta/catalog funzionanti** â€” aggiunto fallback della legacy episode API via **CF Worker** (`/DramaList/Episode/{id}?type=...`) prima di FlareSolverr/Puppeteer. In ambienti Vercel dove la chiamata diretta riceve challenge/403, il Worker edge puo restituire il JSON con `Video` senza avviare browser.
- **Cinemeta ID con stream vuoti a cascata** â€” migliorato il percorso di risoluzione stream in modo che il fallimento `.png` non porti subito a timeout serverless; ora prova anche la legacy API via Worker in modo deterministico.

---

## [1.4.8] â€” 2026-03-06

### Fixed
- **Timeout stream su Vercel (0 risultati da Cinemeta/KissKH)** â€” quando la `.png` API restituiva 403, il fallback Puppeteer poteva superare il budget serverless e terminare con `504 Gateway Timeout`. Aggiunto cap hard di 20s alla browser extraction in `getStreams` per evitare richieste bloccate.
- **Path `.png` piÃ¹ robusto** â€” `_fetchStreamViaPngApi` ora tenta anche via **CF Worker** prima della chiamata diretta axios. Questo recupera stream in ambienti dove la richiesta diretta Ã¨ bloccata ma il Worker edge Ã¨ accettato.

---

## [1.4.7] â€” 2026-03-06

### Fixed
- **Cinemeta ID (`tt*`) con 0 risultati stream** â€” in alcuni ambienti Vercel, `v3-cinemeta.strem.io` risponde vuoto/timeout e il fallback TMDB non sempre era disponibile. Aggiunto fallback finale senza API key: risoluzione titolo da pagina pubblica IMDb (`https://www.imdb.com/title/{id}/`) con parsing `og:title`.
- **Robustezza risoluzione titolo da IMDB ID** â€” il flusso ora Ã¨: `Cinemeta` â†’ `TMDB /find` â†’ `IMDb page fallback`. Se un provider fallisce, i successivi tentano automaticamente.

### Changed
- Aggiornati i commenti tipo provider in `src/providers/index.js` da `kdrama` a `series` per allineamento con il manifest corrente.

---

## [1.4.6] â€” 2026-03-05

### Fixed
- **Metadati KissKH mai caricati (timeout TMDB)** â€” `enrichFromTmdb` poteva richiedere fino a 24s (2 ricerche Ã— 8s + 1 detail Ã— 8s). Sommato agli 8s delle chiamate KissKH, il getMeta superava il `META_TIMEOUT` di 30s, restituendo sempre `{meta: null}`. Fix: aggiunto un **cap di 10s** su `enrichFromTmdb` dentro getMeta (sia KissKH che Rama). Il metadato viene restituito con o senza lâ€™arricchimento TMDB, sempre entro 18s.
- **TMDB search fallisce su titoli con anno** â€” KissKH restituisce titoli come `"Therapy (2025)"`. La ricerca TMDB con questo titolo falliva perchÃ© TMDB ha solo `"Therapy"`. Fix: il suffisso anno-tra-parentesi viene rimosso prima della ricerca TMDB (`meta.name.replace(/\s*\(\d{4}\)\s*$/, '')`).
- **Catalogo Rama non appare in Scopri (Discover)** â€” il tipo `kdrama` non Ã¨ riconosciuto da Stremio, che mostra solo cataloghi di tipo `series`, `movie`, `channel`, `tv` nella scheda Scopri. Fix: tipo Rama cambiato da `kdrama` a `series` nel manifest. I routing interni continuano a funzionare correttamente tramite `id` prefix (`rama_*`).
- **Routing catalogo pericoloso** â€” `handleCatalog` aveva un fallback `|| type === 'series'` che serviva il catalogo KissKH per qualsiasi richiesta di tipo `series`, inclusa `rama_catalog`. Fix: routing ora basato esclusivamente su `catalogId`.
- **Manifest version bump** 1.4.4 â†’ 1.4.6 â€” forza Stremio a ri-scaricare il manifest e aggiornare i tipi.

---

## [1.4.5] â€” 2026-06-XX

### Fixed
- **"metadati non trovati" su Cinemeta (cinemeta=true)** â€” quando `cinemeta=true` era configurato, aggiungere `tt` al top-level `idPrefixes` causava Stremio a chiamare il nostro `getMeta` per gli item Cinemeta (ID `tt*`). Restituendo `{meta: null}` per questi ID, Stremio mostrava "metadati non trovati" su tutta la home. Fix: il manifest con `cinemeta=true` ora usa il formato **per-resource idPrefixes**: `meta` gestisce solo `kisskh_*`/`rama_*`, mentre `stream` gestisce anche `tt*`. Stremio usa Cinemeta per i meta e il nostro addon solo per gli stream.
- **Cinemeta â†’ KissKH: titoli K-drama non risolti** â€” `v3-cinemeta.strem.io` restituisce `{}` per i K-drama (Vercel datacenter IPs esclusi e/o assenza dei titoli nel database Cinemeta). Aggiunto fallback a **TMDB `/find/{imdbId}`** quando Cinemeta non fornisce il titolo. Richiede `tmdbKey` nel config URL oppure `TMDB_API_KEY` in Vercel env vars.
- **Cinemeta â†’ KissKH: 0 stream per K-drama classici** â€” `_searchCatalog` cercava solo negli ultimi 600 drammi ordinati per data (`order=3`). Drammi come "Crash Landing on You" (2019, page 3 `order=1`), "Goblin" (page 3), "Descendants of the Sun" (page 3), "Boys Over Flowers" (page 10) non venivano mai trovati. Aggiunto **popularity sweep parallelo** (`order=1`, pagine 1-10) che parte in parallelo con il recency sweep e copre i 300 drammi piÃ¹ visti di tutti i tempi.
- **Risultati di ricerca: match esatti penalizzati da match parziali** â€” dopo il merge dei risultati, la slice a 20 prendeva i primi 20 per ordine di scoperta (recency sweep). "Crash" (score 0.85) poteva vincere su "Crash Landing on You" (score 1.0) se il primo veniva trovato prima. Fix: i risultati vengono ora **ordinati per `titleSimilarity` discendente** prima della slice, garantendo che i match esatti siano sempre in cima.

### Added
- **`findTitleByImdbId(imdbId, apiKey)`** in `src/utils/tmdb.js` â€” nuova funzione per cercare il titolo di una serie via TMDB `/find/{imdbId}?external_source=imdb_id`. Usata come fallback per i Cinemeta stream request.
- **`TMDB_API_KEY` env var** â€” se impostata in Vercel, abilita il fallback TMDB per tutti gli utenti indipendentemente dalla config personale. Chiave gratuita su https://themoviedb.org. Documentata in `stack.env.example`.
- **Manifest version bump** 1.3.8 â†’ 1.4.4 â€” forza Stremio a ri-scaricare il manifest e invalidare la cache.

---

## [1.3.8] â€” 2026-03-05

### Added
- **KissKH catalog enrichment da KissKH stesso** â€” `_listCatalog` e `_searchCatalog` ora eseguono in parallelo le chiamate alla drama detail API (non CF-protetta) per ogni item del catalogo. Le card nella home mostrano `description`, `genres`, `releaseInfo`. Effetto collaterale: `metaCache` viene pre-popolato, quindi quando Stremio apre un item e chiama `getMeta`, la risposta Ã¨ istantanea dalla cache (elimina il "No metadata was found").
- **`_buildMeta` helper** â€” logica di costruzione del meta object estratta in una funzione condivisa usata sia da `getCatalog` (enrichment) che da `getMeta` (eliminata duplicazione di codice).
- **IP client passato ai provider** â€” `server.js` legge l'IP del client da `X-Forwarded-For` (impostato da Vercel) e lo inietta in `config.clientIp`. Tutti i provider (`kisskh.js`, `rama.js`) e le utility (`fetcher.js`) usano questo IP come header `X-Forwarded-For` nelle richieste upstream. Questo fa apparire le richieste come provenienti dall'IP italiano dell'utente.
- **`Accept-Language: it-IT`** â€” aggiunto a `fetchWithCloudscraper` (Rama), `_baseHeaders` KissKH, e alle chiamate TMDB axios.

### Fixed
- **`getMeta` semplificato** â€” rimosso codice duplicato (cast parsing, video mapping) ora centralizzato in `_buildMeta`.

---

## [1.3.7] â€” 2026-03-05

### Fixed
- **KissKH catalog: ripristinato filtro `country=2` (solo drammi coreani)** â€” il cambio precedente a `country=0` mostrava drammi cinesi/giapponesi in prima pagina. Ora `_listCatalog` usa `country=2&status=0` (solo Corea, sia ongoing che completati).
- **KissKH ricerca titola falliva per drammi meno recenti** â€” lâ€™API KissKH ignora completamente il parametro `search=` e restituisce sempre il catalogo ordinato per data. `_searchCatalog` si fermava dopo 2 batch consecutivi senza match (~180 drammi visti), non raggiungendo drammi come "Our Universe" (pagina 11). Fix: rimosso lâ€™early-exit `emptyBatches`, aumentato `maxPages` da 10 a 20 (600 drammi coperti). Rimosso `search=query` dallâ€™URL (era inutile).
- **Cinemeta path `SEARCH_TIMEOUT` raddoppiato** â€” `_kisskhStreamsForTitle` usava 8 s di timeout per la ricerca catalogo. Con la nuova logica (fino a 20 pagine in batch da 3) il timeout Ã¨ aumentato a 20 s per permettere la ricerca nelle pagine piÃ¹ avanzate.

---

## [1.3.6] â€” 2026-05-14

### Fixed
- **KissKH streams: rimossa visita intermedia `drama page` nella sequenza FlareSolverr** â€” `_fetchStreamViaApi` ora esegue solo 2 step: CF primer â†’ episode API (4 varianti), invece di 3 (primer â†’ drama page â†’ episode API). La visita alla drama page consumava 8â€“15 s del budget 25 s prima ancora di tentare l'API dello stream, causando timeout sistematici. Il `dramaPageUrl` Ã¨ conservato come `Referer` nell'header della chiamata all'API episodio senza ulteriori caricamenti della pagina. Le varianti API tentate salgono da 2 a 4 (`typeÃ—source`: 2Ã—1, 1Ã—0, 2Ã—0, 1Ã—1).

---

## [1.3.5] â€” 2026-05-09

### Added
- **TopPoster API** â€” nuovo campo `topPosterKey` nella configurazione. Se configurato (assieme a TMDB), sostituisce il poster standard con la locandina fornita da TopPoster. Ha prioritÃ  su RPDB. Integrato in `src/utils/tmdb.js` (`topPosterUrl()`), `src/utils/config.js` (chiave breve `tp`), `src/providers/kisskh.js` (nuovo blocco TMDB enrichment in `getMeta`), `src/providers/rama.js` (entrambi i blocchi poster). Aggiunto il campo nella landing page di configurazione.
- **KissKH TMDB enrichment in getMeta** â€” `getMeta` di KissKH ora arricchisce la scheda con dati TMDB (poster HD, background, cast, generi, IMDB ID) se `tmdbKey` Ã¨ configurata, con la stessa logica di Rama.

---

## [1.3.4] â€” 2026-05-08

### Removed
- **Drammatica provider** rimosso â€” `www.drammatica.it` risulta parcheggiato (ParkLogic domain parking): il sito non Ã¨ piÃ¹ attivo. Rimosso da `manifest.json` (catalog + idPrefix), da `src/providers/index.js` (routing, import, `_drammaticaStreamsForTitle`). Il file `drammatica.js` rimane in codebase nel caso venga trovato un nuovo URL.

---



### Removed
- **Guardaserie provider** rimosso â€” giÃ  presente in altri addon; tolto da `manifest.json` (catalog + idPrefix), da `src/providers/index.js` (routing, import, `_guardaserieStreamsForTitle`) e dalla landing page.

### Fixed
- **KissKH stream vuoti quando FlareSolverr Ã¨ configurato** â€” `_fetchStreamViaApi` aveva `return null` fisso dopo il blocco FlareSolverr, impedendo il fallback a axios diretto anche quando `api.kisskh.co` Ã¨ raggiungibile senza CF cookie (verificato: 200 ms 900 via proxy). Ora il flusso Ã¨:
  1. FlareSolverr (max 25 s hard cap via `Promise.race`)
  2. axios diretto con proxy (no cookie, funziona su `api.kisskh.co`)
  3. cookie CF_CLEARANCE_KISSKH (fallback finale)

### Added
- **Debug endpoint `/debug/drammatica`** â€” ispeziona la struttura HTML di drammatica.it per diagnosi selettori.

---

## [1.3.2] â€” 2026-03-05

### Fixed (stream Rama â€” bug critico)
- **`wrapStreamUrl` import mancante in `rama.js`** â€” la funzione era chiamata ma mai importata da `../utils/mediaflow`; causava `ReferenceError` a runtime â†’ tutti i flussi Rama ritornavano `{"streams":[]}` silenziosamente. Ora importata correttamente.
- **Selettore iframe troppo specifico** â€” il selettore `div.episode-player-box iframe` non matchava le pagine episodio di Rama (che usano `.wp-post-content` come wrapper). Sostituito con selettore ampio multi-classe + fallback su qualunque iframe non pubblicitario.
- **URL con spazi non encodati** â€” i file su `streamingrof.online` hanno spazi nel path (es. `In Your Radiant Season - S01E02.mp4`). Il regex `[^"'\s]+` si fermava al primo spazio. Nuovo regex `["'](https://â€¦mp4)["']` e encoding `space â†’ %20`, `[ â†’ %5B`, `] â†’ %5D`.

### Fixed (catalog â€” da commit e6e91e4)
- **Cache vuota propagata a Stremio** â€” catalog con 0 risultati veniva servito con `Cache-Control: max-age=300`; Stremio metteva in cache la risposta vuota del cold-start. Ora `max-age=0` quando `metas.length === 0`.
- **CATALOG_TIMEOUT troppo basso** â€” 9 s non bastava per cold-start Vercel + Cloudflare bypass. Portato a 25 s.
- **Routing catalog Drammatica/Guardaserie** â€” la condizione `rama_catalog || type === 'kdrama'` instradava tutti i catalog `kdrama` a Rama, bypasando Drammatica e Guardaserie. Rimossa la fallback `type` â€” ogni catalog ora usa solo l'ID prefix.

### Added (stream engine â€” da commit 0ca4d57)
- **Guardaserie â€” pattern estrazione episodi da Streamvix** â€” `_extractEpisodes()` ora usa 4 pattern in cascata:
  - A: `data-episode` + `data-url` (layout legacy)
  - B: `id="serie-S_E"` + `data-link` (layout attuale)
  - C: regex raw sull'HTML per `data-link`
  - D: href fallback
- **SuperVideo P,A,C,K deobfuscator** â€” `_resolveSupervideo()` aggiunto a Guardaserie e Drammatica; decodifica embed JavaScript P,A,C,K per estrarre il vero URL HLS/MP4.
- **Multi-hoster shortcircuit Guardaserie** â€” quando gli embed sono giÃ  estratti dagli attributi HTML, `_getStreamsFromEmbeds()` evita un secondo fetch della pagina episodio.

---

## [1.3.1] â€” 2026-03-05

### Fixed (Rama meta enrichment)
- **Trama/Synopsis**: fixed broken selector `div.font-light > div:nth-child(1)` (looked for a child div that doesnâ€™t exist) â†’ now uses `div.font-light.text-spec` where Rama stores the synopsis text directly
- **Generi**: old selector `a[href*="/genere/"]` captured the entire navigation sidebar (50+ genres); now scoped to the specific `li.list-none` row labelled â€œGenere:â€ â†’ returns only the series genres (e.g. Boys Love, Drama, Romance, Sports, Youth)
- **Cast**: replaced three non-working strategies with direct `[data-character] h4` selector that matches Ramaâ€™s actor card grid (e.g. Choi Jae Hyeok, Yeom Min Hyeok)

### Added (Rama meta)
- `imdbRating` field mapped from Ramaâ€™s â€œPunteggio:â€ li item (MyDramaList score, e.g. 8.0)
- `director` field extracted from `a[href*="/regia/"]` links in the â€œRegia:â€ li
- `runtime` field extracted from â€œDurata:â€ li item (e.g. â€œ30 minâ€)
- `country` field extracted from â€œPaese:â€ li item
- Adult content flag emoji ðŸ”ž appended to description when `Valutazione: 18+` is present

---

## [1.3.0] â€” 2026-03-05

### Added
- **Drammatica.it provider** (`drammatica_` ID prefix, `kdrama` type)
  - Catalog with Cloudflare bypass via cloudscraper
  - Multi-strategy card extraction (5 selector patterns)
  - Auto-detection of catalog path (`/drama/`, `/k-drama/`, `/serie/`, `/`)
  - WordPress search endpoint (`/?s=`) for search queries
  - Meta: poster, background, genres, cast, episode list
  - Multi-strategy episode extraction (URL pattern matching + list selectors)
  - Multi-strategy stream extraction (iframe selectors, `<video>`, data-attrs, script scan)
  - Handles DropLoad, Streamtape, SuperVideo, Vixcloud, MaxStream, direct HLS/MP4
  - Stream card: `ðŸš€ Drammatica` Â· `ðŸ‡°ðŸ‡· Sub ITA`
- **Guardaserie provider** (`guardaserie_` ID prefix, `kdrama` type)
  - Mirror auto-detection (guardaserie.re â†’ .fm â†’ .cloud â†’ .cx)
  - Catalog path auto-detection with 4 fallback paths
  - Multi-hoster support: DropLoad, Streamtape, SuperVideo, Vixcloud, MaxStream, DoodStream
  - Per-episode multi-stream extraction (all available hosters shown as separate streams)
  - Hoster label in stream name (e.g. `ðŸš€ Guardaserie [DropLoad]`)
  - Tab/data-attribute scan + script scan for embedded URLs
  - Stream card: `ðŸš€ Guardaserie [Hoster]` Â· `ðŸ‡°ðŸ‡· Sub ITA`
- Both new providers wired into `index.js` aggregator (catalog, meta, stream, IMDB lookup)
- `manifest.json`: 4 catalogs total (`kisskh_catalog`, `rama_catalog`, `drammatica_catalog`, `guardaserie_catalog`)
- `idPrefixes` extended to `["kisskh_", "rama_", "drammatica_", "guardaserie_"]`

### Note
- **Viki (viki.com)** NOT implemented â€” Widevine DRM (L1/L3) + Rakuten subscription required; stream extraction technically/legally not feasible

---

## [1.2.0] â€” 2026-03-05

### Added
- **Config encryption (AES-256-GCM)** â€” `src/utils/config.js` ora cifra il config con AES-256-GCM invece di base64url; proxy URL, MFP key e altri segreti non sono piÃ¹ leggibili in chiaro dalla URL. Imposta `CONFIG_SECRET` env var per personalizzare la chiave. Retrocompatibile con URL base64url esistenti.
- **Timeout middleware globale** â€” `server.js` ora risponde `504 Gateway Timeout` dopo 50s invece di far morire la funzione Vercel senza risposta. Configurabile via `SERVERLESS_TIMEOUT` env var.
- **Auth debug endpoints** â€” `/debug/providers`, `/debug/flaresolverr`, `/debug/browser` ora richiedono `?token=` o header `Authorization: Bearer ...` se `DEBUG_TOKEN` env var Ã¨ impostato (aperto solo in dev).

### Changed
- **Performance: Rama stream fetch parallelo** â€” `getStreams()` ora fetcha tutti gli URL degli episodi in parallelo con `Promise.all` invece di sequenzialmente. Per serie multi-episodio: ~3x piÃ¹ veloce (15s â†’ 5s per 3 ep).
- **Performance: KissKH catalog search a batch** â€” `_searchCatalog()` ora fetcha le pagine in batch paralleli da 3 invece di una a volta. Riduce drasticamente il tempo di ricerca.
- **Stream URL validation** â€” entrambi i provider ora verificano che l'URL inizi con `http` prima di restituirlo; stream malformati vengono scartati con log di warning.
- **Logging stream extraction** â€” Rama ora logga per ogni episodio se lo stream non viene trovato e perchÃ©.

### Fixed
- **Cache LRU off-by-one** â€” `cache.js`: cambio `>=` â†’ `>` nella condizione di eviction; la cache non supera piÃ¹ di 1 unitÃ  il `maxSize`.
- **Season matching** â€” `index.js _matchEpisode()`: la condizione `if (seasonNum)` era falsy per season=0; sostituita con `if (seasonNum !== null && seasonNum !== undefined)`.
- **Dead code rimosso** â€” `kisskh.js`: eliminata `_getSubtitles()` (backward-compat wrapper inutilizzato che poteva lanciare browser superflui).

---

## [1.1.3] â€” 2026-03-05

### Fixed
- **KissKH â€” Cast**: aggiunta chiamata parallela a `GET /api/DramaList/Cast/{id}` in `getMeta()` per ottenere il cast completo con nome e nome del personaggio (`Nome (Personaggio)`); fallback su `data.artists` se l'endpoint non risponde
- **KissKH â€” Episode overview**: mappato il campo `overview` su ogni video da `ep.description`, `ep.overview` o `ep.synopsis` (se presenti nella risposta API)
- **Rama â€” Cast**: rimpiazzato il singolo selettore CSS con 3 strategie progressive:
  1. Link con `href` contenente `/attori/`, `/actor/`, `/cast/`
  2. Parsing testuale di `li.list-none` cercando etichette "Attori:", "Cast:", "Interpreti:" e splittando per virgola/punto e virgola
  3. Elementi con classe contenente `cast` o `actor` come fallback
- **Rama â€” Episode overview**: aggiunto campo `overview` sui video (vuoto per ora, pronto per espansione futura)

---

## [1.1.2] â€” 2026-03-05

### Fixed
- **Rama** â€” `SundefinedEundefined Episodio 1`: il campo `number` nei video Ã¨ stato rinominato in `episode` (campo richiesto da Stremio per mostrare `S1E1`)
- **Rama** â€” aggiunto campo `background` (OG image dalla pagina, fallback al poster)
- **Rama** â€” aggiunta estrazione `genres` e `cast` dallo scraping HTML
- **Rama** â€” data di rilascio episodi non piÃ¹ epoca Unix (1970): usa l'anno della serie
- **Rama** â€” thumbnail episodi ora usa l'immagine dello slide del swiper con fallback al poster
- **KissKH** â€” aggiunto campo `background` (thumbnail della serie)
- **KissKH** â€” aggiunto mapping `genres` da `data.genres`/`data.subCategory` (se presenti nella risposta API)
- **KissKH** â€” aggiunto mapping `cast` da `data.artists` (se presente nella risposta API)
- **KissKH** â€” thumbnail episodi ora usa `ep.thumbnail` con fallback a `data.thumbnail`

---

## [1.1.1] â€” 2026-03-05

### Fixed
- **Rama** â€” titolo troncato in Stremio: rimosso l'anno `(YYYY)` da `meta.name` nella riga descrizione (rimane nel meta, non nella card dello stream)
- **Rama** â€” flag corretto da ðŸ‡®ðŸ‡¹ a ðŸ‡°ðŸ‡·: il contenuto Ã¨ coreano con sottotitoli italiani, non italiano
- **KissKH** â€” stessa pulizia anno da `seriesTitle` nella descrizione stream
- Aggiunto `Sub ITA` in terza riga per entrambi i provider, al posto del solo flag

---

## [1.1.0] â€” 2026-03-05

### Changed
- **Stream display format** â€” entrambi i provider ora espongono le informazioni dello stream in un formato visivo unificato e leggibile su Stremio:
  - `name` â†’ emoji + nome provider (es. `ðŸš€ KissKH`, `ðŸš€ Rama`)
  - `description` â†’ 3 righe: `ðŸ“ Titolo serie - Episodio`, `ðŸ‘¤ Sorgente`, `ðŸ‡°ðŸ‡·` / `ðŸ‡®ðŸ‡¹`
  - Rimosso campo `title` (sostituito da `description` multi-riga)
- `src/providers/kisskh.js` â€” aggiunta chiamata `getMeta()` (istantanea via cache) in `getStreams()` per recuperare il titolo della serie da mostrare nella descrizione
- `src/providers/rama.js` â€” usato `meta.name` giÃ  disponibile in `getStreams()` per la stessa finalitÃ 
- `src/utils/cloudflare.js` â€” rimosso percorso FlareSolverr+proxy per il recupero del cookie `cf_clearance` (semplificazione, il path Puppeteer diretto Ã¨ sufficiente); rimossa dipendenza `flareSolverrGetCookies`

---

## [1.0.3] â€” 2026-03-04

### Fixed
- `vercel.json` â€” added `api/index.js` wrapper to satisfy Vercel `builds` convention
- `vercel.json` â€” reverted to `builds`-only format (no `functions` block, no conflict)
- Memory limit adjusted to comply with Hobby plan (1024 MB cap)

---

## [1.0.2] â€” 2026-03-04

### Fixed
- `vercel.json` â€” removed `builds` + `functions` conflict; switched to `functions`-only format

---

## [1.0.1] â€” 2026-03-04

### Added
- `src/utils/browser.js` â€” unified Puppeteer launcher with `@sparticuz/chromium` for serverless
  (auto-detects Vercel/Lambda, custom path, or local Chrome)
- `api/index.js` â€” Vercel serverless entry point (thin wrapper over `server.js`)

### Changed
- `package.json` â€” replaced `puppeteer` with `puppeteer-core` + `@sparticuz/chromium`
- `src/utils/cloudflare.js` â€” uses shared `launchBrowser()` instead of inline Puppeteer launch
- `src/providers/kisskh.js` â€” uses shared `launchBrowser()`, removes redundant `_launchBrowser()`
- `vercel.json` â€” `builds` pointing to `api/index.js`, no more conflict
- `.vercelignore` â€” added to reduce deploy bundle size

---

## [1.0.0] â€” 2026-03-04

### Added
- Initial release of StreamFusion Mail
- **KissKH provider** (`kisskh_*` IDs)
  - API-based catalog and meta retrieval from `kisskh.co`
  - Puppeteer + stealth stream extraction (intercepts `.m3u8` with `v` param)
  - Italian subtitle decryption (AES-128-CBC, 3 key rotation)
  - Automatic Cloudflare bypass via `cf_clearance` cookie persistence
- **Rama Oriental Fansub provider** (`rama_*` IDs)
  - Cloudscraper-based catalog scraping from `ramaorientalfansub.live`
  - Series meta parsing (poster, description, status, episode count, year)
  - Episode stream extraction (iframe, `<video>`, direct link, regex fallback)
- **Aggregator** (`src/providers/index.js`)
  - ID-prefix based routing (zero ambiguity)
  - `Promise.allSettled` parallel execution with configurable timeouts
  - URL-level stream deduplication
  - Automatic fallback for unknown ID prefixes
- **Utilities**
  - `TTLCache` â€” in-memory LRU cache with configurable TTL and max size
  - `fetchWithCloudscraper` / `fetchWithAxios` â€” shared HTTP layer with retries
  - `getCloudflareCookie` â€” Puppeteer-based CF bypass with disk persistence
  - `decryptKisskhSubtitleFull` / `decryptKisskhSubtitleStatic` â€” subtitle decryption
  - `titleSimilarity` / `cleanTitleForSearch` / `extractBaseSlug` â€” title helpers
  - Structured JSON logger (production) / human-readable (development)
- **Server** (`server.js`)
  - Express + `stremio-addon-sdk` router
  - CORS headers for all Stremio clients
  - HTML landing page with direct install buttons
  - `/health` endpoint for uptime monitoring
  - Dual mode: `node server.js` (local) or `module.exports` (Vercel)
- **Deploy**
  - `vercel.json` â€” Vercel serverless (Node 18+)
  - `.env.example` â€” documented environment variables
  - `.gitignore` â€” excludes secrets, data, and build artifacts

---

## [3.0.17] - 2026-03-08

### Changed
- Release sync automatica: README, dashboard addon e smoke test remoto Vercel allineati.

---
## [3.0.14] - 2026-03-08

### Changed
- Il bridge IMDb/Cinemeta verso EasyStreams passa ora anche `primaryTitle` e `titleCandidates` ai resolver downstream.
- `Guardaserie` e `Guardoserie` usano questi titoli alternativi nel fallback search, migliorando i match su serie dove il nome Cinemeta/TMDB non coincide con quello usato dal mirror italiano.

---
## [3.0.13] - 2026-03-08

### Fixed
- Le installazioni configurate hanno ora sempre un `manifest.id` distinto dal manifest base, anche quando la config coincide con i default. Questo evita collisioni tra addon base e addon configurato in Stremio Web.
- Le route `/install/vX.Y.Z`, `/install/vX.Y.Z/configure` e le varianti `/:config/install/vX.Y.Z/...` ora servono correttamente la landing/config page. Il pulsante Configure di Stremio non cade piu su `404`.

---
## [3.0.12] - 2026-03-08

### Changed
- Il formatter proxy ora anche gli stream HLS/non-MP4 senza header custom quando `addonBaseUrl` e disponibile, invece di lasciare molti mirror EasyStreams come `notWebReady`.
- Questo rende web-ready anche i `Guardaserie - SuperVideo` gia estratti correttamente dal backend.

---
## [3.0.11] - 2026-03-08

### Changed
- L'extractor `SuperVideo` prova ora anche un fallback Browserless dopo `fetch` e `cloudscraper`, sfruttando `BROWSERLESS_URL` gia configurato su Vercel.
- Questo serve in particolare quando il mirror EasyStreams arriva fino a `SuperVideo`, ma Cloudflare blocca sia il fetch diretto sia il parsing server-side semplice.

---
## [3.0.10] - 2026-03-08

### Changed
- L'extractor `SuperVideo` riprova ora con `cloudscraper` quando il fetch diretto prende `403/Cloudflare`, invece di scartare subito il mirror.
- Il contesto provider passa anche `proxyUrl` agli extractor, cosi i mirror EasyStreams possono usare il proxy configurato dall'utente anche nel passo host-specific.

---
## [3.0.9] - 2026-03-08

### Changed
- Il parser `Guardaserie` ora legge anche i blocchi episodio `serie-<stagione>_<episodio>` e raccoglie tutti i `data-link` del `<li>` episodio, invece di dipendere solo da `data-num` e dal primo `div.mirrors`.
- Questo riallinea meglio il comportamento EasyStreams sui titoli come `Mare Fuori 6x6`, dove `Guardaserie - SuperVideo` non veniva restituito.

---
## [3.0.8] - 2026-03-07

### Changed
- I manifest configurati usano ora un `id` stabile ma diverso dal manifest base, cosi Stremio non confonde installazioni personalizzate, installazioni base e versioni vecchie ancora presenti.
- I manifest configurati espongono anche il nome `Nello Drama Config`, cosi risultano visibili e distinguibili nella UI addon di Stremio.

---
## [3.0.7] - 2026-03-07

### Changed
- Gli endpoint `/stream/...` non vengono piu messi in cache su Vercel, cosi Stremio non puo riutilizzare risposte stale o URL HLS gia scaduti.
- Aggiunto log strutturato `stream response` con `count` e `webReady` per diagnosticare subito cosa restituisce il backend a ogni richiesta stream.
- Lo smoke test remoto verifica anche che le risposte stream espongano `Cache-Control: no-store`.

---
## [3.0.6] - 2026-03-07

### Added
- Nuovo path di installazione versionato `/install/v3.0.6/manifest.json` per forzare il refresh del transport URL in Stremio quando il manifest precedente resta in cache.

### Changed
- Le route `manifest`, `catalog`, `meta` e `stream` accettano ora anche il prefisso `/install/vX.Y.Z/...` senza rompere i path legacy.
- La landing `/configure` genera ora di default il link install versionato, cosi un reinstall usa un URL nuovo invece del manifest gia cachato dal client.
- Lo smoke test remoto Vercel verifica anche il manifest e lo stream sul path di installazione versionato.
- `update-all.js` sincronizza automaticamente anche i link `/install/vX.Y.Z/manifest.json` in README e dashboard ad ogni release.

---
## [3.0.5] - 2026-03-07

### Fixed
- Rafforzato il layer extractor condiviso dei provider EasyStreams con helper PAC.KER centralizzati e fallback piu tolleranti per `MixDrop`, `DropLoad`, `SuperVideo`, `Upstream` e `VixCloud`.
- `VixCloud` ora ricostruisce anche le varianti `masterPlaylist` viste nei resolver di riferimento, migliorando il recupero degli HLS da embed/script diversi.
- I provider EasyStreams che ricevono `addonBaseUrl` normalizzano ora i flussi HLS/headered verso un playback piu compatibile con Stremio Web, invece di lasciarli nascosti come `notWebReady` quando il proxy interno puo gestirli.
- Il formatter non penalizza piu i link MP4 diretti solo per la presenza di header opzionali, riducendo i casi di stream invisibili nella UI web.

### Changed
- Aggiunto dispatch centralizzato `extractFromUrl(...)` per riusare il registry extractor nei provider italiani e ridurre parsing host-specific duplicato.
- Lo smoke test remoto Vercel verifica ora anche che il `manifest` pubblico continui a esporre gli stream IMDb/Cinemeta di default.

---
## Unreleased

_Next planned improvements:_

- [ ] TMDB poster/backdrop enrichment for Rama series
- [ ] Episode thumbnail caching layer
- [ ] Rate-limiting middleware
- [ ] GitHub Actions workflow for semver bump + GitHub Release on push

---

## [3.0.4] - 2026-03-07

### Fixed
- Il `manifest` base ora abilita Cinemeta/IMDb di default, quindi Stremio Web interroga anche i provider EasyStreams su ID `tt*` senza richiedere una URL addon configurata.
- Allineato `DEFAULT_CONFIG.cinemeta` con la landing `/configure`, che gia proponeva Cinemeta come opzione predefinita consigliata.

---

## [3.0.3] - 2026-03-07

### Fixed
- `StreamingCommunity` ora converte gli stream HLS con header obbligatori in URL proxati dall'addon, cosi Stremio Web non li scarta piu come `notWebReady`.
- Aggiunto proxy HLS interno con token firmati e rewrite di playlist, segmenti e chiavi HLS per supportare la riproduzione web senza esporre header custom al client.
- Lo smoke test remoto Vercel puo ora fallire anche su stream non web-ready quando `VERCEL_SMOKE_REQUIRE_WEB_READY=1`.

---

## [3.0.2] - 2026-03-07

### Fixed
- `StreamingCommunity` ora tratta `series` come alias di `tv`, quindi le richieste Cinemeta/Stremio per serie TV italiane non vengono piÃ¹ scartate a vuoto.
- Ripristinato il caso `Mare Fuori` (`tt6864602:6:3`), che ora restituisce stream video dal provider EasyStreams `StreamingCommunity`.

---

## [3.0.1] - 2026-03-07

### Changed
- Release sync automatica: README, dashboard addon e smoke test remoto Vercel allineati.

---
## [3.0.0] - 2026-03-07

### Changed
- Release sync automatica: README, dashboard addon e smoke test remoto Vercel allineati.

---


dummy
