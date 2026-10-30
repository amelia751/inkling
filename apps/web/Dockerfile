# syntax=docker/dockerfile:1.7
# apps/web: the Studio SPA, static files behind nginx. Build from the repo root:
#   docker build -f apps/web/Dockerfile -t studio-web:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
# No environment is baked into the bundle: the SPA fetches /config.json at startup (mounted at
# /etc/studio/config.json from a ConfigMap or compose volume). nginx also proxies
# /api/agent/* to the agent service with its bearer token (see nginx/default.conf.template).
ARG NODE_IMAGE=node:24-trixie-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=12.11.2
ARG TURBO_VERSION=2.11.9
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g --no-fund --no-audit pnpm@${PNPM_VERSION} turbo@${TURBO_VERSION}
WORKDIR /repo

FROM base AS prune
COPY . .
RUN turbo prune @studio/web --docker --out-dir /out

FROM base AS build
COPY --from=prune /out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /out/full/ ./
# Repo-level inputs the build reads: the naming config (vite.config.ts, index.html), workspace
# presets and every plugin's plugin.yaml / contributions.json (import.meta.glob, including
# plugins without a package.json), tsconfig base.
COPY tsconfig.base.json ./
COPY schemas schemas
COPY registry registry
COPY plugins plugins
# `vite build` only: type checking (`tsc -b`, part of `pnpm build`) runs in CI (ci.yml), and its
# include glob would also check every pruned workspace package, not just what the bundle uses.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm --filter @studio/web exec vite build

FROM ${NGINX_IMAGE}
ARG GIT_SHA=dev
ARG IMAGE_SOURCE=unknown
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="studio-web"
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/web/nginx/nginx.conf /etc/nginx/nginx.conf
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=0755 apps/web/nginx/05-tmp-dirs.sh /docker-entrypoint.d/05-tmp-dirs.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
USER 101
ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp/nginx/conf.d \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    AGENT_UPSTREAM=http://agent:8100 \
    INTERNAL_AGENT_SERVICE_TOKEN="" \
    GIT_SHA=${GIT_SHA}
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
