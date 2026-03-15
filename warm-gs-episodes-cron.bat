@echo off
REM ── warm-gs-episodes-cron.bat ──────────────────────────────────────────────
REM Scheduled task: warm guardoserie episode cache + auto-deploy
REM
REM Scedula con Task Scheduler:
REM   Programma: C:\Users\vitob\Desktop\bot telegram\Streaming Koreano\StreamFusionMail\warm-gs-episodes-cron.bat
REM   Avvia in:  C:\Users\vitob\Desktop\bot telegram\Streaming Koreano\StreamFusionMail
REM   Attivazione: Giornaliero alle 05:00 (o orario preferito)
REM

cd /d "C:\Users\vitob\Desktop\bot telegram\Streaming Koreano\StreamFusionMail"

echo [%date% %time%] Starting warm-gs-episodes...
node warm-gs-episodes.js --continue --deploy >> gs-warm-cron.log 2>&1
echo [%date% %time%] Done. >> gs-warm-cron.log 2>&1
