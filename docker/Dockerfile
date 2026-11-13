# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f docker/Dockerfile .
# The base is pinned to a multi-platform index digest. Change the tag and digest together:
# docker buildx imagetools inspect node:<tag>
ARG NODE_IMAGE=node:24.22.2-alpine3.24@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY shared/package.json shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@newses/server..."

# The web build is the same on every platform, so it runs on the builder's.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY web/package.json web/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@newses/web..."
COPY shared ./shared
COPY web ./web
RUN pnpm --filter @newses/web build

FROM ${NODE_IMAGE}
# Reported to the desktop and mobile apps; e.g. --build-arg NEWSES_VERSION=$(git describe --always).
ARG NEWSES_VERSION=dev
# The commit and repository the image is built from, for its labels; the release pipeline sets them.
ARG NEWSES_REVISION=
ARG NEWSES_SOURCE=
LABEL org.opencontainers.image.title="Newses" \
    org.opencontainers.image.description="Self-hosted RSS reader: server, worker, and web app" \
    org.opencontainers.image.url="https://newses.app" \
    org.opencontainers.image.licenses="AGPL-3.0-or-later" \
    org.opencontainers.image.version="${NEWSES_VERSION}" \
    org.opencontainers.image.revision="${NEWSES_REVISION}" \
    org.opencontainers.image.source="${NEWSES_SOURCE}"
ENV NEWSES_VERSION=${NEWSES_VERSION}
ENV NODE_ENV=production
ENV WEB_DIR=/app/web/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json LICENSE ./
COPY server/package.json ./server/
COPY server/src ./server/src
COPY shared ./shared
COPY --from=deps /app/shared/node_modules ./shared/node_modules
# The licences of the server's dependencies, read by GET /server/licenses.
RUN node shared/src/third-party-licenses.ts --node-modules node_modules \
    --out server/src/third-party-licenses.json
COPY --from=web /app/web/dist ./web/dist
# For the compose file's observability profile, which copies them to Grafana's volume.
COPY docker/observability/dashboards ./observability/dashboards
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/newses
# compose.apps.yaml's downloads volume starts from /data/downloads, which its apps build writes as node.
RUN mkdir -p /data/blobs /data/dashboards /data/downloads \
    && chown node:node /data/blobs /data/dashboards /data/downloads
USER node
EXPOSE 8080
ENTRYPOINT ["newses"]
CMD ["server"]
