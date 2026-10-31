# apps/versioning

The dataset versioning service (`versioning.md`, `todo/done/todo4.md`). Datasets are
Git-like repositories with branches, commits, review requests, semantic diffs,
three-way merges and releases. It is an internal Go service: only `apps/api`
calls it, using short-lived Ed25519 service JWTs.

**Architecture invariant:** Git commits describe **which immutable dataset
artifacts and annotation revisions belong to a snapshot**; object storage holds
the bytes; PostgreSQL controls authoritative refs and review policy; only
authorized Inkling services may publish changes. Pipelines and agents produce
proposals through this boundary, never silently mutate a published dataset.

In practice:

- **go-git** stores the small metadata commits (a snapshot pointing at a
  manifest root), in Postgres through `internal/storage/gitstorer.go`.
- **Object storage** (S3 API) holds artifact bytes, manifest roots and chunks.
  Every read is hash-verified.
- **Postgres** (schema `versioning`, row-level security per tenant) holds the
  authoritative branch heads, which move only by compare-and-swap. It also
  holds review state, idempotency records, audit events and the outbox.

## Running it

Prerequisites: Go (see `go.mod`), Docker for the integration and load tests,
and `make tools` once for sqlc, goose, govulncheck and golangci-lint.

### Configuration

Copy `secrets/versioning.env.example` (at the repo root) to
`secrets/versioning.env`, which is git-ignored, and fill it in. The service
reads only the environment, and every key gets the naming config's
`envPrefix`. With `schemas/naming.json` the prefix is `INKLING_`, so the keys are
`INKLING_VERSIONING_DATABASE_URL`, `INKLING_VERSIONING_OBJECT_ENDPOINT` and so on.
Without a naming config (`NAMING_FILE` unset and no `schemas/naming.json`
found upwards) the keys are used exactly as written in the example.

```sh
# from apps/versioning; prefix the keys as described above
set -a; . ../../secrets/versioning.env; set +a
```

Local dev needs Postgres on `:5432` and an S3-compatible server on `:9000`.
On Google Cloud set `…_OBJECT_STORE=gcs`: Cloud Storage through its native API with
Application Default Credentials (Workload Identity), no HMAC or key file
(`internal/storage/gcs.go`).
The tests use RustFS, because MinIO no longer publishes images. Make a JWT key
pair for local tokens with `go run ./cmd/devtoken keygen ./dev-keys`, and point
`…_JWT_PUBLIC_KEY_FILE` at `dev-keys/jwks.json`.
`go run ./cmd/devtoken mint ./dev-keys <tenant> <project> <actor>` prints a
bearer token.

### Migrate

`cmd/migrate` owns the `versioning` schema (goose; `apps/api` keeps Alembic for
its own schema, todo4 V2).

```sh
go run ./cmd/migrate bootstrap   # once, as superuser (…_ADMIN_DATABASE_URL):
                                 # roles versioning_owner / versioning_app + schema
make migrate-up                  # as versioning_owner (…_MIGRATE_DATABASE_URL)
make migrate-status
make migrate-down
```

### Server

```sh
make migrate-up && go run ./cmd/server     # or: pnpm --filter @studio/versioning dev
```

This serves `/internal/v1/…` (`schemas/versioning/openapi.yaml`) on
`…_HTTP_ADDR` (default `:8090`). `/healthz`, `/readyz` and `/version` need no
token. The same process runs the River workers: reconcile-root, review checks,
async diffs and the outbox relay.

### Reconcile and GC

```sh
go run ./cmd/reconcile                       # one pass, prints findings as JSON; exit 2 = something pages
go run ./cmd/gc                              # mark + dry-run sweep plan (default)
go run ./cmd/gc --tenant <id>                # limit to one tenant
go run ./cmd/gc --apply                      # deletes only if …_GC_SWEEP_ENABLED=true as well
```

GC keeps everything reachable from branch heads (including tombstones within
`BRANCH_RETENTION`), releases, open reviews and their conflict refs, commits
inside `HISTORY_RETENTION`, active checkout leases and legal holds. It sweeps
only objects that have been unreferenced for longer than `GC_GRACE_HOURS`.

### Make targets

| Target | What it does |
|---|---|
| `make tools` | install sqlc, goose, govulncheck, golangci-lint (pinned in the Makefile) |
| `make generate` | sqlc (`internal/db`), oapi-codegen (`internal/api`), Python client in `apps/api/src/studio_api/clients/versioning` |
| `make check-generated` | regenerate and fail on any diff (CI drift check) |
| `make test` | unit tests, `go test -race ./...` (no Docker) |
| `make test-integration` | `-tags integration`: Postgres 17 + RustFS via testcontainers |
| `make bench` | the Git metadata benchmarks (integration tag) |
| `make load` | `tests/load` at 100k entries; `INKLING_VERSIONING_LOAD_ENTRIES=1000000 make load` for 1M |
| `make fuzz` | `FuzzManifestDecode`, `FuzzCanonicalJSON`, `FuzzBranchName` (`FUZZTIME=30s`) |
| `make lint`, `make vuln` | golangci-lint, govulncheck |
| `make build` | static binaries for every `cmd/` into `dist/` |
| `make migrate-up/down/status` | `go run ./cmd/migrate …` |

Never edit `internal/api` or `internal/db` by hand: change `openapi.yaml`,
`queries/*.sql` or `migrations/` and run `make generate`.

## Layout

| Path | Contents |
|---|---|
| `cmd/server` | HTTP API and River workers |
| `cmd/migrate` | `bootstrap` (roles, schema), `up`, `down`, `status` |
| `cmd/reconcile`, `cmd/gc` | one-shot reconcile pass; GC mark and sweep (dry-run by default) |
| `cmd/devtoken` | dev key pair and service JWTs (local dev and load harness only) |
| `internal/app` | wiring: config, stores, service, River, relay, reconciler, GC, handler |
| `internal/server` | oapi-codegen strict handlers, router, problem+json, authn middleware |
| `internal/service` | the operations: commit protocol (CAS + idempotency), branches, reviews, merges, releases, checkouts, artifacts |
| `internal/gitengine` | go-git metadata commits, plumbing merge commits, ancestry and merge-base |
| `internal/manifests` | manifest schema, canonical JSON and hashing, Parquet chunks, filter index, annotation revisions |
| `internal/semanticdiff`, `internal/merge` | semantic diff (samples, annotations, taxonomy) and three-way merge with conflicts and resolutions |
| `internal/storage` | Postgres pool and tenant transactions, go-git storer, `BlobStore` (S3, local fs) |
| `internal/authn`, `internal/authz` | JWT verification and scopes; tenant, branch and approval policy, rate limits |
| `internal/events`, `internal/jobs` | outbox relay (Redis Streams or log), River job registration |
| `internal/reconcile`, `internal/gc` | reconciler (orphans, staged TTL, ref projection), GC mark and sweep |
| `internal/config`, `internal/observability` | env config with the naming prefix; logging and metrics |
| `internal/db`, `internal/api` | **generated** (sqlc, oapi-codegen) |
| `internal/testenv`, `internal/testutil` | testcontainers Postgres + S3, fixtures |
| `migrations/`, `queries/` | goose migrations (schema `versioning`, RLS, roles); sqlc queries |
| `tests/integration` | end-to-end over HTTP against real containers (`-tags integration`) |
| `tests/load` | scale, GC and backup/restore harness (`-tags load`) |

## Recorded numbers

All numbers below come from one machine: Apple M4 (10 cores, 16 GiB),
darwin/arm64, go1.27.3, Docker Desktop 28.4.0 (10 CPUs, 7.6 GiB for
containers), Postgres 17-alpine and RustFS in testcontainers. They are single
runs (`-benchtime 1x`), not averages.

### Git metadata benchmarks (todo4 1.8), 2026-10-30

`make bench`, i.e.
`go test -tags integration -run XXX -bench . -benchtime 1x ./internal/gitengine/`

| Benchmark | Time | Per commit |
|---|---|---|
| `BenchmarkWrite10kCommits` (write a 10k-commit chain) | 15.81 s | 1.58 ms |
| `BenchmarkRead10kCommitsCold` (read all 10k, cold cache) | 3.84 s | 0.38 ms |
| `BenchmarkWalk10kAncestry/cold` (log of the 10k chain, cold) | 4.28 s | 0.43 ms |
| `BenchmarkWalk10kAncestry/warm` (same walk, warm object cache) | 17.5 ms | 1.7 µs |

### Load tests (todo4 Phase 3), 2026-10-30

`make load` (100k) and `INKLING_VERSIONING_LOAD_ENTRIES=1000000 make load` (1M), i.e.
`go test -tags load -timeout 2h -v ./tests/load/`. `TestScaleUpdateDiffMergeCheckout`
builds a manifest with N samples, makes two 1% updates on two branches, then
runs diff, review checks, a three-way merge and checkouts.
`TestGCScaleAndBackupRestore` does not depend on N. It runs GC at 50 branches
and 200 releases, then a backup (`pg_dump` plus a bucket copy), a restore into
fresh containers, and verifies every release.

| Step | 100k | 1M |
|---|---|---|
| put manifest (validate + chunk + index) | 9.16 s (chunked-v1) | 5 m 22 s (chunked-v1) |
| commit | 22 ms | 60 ms |
| 1% update: put manifest + commit | 17.79 s | did not finish (see below) |
| diff 1% (sync) | 707 ms (250 changed buckets) | not reached |
| review checks (merge preview + checks) | 2.62 s | not reached |
| three-way merge + commit | 10.01 s | not reached |
| partial checkout (10 samples) | 37 ms (9 buckets read) | not reached |
| filtered checkout (split=test, 1000-sample page) | 333 ms (256 buckets read) | not reached |
| process memory from the Go runtime (`MemStats.Sys`) | 377 MiB | not reached |
| whole scale test | 81.5 s | not reached |

| GC and backup/restore (same in both runs) | 100k run |
|---|---|
| gc mark (50 branches, 200 releases; 201 commits) | 1.34 s |
| gc sweep dry-run (would delete 0 artifacts, 0 git objects) | 1.07 s |
| backup + restore | 10.53 s |
| verify every release after restore (20,100 objects) | 15.08 s |

**The 1M run is incomplete.** It started at 01:02 and was cut off after 34.6
minutes (2,079 s) during the first "1% update" step. It had already recorded
two steps: putting the 1M-entry manifest (5 m 22 s) and the commit (60 ms).
At 01:36 the Docker Desktop daemon went away (`/var/run/docker.sock: no such
file`), so the test failed with `load_test.go:220: unexpected EOF` from the
storage connection, and `TestGCScaleAndBackupRestore` could not start its
containers. Diff, merge and checkout at 1M were never reached, so there is no
1M budget result yet.

Notes for the next attempt:

- Putting the manifest scales worse than linearly: 9 s at 100k, 322 s at 1M.
  `pg_stat_activity` showed the time going mostly to
  `InsertArtifactReferences`, whose 10k-id batches took about 1 s each against
  2M artifact rows. The 1% update repeats that work for each branch (two more
  1M-entry manifests), plus 10k single-object uploads.
- At 1M the test therefore needs roughly 20+ minutes before the diff step on
  this machine. Its containers ran inside Docker Desktop's 7.6 GiB VM, which
  is the likely cause of the daemon loss.
- For about 2 minutes early on, a short run of the new integration tests
  (`TestMergeStaleTarget*`, `TestEveryReleaseVerifies`,
  `TestGCMarkReachableCoversAllRoots`) overlapped the 1M run.
- To retry: `INKLING_VERSIONING_LOAD_ENTRIES=1000000 make load` with nothing else running, and
  more memory for the Docker VM if possible.
