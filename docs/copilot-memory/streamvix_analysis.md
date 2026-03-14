# StreamVix Full Analysis (2026-03-12)

## Key Architecture Patterns

### MFP (MediaFlow Proxy) Integration
- **Mixdrop/Streamtape**: Use `/extractor/video?host=Mixdrop&d=EMBED_URL&redirect_stream=true&api_password=PSW`
- **Uqload**: Same `/extractor/video?host=Uqload&d=URL&redirect_stream=true`
- **LoadM (HLS)**: Use `/proxy/hls/manifest.m3u8?d=HLS_URL&api_password=PSW&h_Referer=...&h_Origin=...`
- **Direct MP4**: Use `/proxy/stream/FILENAME?d=MP4_URL&api_password=PSW`

### CB01 Strategy
- MixDrop-only provider
- Stayonline bypass via POST to `stayonline.pro/ajax/linkEmbedView.php`
- Does NOT resolve MixDrop JS locally — delegates to MFP `/extractor/video`
- Proxy retry chain: Direct → PROXY → DLHD_PROXY
- Domain auto-detection via redirect from `cb01official.uno`

### SuperVideo Strategy
- Direct p.a.c.k.e.r JS unpacking locally (no MFP needed)
- CF Worker proxy support via CF_PROXY_URL env var
- Forces `supervideo.tv` domain with `/e/ID` embed format
- Extracts `sources:[{file:"URL"}]` from unpacked JS

### Guardoserie Strategy
- Uses LoadM + Uqload extractors (NOT MixDrop)
- LoadM: AES-128-CBC decryption (key: kiemtienmua911ca, iv: 1234567890oiuytr)
- Proxy: direct first, then PROXY env var on network errors
- Dynamic nonce from homepage for AJAX calls

### Key Domain Config
- guardoserie: guardoserie.surf
- guardahd: mostraguarda.stream
- guardaserie: guardaserietv.autos
- guardaflix: guardaplay.space
- cb01: cb01net.lol (auto-detected via redirect)
