FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/logos /app/output

EXPOSE 3000

CMD ["node", "gemini-api-bot.js"]