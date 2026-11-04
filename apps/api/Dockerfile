# syntax=docker/dockerfile:1.7
# apps/api: kernel + plugin control plane (FastAPI). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t studio-api:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
# The image mirrors the repo under /app (schemas/, registry/, plugins/ resolve as in a checkout).
# The builder and the final stage share the same Python (python:3.12-slim-trixie), so the
# venv's interpreter path is identical in both.
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9-python3.12-trixie-slim
ARG PYTHON_IMAGE=python:3.12-slim-trixie

# ---- Lock inputs only (pyproject.toml of every workspace member + uv.lock) -----------------
FROM ${UV_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /out && cp pyproject.toml uv.lock .python-version /out/ \
 && find apps packages -name pyproject.toml -not -path '*/node_modules/*' -exec cp --parents {} /out/ \;

# ---- Dependencies (cached on the lock), then the workspace members ---------------------------
FROM ${UV_IMAGE} AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY --from=manifests /out/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package studio-api --extra gcpkms --extra otel
COPY packages packages
COPY apps/api apps/api
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package studio-api --extra gcpkms --extra otel

# ---- Runtime -------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE}
ARG GIT_SHA=dev
ARG IMAGE_SOURCE=unknown
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="studio-api"
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home --home-dir /tmp app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --from=build /app/packages packages
COPY --from=build /app/apps/api apps/api
COPY schemas schemas
COPY registry registry
COPY plugins plugins
# Read-only root filesystem: only /tmp is writable (an emptyDir in k8s, tmpfs in compose).
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    GIT_SHA=${GIT_SHA} \
    STUDIO_API_DATA_DIR=/tmp/api
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]
# Migrations run as a separate Job/one-shot: `alembic upgrade head` with workdir /app/apps/api.
CMD ["uvicorn", "studio_api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
