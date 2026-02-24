FROM node:20-alpine

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY package*.json ./

# ✅ No depende de package-lock (evita el error de npm ci)
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/auth && chown -R app:app /app
USER app

EXPOSE 3030
CMD ["node", "app.js"]