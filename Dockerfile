FROM node:18-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 \
      libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 \
      libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 \
      libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
      libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
      ca-certificates dumb-init wget tar && rm -rf /var/lib/apt/lists/*

RUN wget -O /tmp/wireproxy.tar.gz https://github.com/pufferffish/wireproxy/releases/download/v1.0.8/wireproxy_linux_amd64.tar.gz \
    && tar -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin \
    && rm /tmp/wireproxy.tar.gz \
    && chmod +x /usr/local/bin/wireproxy

RUN useradd -m -u 1000 user && mkdir -p /app/data /app/cache && chown -R user:user /app

USER user
WORKDIR /app

COPY --chown=user:user package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY --chown=user:user . .
RUN chmod +x /app/start.sh && sed -i 's/\r$//' /app/start.sh

ENV NODE_ENV=production \
    PORT=7860 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-gpu"

EXPOSE 7860

ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/start.sh"]
