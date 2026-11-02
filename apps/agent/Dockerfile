# syntax=docker/dockerfile:1.7
# apps/agent: pi agent runtime + Daytona sandboxes (Hono HTTP/SSE). Build from the repo root:
#   docker build -f apps/agent/Dockerfile -t studio-agent:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
# `turbo prune` keeps only @studio/agent and its workspace dependencies, so the install layer
# is cached until one of their package.json files or the lockfile changes.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=12.11.2
ARG TURBO_VERSION=2.11.9
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g --no-fund --no-audit pnpm@${PNPM_VERSION} turbo@${TURBO_VERSION}
WORKDIR /repo

FROM base AS prune
COPY . .
RUN turbo prune @studio/agent --docker --out-dir /out

FROM base AS build
COPY --from=prune /out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /out/full/ ./
COPY tsconfig.base.json ./
COPY schemas schemas
# The preset intent table (todo11 D5), read at startup by the Studio tools.
COPY registry/intents.json registry/intents.json
# esbuild bundle: dist/main.js, dist/scripts/{migrate,sweep}.js (the migrate Job, the sweeper CronJob).
RUN pnpm --filter @studio/agent run build

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
      org.opencontainers.image.title="studio-agent"
WORKDIR /app
# Workspace manifests + production node_modules, then the bundle. The bundle reads some files
# at run time from their source location (prompts under src/, sandbox-image/), so those stay.
COPY --from=prod-deps /repo/ ./
COPY --from=build /repo/apps/agent/dist apps/agent/dist
COPY --from=build /repo/apps/agent/src apps/agent/src
COPY --from=build /repo/apps/agent/sandbox-image apps/agent/sandbox-image
COPY --from=build /repo/apps/agent/NOTICE apps/agent/NOTICE
COPY --from=build /repo/schemas schemas
COPY --from=build /repo/registry/intents.json registry/intents.json
# Read-only root filesystem: run data (pi agent dir, scratch) under /tmp only.
ENV NODE_ENV=production \
    STUDIO_ENV=production \
    STUDIO_AGENT_HOST=0.0.0.0 \
    STUDIO_AGENT_PORT=8100 \
    STUDIO_AGENT_DATA_DIR=/tmp/agent \
    HOME=/tmp \
    GIT_SHA=${GIT_SHA}
USER node
EXPOSE 8100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8100/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/agent/dist/main.js"]
