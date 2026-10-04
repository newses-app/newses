# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f docker/Dockerfile .
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY shared/package.json shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@rss-reader/server..."

FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY server/package.json ./server/
COPY server/src ./server/src
COPY shared ./shared
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/rss-reader
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 8080
ENTRYPOINT ["rss-reader"]
CMD ["server"]
