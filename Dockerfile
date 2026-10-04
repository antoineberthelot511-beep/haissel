
FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('package.json valide')" && npm install --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]