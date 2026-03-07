# StreamFusion Mail

<!-- release:meta:start -->
- Release: `v3.0.6`
- Date: `2026-03-07`
- Remote smoke target: `https://streamfusion-mail.vercel.app`
<!-- release:meta:end -->

Addon Stremio per drama asiatici e coreani con cataloghi KissKH e Rama, metadata arricchiti e deploy pensato per Vercel.

## Features

- Cataloghi Stremio da KissKH e Rama.
- Supporto Cinemeta / IMDb per risolvere stream da ID `tt*`.
- Layer extractor condiviso per host italiani (`MixDrop`, `DropLoad`, `SuperVideo`, `VixCloud`, `Loadm`) con fallback piu robusti.
- Metadata arricchiti via TMDB quando la chiave e configurata.
- Supporto proxy HTTP, FlareSolverr e MediaFlow Proxy.
- Proxy HLS interno per rendere web-ready gli stream headered/HLS su Stremio Web quando il playback passa dall'addon.
- Dashboard addon servita da `/dashboard`.

## Deploy

Deploy rapido su Vercel:

1. importa il repository su Vercel
2. imposta le env necessarie
3. pubblica il progetto
4. apri `https://<tuo-deploy>.vercel.app/configure`

Il link di installazione consigliato usa ora un path versionato:

```text
https://<tuo-deploy>.vercel.app/install/v3.0.6/manifest.json
```

Questo forza Stremio a scaricare un transport URL nuovo quando serve invalidare la cache del manifest.

Env utili:

- `PROXY_URL`: proxy HTTP/SOCKS per catalog e metadata
- `FLARESOLVERR_URL`: endpoint FlareSolverr
- `TMDB_API_KEY`: chiave TMDB globale
- `VERCEL_BASE_URL`: URL pubblico del deploy usato dallo smoke test remoto
- `VERCEL_SMOKE_STREAM_ID`: opzionale, abilita un controllo remoto anche su un endpoint `/stream/...`
- `VERCEL_SMOKE_REQUIRE_WEB_READY`: se impostato, lo smoke remoto richiede almeno uno stream `notWebReady !== true`

## Workflow

Per ogni aggiornamento:

1. applica le modifiche al codice
2. esegui `npm run release`

`npm run release` fa questo:

- aggiorna metadata release in `README.md`
- aggiorna la dashboard in `web/landing/index.html`
- aggiunge l'entry mancante in `CHANGELOG.md`
- esegue lo smoke test remoto sul deploy Vercel
- verifica anche che il `manifest` remoto continui a esporre gli stream IMDb/Cinemeta di default
- puo verificare anche la web-readiness del titolo di smoke se `VERCEL_SMOKE_REQUIRE_WEB_READY=1`

Nel mio workflow operativo, dopo ogni modifica faccio anche commit e push su GitHub.

## Test remoti

Per eseguire solo i controlli sul deploy:

```bash
npm run test:vercel
```

Se il deploy pubblico non e `https://streamfusion-mail.vercel.app`, usa:

```bash
VERCEL_BASE_URL=https://tuo-addon.vercel.app npm run test:vercel
```

## Note operative

- I test locali non sono il percorso preferito per il rilascio: la validazione va fatta sul deploy Vercel.
- La landing addon `/configure` usa `manifest.json` a runtime, quindi la versione mostrata segue il manifest corrente.
- La landing `/configure` genera un URL install versionato `/install/vX.Y.Z/manifest.json` per ridurre i problemi di cache lato Stremio.
- Il `manifest` base espone Cinemeta/IMDb di default, quindi gli stream EasyStreams su ID `tt*` funzionano anche senza URL configurata.
