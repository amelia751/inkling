# apps/versioning — see README.md. Tool versions are pinned here and in go.mod.
SQLC_VERSION   := v1.31.1
GOOSE_VERSION  := v3.29.0
OPC_VERSION    := 0.27.1
GOBIN          ?= $(shell go env GOPATH)/bin
ROOT           := ../..
PY_CLIENT      := $(ROOT)/apps/api/src/studio_api/clients/versioning
GIT_SHA        ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

.PHONY: tools generate check-generated test test-integration load fuzz lint vuln build migrate-up migrate-down migrate-status bench

tools:
	go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)
	go install github.com/pressly/goose/v3/cmd/goose@$(GOOSE_VERSION)
	go install golang.org/x/vuln/cmd/govulncheck@latest
	go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest

## generate: sqlc queries, oapi-codegen server, Python client for apps/api
generate:
	$(GOBIN)/sqlc generate
	go generate ./...
	uvx --from openapi-python-client==$(OPC_VERSION) openapi-python-client generate \
		--path $(ROOT)/schemas/versioning/openapi.yaml --config openapi-python-client.yaml \
		--meta none --output-path $(PY_CLIENT) --overwrite

## check-generated: CI drift check — regenerate and fail on any diff
check-generated: generate
	git diff --exit-code -- internal/db internal/api $(PY_CLIENT)
	@test -z "$$(git status --porcelain -- internal/db internal/api $(PY_CLIENT))" || (git status --porcelain -- internal/db internal/api $(PY_CLIENT); exit 1)

test:
	go test -race ./...

## test-integration: Postgres + S3-compatible server via testcontainers (needs Docker)
test-integration:
	go test -race -tags integration -timeout 20m ./...

## load: 100k entries by default; LOAD_ENTRIES=1000000 for the 1M run
load:
	go test -tags load -timeout 2h -v ./tests/load/

bench:
	go test -tags integration -run XXX -bench . -benchtime 1x ./internal/gitengine/

FUZZTIME ?= 30s
fuzz:
	go test ./internal/manifests/ -run XXX -fuzz FuzzManifestDecode -fuzztime $(FUZZTIME)
	go test ./internal/manifests/ -run XXX -fuzz FuzzCanonicalJSON -fuzztime $(FUZZTIME)
	go test ./internal/service/ -run XXX -fuzz FuzzBranchName -fuzztime $(FUZZTIME)

lint:
	$(GOBIN)/golangci-lint run

vuln:
	$(GOBIN)/govulncheck ./...

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.gitSHA=$(GIT_SHA)" -o dist/ ./cmd/...

migrate-up:
	go run ./cmd/migrate up

migrate-down:
	go run ./cmd/migrate down

migrate-status:
	go run ./cmd/migrate status
