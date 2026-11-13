FROM node:22-bookworm-slim
WORKDIR /app
COPY reader/package*.json ./reader/
RUN cd reader && npm ci --omit=dev --no-fund --no-audit
COPY package.json ./
COPY reader ./reader
COPY sarraf-preview ./sarraf-preview
USER node
WORKDIR /app/reader
ENV NODE_ENV=production PORT=10000
CMD ["node","cloud-server.mjs"]
