# حجزي Pro — صورة إنتاجية (Node 22+ لأن node:sqlite مدمج)
FROM node:24-alpine

WORKDIR /app

# التطبيق بلا أي اعتماديات خارجية — لا npm install
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=4173
ENV HAJZI_DB=/data/hajzi.db

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]
