FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3455 \
    DATA_DIR=/data \
    PAGE_KEY_FILE=/data/page-key

COPY package.json ./
COPY server.mjs ./
COPY static ./static
COPY LICENSE ./NOTICE ./LICENSES ./LICENSES
COPY docs ./docs

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3455

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3455/api/health || exit 1

CMD ["node", "server.mjs"]