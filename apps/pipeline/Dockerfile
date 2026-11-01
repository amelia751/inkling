# syntax=docker/dockerfile:1.7
# apps/pipeline: pipeline orchestration service (Go, DBOS Transact). Build from the repo root:
#   docker build -f apps/pipeline/Dockerfile -t studio-pipeline:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
# Binaries in /app/bin: server (CMD), migrate (up|status; the pipeline-migrate Job), healthcheck. The workflow package
# digest (scripts/workflow-digest.sh) is baked in as the default application version (E3).
ARG GO_IMAGE=golang:1.27-trixie
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot

FROM ${GO_IMAGE} AS build
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
WORKDIR /src/apps/pipeline
COPY apps/pipeline/go.mod apps/pipeline/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY apps/pipeline ./
ARG GIT_SHA=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    WF="$(sh scripts/workflow-digest.sh)" && \
    go build -ldflags "-s -w -X main.gitSHA=${GIT_SHA} -X studio.local/pipeline/internal/config.BuildAppVersion=${WF}" -o /out/ ./cmd/...
# A tiny probe for HEALTHCHECK: the distroless runtime has no shell, curl or wget.
RUN mkdir -p /hc && cat > /hc/main.go <<'EOF'
package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	url := "http://127.0.0.1:8095/healthz"
	if len(os.Args) > 1 {
		url = os.Args[1]
	}
	c := http.Client{Timeout: 2 * time.Second}
	r, err := c.Get(url)
	if err != nil || r.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
EOF
RUN cd /hc && go mod init healthcheck >/dev/null 2>&1 && go build -ldflags "-s -w" -o /out/healthcheck .

FROM ${RUNTIME_IMAGE}
ARG GIT_SHA=dev
ARG IMAGE_SOURCE=unknown
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="studio-pipeline"
WORKDIR /app
COPY --from=build /out/ /app/bin/
# Env and bucket names come from the naming config (todo4 V11).
COPY schemas/naming.json /app/schemas/naming.json
ENV NAMING_FILE=/app/schemas/naming.json \
    PATH=/app/bin:/usr/local/bin:/usr/bin:/bin \
    TMPDIR=/tmp \
    GIT_SHA=${GIT_SHA}
USER 65532:65532
EXPOSE 8095
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 CMD ["/app/bin/healthcheck"]
CMD ["/app/bin/server"]
