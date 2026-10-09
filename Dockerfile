# Dockerfile ultra-optimizado para Railway - Node 20 Bookworm Slim
# Configurado para consumo mínimo de RAM/CPU (< 300MB RAM, < 0.25 vCPU)
FROM node:20-bookworm-slim

# Instalar Chromium del sistema, dependencias mínimas y tini como supervisor de procesos zombi
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    procps \
    tini \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Configurar Puppeteer para usar Chromium del sistema sin descargas pesadas
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Limitar memoria de Node.js a 256MB y habilitar garbage collection manual
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256 --expose-gc"

WORKDIR /app

# Copiar package.json e instalar solo dependencias de producción
COPY package.json ./
RUN npm install --omit=dev

# Copiar el código fuente
COPY . .

EXPOSE 3000

# tini se ejecuta como PID 1 para matar automáticamente procesos huérfanos de Chromium
ENTRYPOINT ["tini", "--"]
CMD ["node", "--max-old-space-size=256", "--expose-gc", "wa_bridge.js"]
