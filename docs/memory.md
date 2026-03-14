# Nello Stream — Memory / Changelog Compatto

**Ultimo aggiornamento:** 2026-03-14  
**Versione corrente:** 3.0.59

---

## Timeline Versioni Chiave

| Versione | Data | Cambiamenti |
|----------|------|-------------|
| 3.0.59 | 2026-03-14 | Smart proxy rotation + browser fallback MaxStream. Commit `149bcc9` |
| 3.0.56 | 2026-03-14 | Fix uprot `/msei/` episode links (captcha token-based, 4 digit) |
| 3.0.55 | 2026-03-14 | Uprot captcha auto-solving + MaxStream streams completi |
| 3.0.50 | 2026-03-13 | Fix AnimeSaturn S1 related path leak + AnimeUnity CF fallback |
| 3.0.48 | 2026-03-13 | Season-specific anime resolution (Fribb `season.tvdb`) |
| 3.0.44 | 2026-03-13 | Anime mapping internalizzato (Fribb offline, 41k entries) |
| 3.0.41 | 2026-03-13 | EuroStreaming batch cache + auto-refresh |
| 3.0.37 | 2026-03-10 | EuroStreaming fix completo (CF Worker KV 3-layer cache) |
| 3.0.xx | 2026-03-10 | GuardaSerie SuperVideo fix, timeout tuning |
| 1.0.0 | — | Release iniziale |

---

## Problemi Risolti Recenti

### MaxStream/Uprot (v3.0.55-59)
- Captcha uprot auto-solve: segmentazione per digit → CF Worker AI OCR
- 3 tipi di link uprot: DECOY (URL statico morto), HONEYPOT (`display:none`), REALE (button `#buttok`)
- Cookie pinning: PHPSESSID legato a IP creatore → serve stesso IP per bypass
- Proxy rotating inaffidabile → smart proxy con fallback a tutti gli IP statici
- Browser fallback Puppeteer+stealth per Cloudflare 503/403

### EuroStreaming (v3.0.37-41)
- CF Bot Fight Mode blocca tutti gli IP datacenter
- Soluzione: CF Worker edge + KV cache + batch warming locale

### Anime (v3.0.42-50)
- Mapping API esterna → internalizzata con Fribb anime-lists (41k entries)
- Fix season threading, AnimeSaturn related path leak, AnimeUnity CF blocking

---

## Lezioni Importanti

- **Stremio Metadata**: Mai includere campi opzionali vuoti (`""`) → Stremio droppa l'intero oggetto
- **`.vercelignore`**: Pattern `cache/` esclude anche `src/cache/` → usare `/cache/`
- **Cloudflare Bot Fight**: Blocca TUTTI gli IP cloud per siti italiani. CF Worker NON bypassa (stesso edge)
- **uprot.net**: Ritorna 403 a IP CF Worker → fetch SOLO da Vercel/locale
- **Proxy WebShare**: Solo `64.137.96.74` funziona per TUTTI i path uprot (/msf/, /msfi/, /emvvv/)
- **Vercel Hobby**: Max 60s per funzione, deploy giornalieri limitati
