FROM ghcr.io/puppeteer/puppeteer:24.0.0

USER root

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/logos /app/output

RUN chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 3000

CMD ["node", "server.js"]