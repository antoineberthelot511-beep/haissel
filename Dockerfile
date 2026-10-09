FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production

USER node

EXPOSE 3000

# Applique les migrations (idempotentes) puis démarre le serveur.
CMD ["sh", "-c", "node scripts/migrate.js && exec node src/app.js"]
