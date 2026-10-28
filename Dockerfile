# Etapa 1: build do front (apps/web, Vite) e do pacote compartilhado. Node 22 em tudo.
FROM node:22-bookworm-slim AS web
WORKDIR /opt/biotrop
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npm run build

# Etapa 2: servidor (só dependências de produção) + o dist do front.
FROM node:22-bookworm-slim
WORKDIR /opt/biotrop
ENV NODE_ENV=production
# Threadpool do libuv: até 2 scrypts do terminal ocupam threads; 8 deixa folga para DNS, arquivos e TLS (.env.example).
ENV UV_THREADPOOL_SIZE=8
COPY server/package*.json ./server/
RUN cd server && npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY server ./server
COPY --from=web /opt/biotrop/apps/web/dist ./apps/web/dist
COPY database ./database
USER node
EXPOSE 3000
CMD ["node","server/src/index.js"]
