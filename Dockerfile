# Dockerfile
FROM node:20-alpine

# Mejor práctica: crear usuario no-root
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copiamos primero package para cache de dependencias
COPY package*.json ./

# Instalar dependencias (prod)
RUN npm ci --omit=dev

# Copiar el resto del código
COPY . .

# Permisos para guardar auth
RUN mkdir -p /app/auth && chown -R app:app /app

USER app

# Puerto (tu app usa process.env.PORT)
EXPOSE 3030

# Ejecutar
CMD ["node", "app.js"]