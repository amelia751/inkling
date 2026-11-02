# syntax=docker/dockerfile:1.7
# apps/mcp: `studio-mcp`, the remote MCP server (streamable HTTP on :8300, todo17 D12). Build from
# the repo root:
#   docker build -f apps/mcp/Dockerfile -t studio-mcp:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
#   docker run --rm -p 8300:8300 -e INKLING_API_URL=http://host.docker.internal:8000 studio-mcp:dev
# The same image runs over stdio with `-e INKLING_MCP_TRANSPORT=stdio` and `docker run -i`.
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
# dist/main.js reads ../../../schemas/naming.json, i.e. /app/schemas/naming.json, dist/operations.js
# the operation catalogue and dist/viewers.js the viewer document template.
COPY --from=build /repo/schemas/naming.json schemas/naming.json
COPY --from=build /repo/schemas/operations.json schemas/operations.json
COPY --from=build /repo/schemas/viewer-runtime.v1.json schemas/viewer-runtime.v1.json
ENV NODE_ENV=production HOME=/tmp GIT_SHA=${GIT_SHA} \
    INKLING_MCP_TRANSPORT=http INKLING_MCP_HOST=0.0.0.0 INKLING_MCP_PORT=8300
USER node
EXPOSE 8300
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8300/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/mcp/dist/main.js"]
