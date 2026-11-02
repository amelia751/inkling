# syntax=docker/dockerfile:1.7
# apps/worker: runs plugin jobs in per-plugin locked uv environments. Build from the repo root:
#   docker build -f apps/worker/Dockerfile -t studio-worker:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
# All first-party plugins/* are included (v1: one image for every bundled worker). Their
# environments are prebuilt at image build time (`studio-worker --prepare-envs`) into
# WORKER_ENVS_DIR (read-only at run time, WORKER_BUILD_ENVS=0), and `uv` stays in the image
# because the worker launches plugin processes from those environments.
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9-python3.12-trixie-slim
ARG PYTHON_IMAGE=python:3.12-slim-trixie

FROM ${UV_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /out && cp pyproject.toml uv.lock .python-version /out/ \
 && find apps packages -name pyproject.toml -not -path '*/node_modules/*' -exec cp --parents {} /out/ \;

FROM ${UV_IMAGE} AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv \
    STUDIO_WORKER_ENVS_DIR=/app/.plugin-envs
WORKDIR /app
COPY --from=manifests /out/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package studio-worker
COPY packages packages
COPY apps/worker apps/worker
COPY schemas schemas
COPY registry registry
COPY plugins plugins
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package studio-worker
# Prebuild every bundled plugin's locked environment (registry/index.json → plugins/<id>).
RUN --mount=type=cache,target=/root/.cache/uv \
    /app/.venv/bin/studio-worker --prepare-envs

FROM ${PYTHON_IMAGE}
ARG GIT_SHA=dev
ARG IMAGE_SOURCE=unknown
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="studio-worker"
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
# ffmpeg (+ ffprobe) converts videos the browser can't play (todo19 P0-1). OpenSlide and libvips
# come as wheels (openslide-bin, pyvips-binary) in the venv, so no system packages for slides.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home --home-dir /tmp app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --from=build /app/.plugin-envs /app/.plugin-envs
COPY --from=build /app/packages packages
COPY --from=build /app/apps/worker apps/worker
COPY --from=build /app/plugins plugins
COPY --from=build /app/schemas schemas
COPY --from=build /app/registry registry
# The worker writes only under /tmp (job scratch, uv cache for late-installed plugins).
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_PROGRESS=1 \
    GIT_SHA=${GIT_SHA} \
    STUDIO_REPO_ROOT=/app \
    STUDIO_WORKER_DATA_DIR=/tmp/worker \
    STUDIO_WORKER_ENVS_DIR=/app/.plugin-envs \
    STUDIO_WORKER_BUILD_ENVS=0
USER 10001:10001
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=2).status == 200 else 1)"]
CMD ["studio-worker"]
