# Vercel

**URL:** `streamfusion-mail.vercel.app`  
**Config:** `vercel.json`  
**Regione:** fra1 (Frankfurt)  
**Piano:** Hobby (gratuito)

## Limiti Piano Hobby
- **maxDuration:** 60s per funzione serverless
- **Deploy giornalieri:** Limitati (può bloccare `npx vercel --prod`)
- **Bandwidth:** Limitata

## Variabili Env (impostate su Vercel Dashboard)
- `PROXY_URL` — Proxy residenziale (attualmente IP statico WebShare)
- `CF_WORKER_URL` — URL Cloudflare Worker
- `CF_WORKER_AUTH` — Token auth CF Worker
- `BROWSERLESS_URL` — WebSocket URL Browserless.io
- `WEBSHARE_PROXIES` — Lista IP statici proxy
- `CRON_SECRET` — Segreto per endpoint cron
- `DEBUG_TOKEN` — Token per endpoint debug

## Entry Point
- `api/index.js` → importa `server.js` (Express app)

## Deploy
```bash
npx vercel --prod
# oppure git push (auto-deploy)
```

## Note
- Node.js v22.16.0 in produzione
- `.vercelignore` pattern `cache/` esclude anche `src/cache/` → usare `/cache/`
- Il cron Hobby ha limitazioni → warming cookies va fatto localmente
