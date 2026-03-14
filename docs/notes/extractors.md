# Estrattori Video

## MixDrop
**Codice:** `src/extractors/mixdrop.js`  
Unpacker JavaScript → URL diretto MP4. Usato da: CB01, GuardaHD, Loonex, EuroStreaming.

## SuperVideo
**Codice:** `src/extractors/supervideo.js`  
Packed JS → `supervideo.cc` → `serversicuro.cc` HLS manifest con token. Usato da: GuardaSerie.
Richiede token `i=0.0` nel manifest URL, altrimenti 403.

## Turbovid / DeltaBit
**Codice:** `src/extractors/turbovidda.js`  
Proxy via CF Worker `es_stream` endpoint → 302 redirect a MP4. Usato da: EuroStreaming.

## Common
**Codice:** `src/extractors/common.js`  
Utility condivise tra estrattori (fetch con proxy, header management).
