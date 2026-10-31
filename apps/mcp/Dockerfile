# syntax=docker/dockerfile:1.7
# apps/mcp: MCP server over stdio (no port; run with `docker run -i`). Build from the repo root:
#   docker build -f apps/mcp/Dockerfile -t studio-mcp:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
#   docker run --rm -i -e INKLING_URL=http://host.docker.internal:8080 studio-mcp:dev
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=12.11.2
ARG TURBO_VERSION=2.11.9
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g --no-fund --no-audit pnpm@${PNPM_VERSION} turbo@${TURBO_VERSION}
WORKDIR /repo

FROM base AS prune
COPY . .
RUN turbo prune @studio/mcp --docker --out-dir /out

FROM base AS build
COPY --from=prune /out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /out/full/ ./
COPY tsconfig.base.json ./
COPY schemas schemas
RUN pnpm --filter @studio/mcp run build

# Production dependencies only, installed clean (an in-place `--prod` reinstall keeps dev tools).
FROM base AS prod-deps
COPY --from=prune /out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /pnpm/store

FROM ${NODE_IMAGE}
ARG GIT_SHA=dev
ARG IMAGE_SOURCE=unknown
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="studio-mcp"
WORKDIR /app
COPY --from=prod-deps /repo/ ./
COPY --from=build /repo/apps/mcp/dist apps/mcp/dist
# dist/main.js reads ../../../schemas/naming.json, i.e. /app/schemas/naming.json, and
# dist/viewers.js the viewer document template (schemas/viewer-runtime.v1.json).
COPY --from=build /repo/schemas/naming.json schemas/naming.json
COPY --from=build /repo/schemas/viewer-runtime.v1.json schemas/viewer-runtime.v1.json
ENV NODE_ENV=production HOME=/tmp GIT_SHA=${GIT_SHA}
USER node
# stdio server: no HEALTHCHECK (nothing listens).
CMD ["node", "apps/mcp/dist/main.js"]
