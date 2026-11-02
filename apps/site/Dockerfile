# syntax=docker/dockerfile:1.7
# apps/site: the public marketing page, static files behind nginx. Build from the repo root:
#   docker build -f apps/site/Dockerfile -t studio-site:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) \
#     --build-arg INKLING_SITE_APP_URL=https://app.example.com .
# The app URL ("Sign in", "Start") is baked into the bundle at build time.
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
RUN turbo prune @studio/site --docker --out-dir /out

FROM base AS build
ARG INKLING_SITE_APP_URL
ENV INKLING_SITE_APP_URL=${INKLING_SITE_APP_URL}
COPY --from=prune /out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /out/full/ ./
COPY tsconfig.base.json ./
COPY schemas schemas
RUN pnpm --filter @studio/site exec vite build

FROM ${NGINX_IMAGE}
ARG GIT_SHA=dev
ARG IMAGE_SOURCE=unknown
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="studio-site"
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/site/nginx/nginx.conf /etc/nginx/nginx.conf
COPY apps/site/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=0755 apps/site/nginx/05-tmp-dirs.sh /docker-entrypoint.d/05-tmp-dirs.sh
COPY --from=build /repo/apps/site/dist /usr/share/nginx/html
USER 101
ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp/nginx/conf.d \
    GIT_SHA=${GIT_SHA}
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
