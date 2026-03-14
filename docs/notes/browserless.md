# Browserless.io

**Codice:** `src/utils/browser.js`  
**Stato:** Usato come fallback browser remoto

## Uso
- Chrome remoto via WebSocket per CF bypass
- Usato quando Puppeteer locale non è disponibile o fallisce
- Connection URL: `wss://production-sfo.browserless.io?token=...`

## Variabili Env
- `BROWSERLESS_URL` — WebSocket URL completo con token

## Note
- Piano a pagamento (minuti limitati)
- Latenza più alta rispetto a chromium locale
- Usato principalmente per test e debug, Vercel usa `@sparticuz/chromium`
