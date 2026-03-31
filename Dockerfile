# Dockerfile optimizado para Railway - Debian Bookworm
FROM node:18-slim

# Instalar dependencias esenciales para Chromium en Debian Bookworm
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configurar variables para que Puppeteer use el Chromium del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiar y cargar dependencias
COPY package.json ./
RUN npm install

# Copiar el resto del código
COPY . .

# Railway usa el puerto de la variable de entorno
EXPOSE 3000

CMD ["npm", "start"]
