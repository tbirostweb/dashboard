# Backend du Social Dashboard (contexte de build = racine du dépôt, voir docker-compose.yml)
# À ÉPINGLER par digest avant production (image non disponible localement lors de l’audit du 04/10/2026) :
#   docker pull node:24-alpine && docker image inspect node:24-alpine --format "{{index .RepoDigests 0}}"
#   puis FROM node:24-alpine@sha256:<digest>
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MOCK_DATA_PATH=/app/mock/mock.js \
    TZ=Europe/Paris

WORKDIR /app

# Dépendances de production uniquement, versions figées par le lockfile
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY backend/src ./src
# Données de démo (MOCK_FALLBACK=true) : même générateur que le front
COPY data/mock.js ./mock/mock.js

# Volume des tokens chiffrés, appartenant à l'utilisateur non-root "node"
RUN mkdir -p /data && chown -R node:node /data && chmod 700 /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
