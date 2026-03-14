# Copilot Memory Files — Indice e Analisi

Questi file sono stati importati dalla cartella di workspace storage di VS Code (`GitHub.copilot-chat/memory-tool/memories/`).
Contengono le note e le analisi accumulate durante lo sviluppo del progetto StreamFusionMail.

**Data importazione:** 2026-03-14

---

## Indice dei File

### Analisi Provider

| File | Descrizione |
|------|-------------|
| [animeunity_investigation.md](animeunity_investigation.md) | Deep-dive nel flusso `getStreams()` di AnimeUnity — bug di season handling con Kitsu |
| [anime_mapping_issue_analysis.md](anime_mapping_issue_analysis.md) | Perché AnimeWorld/AnimeSaturn/AnimeUnity davano risultati vuoti — `searchAnimeUnity()` hardcoded a `[]` |
| [cb01_research_findings.md](cb01_research_findings.md) | Flusso CB01 completo: search → stayonline.pro → MixDrop/MaxStream/Uprot |
| [guardaserie_investigation.md](guardaserie_investigation.md) | Bug "Frieren 1x7" invece di S2E7 — analisi HTML parsing |
| [guardoserie_complete_exploration.md](guardoserie_complete_exploration.md) | Architettura GuardoSerie + Eurostreaming — caching KV 2-phase |
| [frieren_bug_investigation.md](frieren_bug_investigation.md) | Trace completo Frieren S2E7 — bug season leak + AnimeUnity missing |
| [mammamia_vs_streamfusionmail_deltabit.md](mammamia_vs_streamfusionmail_deltabit.md) | Confronto MammaMia (Python) vs StreamFusionMail — captcha, cookies, Turbovid |
| [streamvix_analysis.md](streamvix_analysis.md) | Architettura StreamVix — MediaFlow Proxy, CB01, SuperVideo, Guardoserie |
| [tmp_easystreams_analysis.md](tmp_easystreams_analysis.md) | Architettura EasyStreams — sistema ID→Path puro, nessuna search |
| [uprot_maxstream_captcha_complete_analysis.md](uprot_maxstream_captcha_complete_analysis.md) | Analisi completa captcha uprot: MammaMia vs StreamFusionMail |

### Architettura e Sistema

| File | Descrizione |
|------|-------------|
| [cache_mechanism_research.md](cache_mechanism_research.md) | Due layer di cache: LRU in-memory + per-provider TTL |
| [domain_resolution_architecture.md](domain_resolution_architecture.md) | Risoluzione domini: hybrid local+remote con GitHub auto-fetch |
| [mapping_api_analysis.md](mapping_api_analysis.md) | API mapping anime esterna → internalizzata v3.0.42+ |
| [provider_analysis.md](provider_analysis.md) | KissKH, GuardaFlix, MixDrop — API keys, nonce, extraction |
| [thorough_audit_findings.md](thorough_audit_findings.md) | Audit critico: episode param MAI passato ai callers del mapping |

### Repository Notes

| File | Descrizione |
|------|-------------|
| [repo_conventions.md](repo_conventions.md) | Convenzioni progetto: version bump obbligatorio su manifest.json |
| [repo_provider-disaster-recovery.md](repo_provider-disaster-recovery.md) | Guida disaster recovery per tutti i provider |
| [repo_reference-projects.md](repo_reference-projects.md) | Progetti di riferimento: EasyStreams, StreamVix, MammaMia, BaciAsiatici |
| [repo_streamfusion-mail-notes.md](repo_streamfusion-mail-notes.md) | Log cronologico completo del progetto (2026-03-06 → 2026-03-14) |

---

## Stato Provider (Riepilogo)

| Provider | Stato | Note |
|----------|-------|------|
| **StreamingCommunity** | ✅ Funzionante | Pure HTTP, VixCloud, 14s timeout |
| **EuroStreaming** | ✅ Funzionante | 3-layer cache, CF Worker edge |
| **GuardaSerie** | ✅ Funzionante (~20s) | SuperVideo cascade, `i=0.0` tokens |
| **CB01** | ✅ Funzionante | MixDrop ok, Uprot auto-solve v3.0.55+ |
| **Anime (Unity/World/Saturn)** | ✅ Funzionante (v3.0.50+) | Mapping internalizzato, language fix |
| **GuardoSerie** | ⚠️ Solo cached | CF Bot Fight blocca cloud IPs → KV cache da PC italiano |
| **KissKH** | ⚠️ Fragile | API keys statiche, 45s browser timeout |
| **GuardaFlix** | ⚠️ Fragile | Nonce hardcoded, year matching troppo stretto |

---

## Issues Aperti

1. **MaxStream su Vercel** — `_bypassUprot` carica cookies KV ma il redirect non trova URL nella risposta
2. **GuardoSerie** — 0 streams da cloud, serve priming KV da PC italiano
3. **KissKH** — API keys vanno ruotate periodicamente
4. **GuardaFlix** — Nonce `20115729b4` potrebbe scadere
5. **KV write budget** — Free tier 1,000 writes/day, monitorare attentamente
6. **Versione in repo_conventions.md** — Mostra 3.0.27, progetto è a 3.0.58+
