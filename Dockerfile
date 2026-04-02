# Dockerfile optimizado para Railway - Node 18 Bullseye
FROM node:18-bullseye-slim

# Instalar Chromium y dependencias
RUN apt-get update && apt-get install -y \
    chromium \
    libxss1 \
    ca-certificates \
    procps \
    git \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configurar Puppeteer para usar Chromium del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
