# --- Сборка: бандлим сервер в один ESM-файл, чтобы в рантайме не тащить tsx ---
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build:server

# --- Рантайм: только прод-зависимости (ws) и собранный бандл ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist-server ./dist-server

RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080

# Порт совпадает с тем, что ждёт nginx в docker/nginx.conf
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/main.js"]
