# Dockerfile
FROM node:20-alpine

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Copiamos package primero para cache
COPY package*.json ./

# ✅ Instalación más tolerante (evita fallo por lock)
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# Permisos para guardar auth
RUN mkdir -p /app/auth && chown -R app:app /app

USER app

EXPOSE 3030
CMD ["node", "app.js"]