# WebShare Proxy

**Sito:** https://proxy.webshare.io  
**Config:** `PROXY_URL`, `WEBSHARE_PROXIES`, `proxies.json`

## Setup
- Piano: 10 IP statici residenziali
- Credenziali: `gmcimwlz:fyegql9qqbxh` (tutte le IP)
- Porta: `6641`

## IP Statici e Compatibilità (testato 2026-03-14)

| IP | uprot /msf/ | uprot /msfi/ | maxstream /emvvv/ | Note |
|----|-------------|--------------|-------------------|------|
| `64.137.96.74` | ✅ | ✅ | ✅ | **UNICO funzionante per tutti i path** |
| `198.105.121.200` | ❌ | ✅ | ✅ | Non funziona per /msf/ |
| `142.111.67.146` | ❌ | ✅ | ✅ | Non funziona per /msf/ |
| (altri 7 IP) | ❌ | ❌/⚠️ | ❌/⚠️ | Bloccati da CF |

## Configurazione Corrente
- **Vercel `PROXY_URL`:** `http://gmcimwlz:fyegql9qqbxh@64.137.96.74:6641` (statico)
- **`proxies.json`:** Contiene tutti e 10 gli IP per smart rotation
- **Smart proxy** (`src/utils/proxy.js`): Tenta PROXY_URL → cicla tutti gli IP

## Proxy Rotating (NON usato in produzione)
- URL: `http://sdfmtjis-rotate:y7hpwm1hw1km@p.webshare.io:80`
- Problema: Assegna IP random → solo 1-3/10 funzionano per uprot
- Sostituito con IP statico in v3.0.59

## Note
- Cookie uprot legati a IP creatore → usare SEMPRE stesso IP per bypass e fetch
- CF blocca la maggior parte degli IP datacenter per siti italiani
- L'ordine di prova nello smart proxy: cached → PROXY_URL → tutti da proxies.json → diretto
