# Reference Projects & Links

## StreamVix
- **GitHub**: https://github.com/qwertyuiop8899/streamvix/releases
- **Live**: https://streamvix.hayd.uk
- **Notes**: All providers work without MediaFlow EXCEPT CB01, ToonItalia, and some AnimeUnity/AnimeSaturn streams. TypeScript-based. Has `buildUnifiedStreamName` in `src/utils/unifiedNames.ts`.

## EasyStreams
- **GitHub**: https://github.com/realbestia1/easystreams
- **Live**: https://easystreams.stremio.dpdns.org
- **Notes**: Original easystreams project. JavaScript.

## MammaMia
- **GitHub**: https://github.com/UrloMythus/MammaMia
- **Live VPN**: https://mammamia.stremio.dpdns.org/
- **Uprot captcha page**: https://mammamia.stremio.dpdns.org/uprot (manual captcha for MaxStream links, valid 24h)
- **Notes**: Python-based. Has `Src/API/` with provider modules. `update_domains.py` for domain updates.

## BaciAsiatici (KissKH)
- **GitHub**: https://github.com/vitouchiha/baciasiatici
- **Notes**: Dedicated KissKH addon. JavaScript. Has its own sub_decrypter for subtitles.

## MediaFlow Proxy (MFP)
- **User's instance**: https://easy.koyeb.app/
- **Purpose**: Proxy for extracting video URLs from sites like MixDrop, SuperVideo, etc.
- **Endpoint**: `/extractor` for resolving embed URLs to direct video links

## NelloStream (Our Addon)
- **GitHub**: https://github.com/vitouchiha/streamfusion-mail
- **Live**: https://streamfusion-mail.vercel.app
- **Hosting**: Vercel (fra1 region)
- **Key env vars**: PROXY_URL (WebShare), WEBSHARE_PROXIES, TMDB_API_KEY, MFP_URL, MFP_API_PASSWORD
