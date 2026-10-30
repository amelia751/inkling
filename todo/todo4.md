# Dataset versioning service (`versioning.md`) — `apps/versioning` in Go

**Goal.** Implement `versioning.md`: datasets become Git-like repositories (branches, commits, review requests, semantic diffs, three-way merges, releases). The design:
- **go-git** stores small metadata commits;
- **object storage** holds the bytes;
- **Postgres** holds the authoritative branch heads and review state.

It's a new deployable Go service, `apps/versioning`, reached only through `apps/api`.

`versioning.md` §18 defines the phases; this file breaks them into steps. Pipeline orchestration stays out of scope, as the spec says.

## Status (2026-10-30)

Audited against `main` after the commit "todo4: dataset versioning service (apps/versioning, Go) with schemas and generated Python client". `go build ./...` and `go vet ./...` pass. Updated 2026-10-30 after the README, benchmarks, unit tests, Phase 7 tests, the emitted annotation-revision schema and the `annotations.diff` block.

- **Phase 0 (scaffold):** done (`apps/versioning/README.md` added 2026-10-30).
- **Phase 1 (Git metadata core):** done. Postgres storer passes go-git's `storage/test` suite; RLS, roles, commit protocol, checkout and integration tests exist. Benchmark numbers are recorded in the README, and the idempotency and foreign-tenant unit tests exist.
- **Phase 2 (dataset semantics):** done. `plugin-contracts` owns and emits the annotation-revision schema (2026-10-30).
- **Phase 3 (scale and recovery):** done in code (Parquet chunks, outbox relay, reconciler, GC, limits). 100k load results are recorded in the README. The 1M re-run was cut off again (the Docker daemon went away 35 min in); its partial result is recorded.
- **Phase 4 (contracts):** partial. Schemas, `openapi.yaml`, Go stubs, the Python client and the `annotations.diff` block in `plugin-manifest.ts` exist. There's no CI drift check.
- **Phase 5 (monorepo wiring):** not started. It waits for `todo3.md` (`turbo.json`, `infra/`, `.github/workflows/` and `docs/adr/` don't exist yet).
- **Phase 6 (platform integration):** not started (no `routes/versioning.py`, web UI, agent tools, worker subscriber or e2e tests).
- **Phase 7 (acceptance):** partial. Most criteria are covered by tests under different file names (`tests/integration/phase{1,2,3}_test.go`), plus `tests/integration/stale_target_test.go`, `release_verify_test.go` and `gc_mark_test.go`. k8s chaos, e2e flow C and a complete 1M load result are missing.

### What's left

- **Phase 3:** complete the `LOAD_ENTRIES=1000000` run (100k is recorded; the 2026-10-30 1M attempt lost the Docker daemon 35 min in, during the first 1% update) and record it in `apps/versioning/README.md`. Run it alone and give Docker more memory.
- **Phase 4:** run `make check-generated` in CI.
- **Phase 5 (after todo3):** `apps/versioning/Dockerfile`; the `versioning`, `minio-init` and `versioning-migrate` services in `infra/docker/compose.yaml`; `infra/k8s/base/versioning/`; `versioning-secrets`; a `go` job in `.github/workflows/ci.yml`; move `versioning.md` to `docs/versioning.md`; add a root `README.md` row; write `docs/adr/0002-versioning-storage.md`.
- **Phase 6:** `apps/api/src/studio_api/routes/versioning.py` plus the kernel commands; the Studio save flow on `work/<actor>/<dataset>` branches; `apps/web/src/studio/core/versioning/`; agent tools in `apps/agent`; a worker subscriber for `versioning.review.opened`; `tests/e2e/versioning/` (flows A, B and C, plus `chaos_test.py`).
- **Phase 7:** recorded 1M results. The stale-target, release-verify and GC-mark tests were added in `tests/integration/` (`stale_target_test.go`, `release_verify_test.go`, `gc_mark_test.go`).

---

## Research findings that change or settle parts of the spec (checked 2026-10-29)

| Topic | Finding | Effect on the plan |
|---|---|---|
| go-git version | Latest stable is **`v5.19.3`** (2026-10-04). `v6` is **`v6.0.0-beta.1`** (2026-10-04, needs Go ≥ 1.26), not stable. | Pin `github.com/go-git/go-git/v5 v5.19.3`. Keep all go-git calls inside `internal/gitengine` so a v6 migration later touches one package (spec §4). |
| Merge | `Repository.Merge` supports **only `FastForwardMerge`**. Anything else returns `ErrUnsupportedMergeStrategy`. | This confirms the spec: we write the three-way semantic merge and build the two-parent commit ourselves with plumbing (`object.Commit` and `EncodedObject`). |
| Merge base | `(*object.Commit).MergeBase(other)` returns the best common ancestors, and `IsAncestor` exists. | Use these for merge bases. If more than one base comes back (criss-cross history), return `409 multiple_merge_bases` in v1 (spec §8 and question 6). |
| SHA-256 objects | In v5, SHA-256 repos work only when built with the `sha256` tag, and fetch/push aren't supported. In v6, SHA-256 is still being finished. | **Use SHA-1 Git objects in v1.** Record the `object_format` per repository so migrating later is a data change (question 1). Raw artifacts always use SHA-256 (spec §3.2). |
| Durable storage | `storage.Storer` is pluggable: it combines encoded-object, reference, shallow, index, config and module storage. Filesystem and memory backends ship with go-git, and v5 has a `transactional` storer. Community examples back Storer with Postgres (`go-gitgres`) and S3 plus Postgres (`git-server-exploration`). Both are experiments; don't depend on them. | **Answer to question 2: write our own Postgres-backed `Storer`.** Our Git objects are tiny (one commit, one tree and about 4 pointer blobs per dataset commit, a few KB), so a `bytea` table is cheap and gives transactional, replica-safe, backed-up storage with no volumes. It also allows more than one replica from the start. Run go-git's own storer conformance tests against it (`storage/test`). |
| Go toolchain | Latest is `go1.27.3`. This machine has `go1.27.2`. | `go.mod`: `go 1.27`, `toolchain go1.27.3`. |
| Libraries (latest on `proxy.golang.org`) | `pgx/v5` v5.11.0, `sqlc` v1.31.1, `goose/v3` v3.29.0, `chi/v5` v5.5.0, `oapi-codegen/v2` v2.8.1, `aws-sdk-go-v2/service/s3` v1.114.6, `parquet-go` v0.32.0, `riverqueue/river` v0.50.0, `oklog/ulid/v2` v2.1.2, `gowebpki/jcs` v1.0.2 (RFC 8785 canonical JSON), `otel` v1.47.0, `testcontainers-go` v0.44.0. | Stack choices in decision V3. |

Sources:
- go-git releases: <https://github.com/go-git/go-git/releases>
- v5 `COMPATIBILITY.md` (merge is fast-forward only; SHA-256 needs a build tag): <https://github.com/go-git/go-git/blob/v5.17.2/COMPATIBILITY.md>
- `merge_base.go`: <https://github.com/go-git/go-git/blob/v6.0.0-alpha.5/plumbing/object/merge_base.go>
- `storage/storer.go`: <https://github.com/go-git/go-git/blob/main/storage/storer.go>
- SHA-256 tracking issue: <https://github.com/go-git/go-git/issues/706>
- v5→v6 migration guide: <https://go-git.github.io/docs/tutorials/migrating-from-v5-to-v6/>
- Storer examples: <https://github.com/muandane/go-gitgres>, <https://github.com/npclaudiu/git-server-exploration>

---

## 0. Decisions (spec open questions and gaps)

| # | Question | Recommendation |
|---|---|---|
| V1 | Where Git objects live in production (spec question 2) | A Postgres `Storer` (`git_objects` and `git_refs` tables in the `versioning` schema) with an in-process LRU cache. The filesystem storer is used only in unit tests; the memory storer only in tests. |
| V2 | Who owns the database schema | **The versioning service owns a separate Postgres schema, `versioning`**, with its own role and its own migrations (goose). `apps/api` keeps Alembic for its own schema. "One migration owner" is per schema, and the service never touches `public`/kernel tables. A cross-schema foreign key to tenants is replaced by checks at the API boundary. |
| V3 | Go stack | `net/http` + `chi`. **Spec-first API** in `schemas/versioning/openapi.yaml`, with server stubs from `oapi-codegen` and a Python client for `apps/api` from `openapi-python-client`. `pgx` + `sqlc` for queries, `goose` for migrations. **River** (a Postgres-native job queue) for background work: large diffs, the outbox relay, reconcile, GC. S3 through `aws-sdk-go-v2` (MinIO locally with path-style addressing, GCS through its S3 interop). `jcs` for canonical JSON. `ulid` for ids. `slog` JSON logs. OpenTelemetry. |
| V4 | Service-to-service auth (spec §2: "scoped service-to-service context") | `apps/api` mints a **short-lived (60 s) Ed25519-signed JWT** per request, with `tenant_id`, `project_id`, `actor` (user or agent, plus `on_behalf_of`), `scopes`, `request_id` and an `aud` of the versioning service. The service verifies it with the API's public key (JWKS file or ConfigMap) and **re-checks** the tenant/repo scope against its own rows. A static service token alone is rejected. |
| V5 | Tenancy today | The product has no tenants yet. todo2's kernel (Phase 4) introduces workspaces. Map **tenant = organisation** (a single `default` tenant in dev) and **project = workspace**. Every table and every object key carries `tenant_id` from day one, so real multi-tenancy needs no migration. |
| V6 | Repository granularity (question 3) | One repository per dataset, as the spec recommends. |
| V7 | Manifest format and chunking (questions 4 and 8) | **Phase 1:** one canonical JSON manifest per commit (fine up to about 10k samples). **Phase 3:** chunked **Parquet** manifests partitioned into **256 buckets by the first byte of `sha256(sample_id)`**. Buckets stay even regardless of modality, a 1% edit rewrites only the touched chunks, and the root lists 256 chunk hashes, so diffing only compares hashes first. Study/series grouping is an **index**, not the partition key. |
| V8 | Approvals after rebase, multiple bases (question 6) | Any change to the source head invalidates approvals. Rebase counts as a change. Multiple merge bases return a 409 in v1. |
| V9 | Deletion and withdrawal of regulated data (question 7) | History stays immutable, but bytes can be **purged**. A withdrawal creates a revert-style commit that removes the sample, then a reviewed `purge` operation deletes the artifact bytes and marks the artifact `purged`. Old commits still resolve, but checkout returns `410 purged` for those objects. Legal holds block purge. Write this as an ADR before enabling it. |
| V10 | Native `git clone`/push (question 5) | Not in v1. Use the manifest/object API and a future `studio pull` CLI. |
| V11 | Naming (todo2 D3) | No brand in code. Go module path is `studio.local/versioning`, a non-URL path that's fine for an internal module. Bucket names, the event subject prefix and env-var prefix come from config built from the naming config (`schemas/naming.json`). The spec's `inkling-objects`, `inkling-manifests` and `VERSIONING_*` become `${resourcePrefix}-objects`, `${resourcePrefix}-manifests` and `${envPrefix}VERSIONING_*`. |
| V12 | Where the history/review UI lives (spec §1 offers two options) | `apps/web/src/studio/core/versioning/`. Review and protected-branch guarantees are platform features, not optional plugins. Type-specific diff **previews** (mask overlays, video spans) are contributed by the matching plugins as renderers (todo2 Phase 2.3). |
| V13 | Semantic diff per annotation type (spec §3.3: "adapters … in plugins only through validated SDK contracts") | The Go service can't run plugin code. Plugins **declare** diff semantics in `plugin.yaml` under `annotations.diff` (key fields, a geometry tolerance such as `iou >= 0.98` or `max_vertex_delta_px`, and which fields conflict). The service validates these against a schema and applies them generically. Previews are rendered in the web app by the plugin. |

---

## Can this run alongside `todo3.md`?

**Mostly yes, with one hard rule and a few shared files.**

- **Hard rule:** start only **after `todo3.md` Phase A** (merging the three checkouts into one). Otherwise this work lands in yet another branch and has to be merged again. After Phase A, do it on a branch in `.worktrees/versioning` (todo3 R2).
- `apps/versioning/` is a **new folder**, so it doesn't collide with todo3's file moves. Phases 1–3 below (the Go service and its own tests on testcontainers) are fully independent of todo3 and todo2.
- **Files both plans touch:**
  - root `package.json`, `turbo.json`, `pnpm-workspace.yaml`;
  - `infra/docker/compose.yaml`, `infra/k8s/*`;
  - `.github/workflows/*`, `schemas/`, `AGENTS.md`, `docs/`.

  Whoever lands second adds their entry. These are additive one-section edits, never rewrites. Phase 5 below (wiring) waits until todo3 has created those files.
- **Depends on `todo2.md`:** Phase 6 (the gateway routes in `apps/api`, the agent tools and the web UI) needs todo2 Phase 4 (the kernel, auth context and command gateway) and Phase 2.3 (renderers). Don't start Phase 6 before those.

| Phase | Parallel with todo3? | Parallel with todo2? |
|---|---|---|
| 0, 1, 2, 3 (service core, semantics, scale) | Yes, after todo3 Phase A | Yes |
| 4 (contracts in `schemas/versioning`) | Yes. `schemas/` is additive. | Yes. Coordinate the `naming.json` read with todo2 0.1. |
| 5 (compose, k8s, CI, turbo) | After todo3 creates C.3, D.2, D.3 and F | Yes |
| 6 (api gateway routes, agent tools, web UI) | Yes | **After todo2 Phases 2.3 and 4** |

---

## Phase 0. Scaffold (half a day)

- [x] `mkdir -p apps/versioning`, then `go mod init studio.local/versioning` (V11). Pin with `go get github.com/go-git/go-git/v5@v5.19.3` and pin the others from the research table. In `go.mod`: `go 1.27`, `toolchain go1.27.3`.
- [x] Create the tree from `versioning.md` §1 with these changes:
  - `internal/storage/gitstorer.go` becomes the **Postgres Storer** (V1);
  - add `internal/jobs/` (River workers);
  - add `internal/authn/` (JWT verify, V4) next to `authz/`;
  - add `internal/api/` (oapi-codegen output; never edit it by hand);
  - add `internal/db/` (sqlc output) and `queries/*.sql`.
- [x] `apps/versioning/package.json` turbo shim (todo3 C.3):
  ```json
  { "name": "@studio/versioning", "private": true,
    "scripts": { "dev": "go run ./cmd/server", "build": "go build -o dist/ ./cmd/...",
                 "test": "go test -race ./...", "lint": "golangci-lint run", "typecheck": "go vet ./...",
                 "generate": "sqlc generate && go generate ./..." } }
  ```
- [x] `Makefile` targets: `generate`, `test`, `test-integration` (`-tags integration`), `fuzz`, `lint`, `vuln` (`govulncheck ./...`), `migrate-up`, `migrate-down`.
- [x] `.golangci.yml`: `errcheck`, `govet`, `staticcheck`, `gosec`, `revive`, `bodyclose`, `sqlclosecheck`, `contextcheck`, `forbidigo`. Use `forbidigo` to ban `memory.NewStorage` outside `_test.go`, and `fmt.Print*` outside `cmd/`.
- [x] `secrets/versioning.env.example`: the env vars from spec §15 with prefixes from V11, plus `…_JWT_PUBLIC_KEY_FILE` and `…_S3_ACCESS_KEY_ID/_SECRET`. Mention it in `secrets/README.md`.
- [x] `apps/versioning/README.md`: how to run it, and the architecture invariant from the last line of the spec.

## Phase 1. Proven Git metadata core (spec §18 phase 1, focused on 2-D images)

### 1.1 Config, server skeleton, health
- [x] `internal/config/config.go`: parse env once into a typed struct and validate it (addresses, URLs, bucket names, positive limits). Fail fast and print the missing **key names** only.
- [x] `cmd/server/main.go`:
  - `chi` router with middleware for request id, OpenTelemetry, a panic recovery that returns problem+json, a body-size limit and per-route timeouts;
  - graceful shutdown on `SIGTERM` (stop accepting, drain within 25 s).
- [x] `/healthz` (process only). `/readyz` pings Postgres and does an S3 `HeadBucket`, each with a 2 s timeout. `/version` reports the git SHA (ldflags), the go-git version and the schema version.

### 1.2 Database and migrations (V2)
- [x] `migrations/0001_init.sql` (goose):
  - `CREATE SCHEMA versioning`, plus every table from spec §11;
  - `git_objects(repo_id, oid, type smallint, size int, data bytea, PRIMARY KEY(repo_id, oid))`;
  - `git_refs(repo_id, name, target, PRIMARY KEY(repo_id, name))`, a projection only;
  - `repo_config(repo_id, data bytea)`;
  - `object_format` on `dataset_repositories`.

  Every row carries `tenant_id`. Add the indexes from spec §11, `UNIQUE(repo_id, branch, idempotency_key)` on `idempotency_records`, and `CHECK` constraints on branch-name format and status enums.
- [x] Row-level security: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` with the policy `tenant_id = current_setting('app.tenant_id')::uuid`. The service runs `SET LOCAL app.tenant_id` at the start of every transaction. That's a second layer behind the application checks (spec §14).
- [x] Roles: `versioning_owner` runs migrations; `versioning_app` gets DML on `versioning.*` only, with no `BYPASSRLS`.
- [x] `cmd/migrate/main.go`: goose up/down/status. Runs as the `versioning-migrate` k8s Job.
- [x] `queries/*.sql` + `sqlc.yaml` (pgx/v5 driver). One file per aggregate: repos, branches, commits, manifests, artifacts, reviews, releases, idempotency, outbox, audit.

### 1.3 Postgres `Storer` (V1), the riskiest piece, so build it first
- [x] `internal/storage/gitstorer.go` implements `storage.Storer` for one `repo_id`:
  - **`EncodedObjectStorer`:** `SetEncodedObject` (insert, ignoring duplicates), `EncodedObject`, `IterEncodedObjects`, `HasEncodedObject`, `EncodedObjectSize`. Reads go through an LRU (`cache.NewObjectLRU`) keyed by `(repo, oid)`; objects are immutable, so the cache is always valid.
  - **`ReferenceStorer`:** backed by `git_refs` as a **projection**. `CheckAndSetReference` is implemented with a conditional `UPDATE`, but the authoritative head stays in `repo_branches` (spec §4).
  - **`ShallowStorer`, `IndexStorer`:** no-ops or errors. Repos are bare with no worktree or index.
  - **`ConfigStorer`:** `repo_config` row. **`ModuleStorer`:** returns `ErrNotSupported`.
- [x] Use go-git's storer conformance suite from `github.com/go-git/go-git/v5/storage/test` against the Postgres storer (testcontainers Postgres). Every test must pass.
- [x] Benchmarks: write and read 10k commits, and walk the ancestry of a 10k-commit chain. Record the numbers in the README. _(recorded 2026-10-30 in `apps/versioning/README.md`: write 15.8 s, cold read 3.8 s, cold walk 4.3 s, warm walk 17 ms)_

### 1.4 Object store adapter
- [x] `internal/storage/blobstore.go`: an interface with `PutStaged(ctx, tenant, sha256, size, mediaType, r)` (streams, verifies the hash and length while uploading, rejects on mismatch), `Head`, `Get` (range reads), `PresignGet(ttl ≤ 5 min)`, `Delete` (GC only).
  - Keys are `{tenant}/sha256/ab/cd/<sha256>` (spec §3.2), never user filenames.
  - Implementations: `s3` (aws-sdk-go-v2; the endpoint and path-style options cover MinIO) and `localfs` (tests only).
- [x] Artifacts table lifecycle: `staged → available → (unreferenced) → purged`.

### 1.5 Canonical manifests (Phase 1 format, V7)
- [x] `internal/manifests/schema.go`: Go types generated from `schemas/versioning/dataset-manifest.schema.json` (Phase 4.1), or kept in sync with a test that validates generated samples against the schema.
- [x] `internal/manifests/canonical.go`: serialise with RFC 8785 (`gowebpki/jcs`). Normalise strings to NFC and sort samples by `sample_id`. Hash is `sha256(canonical bytes)`, written as `sha256:<hex>`.
- [x] The manifest root is uploaded to `${prefix}-manifests/{tenant}/{repo}/roots/<sha256>.json` and registered in `manifest_roots`.
- [x] `internal/gitengine/objects.go`: build the tree with `dataset.json`, `ontology.json`, `policy.json` and `provenance.json` (canonical JSON, pointer-sized), and a commit with author/committer **actor ids, never names or emails** (spec §14). Store both through the Postgres Storer.

### 1.6 Commit protocol (spec §5, exactly as written)
- [x] `internal/service/commits.go` `Commit(ctx, req)`. The order is load-bearing:
  1. authn (V4), then authz (tenant/repo/branch scope and quota);
  2. look up idempotency (a hit with the same request hash returns the stored response; a different hash returns 422);
  3. check that every referenced artifact belongs to this tenant and is `available` or `staged` with a matching hash;
  4. write the manifest root and the Git objects (**outside** any DB transaction);
  5. one DB transaction: the CAS `UPDATE repo_branches … WHERE commit_oid = :expected`, insert into `repo_commits`, `artifact_references`, `audit_events`, `outbox_events` and `idempotency_records`;
  6. zero rows updated returns **409** with `current_head` and `head_generation`;
  7. enqueue a reconcile job that promotes `staged` artifacts to referenced.
- [x] `branches.go`: create a branch from a commit (O(1)), list with a cursor, delete (tombstone plus retention; refused on protected branches).
  - Name validation: `^[a-z0-9][a-z0-9._/-]{0,127}$`; no `..`, `//` or `@{`; no trailing `/` or `.lock`; not `HEAD`; no control characters.
- [x] `releases.go`: create a tag that pins the commit and manifest root; immutable. Updating one returns 409 and deleting needs a retention check.
- [x] `repository.go`: create a repo, which writes an empty root commit and creates `main` as protected, in one flow.
- [x] Revert: a new commit whose manifest equals the target commit's manifest (spec §6).

### 1.7 Checkout
- [x] `POST /checkouts`: given a commit or tag plus an optional sample filter, returns the manifest (or a page of it) and **presigned GET URLs** (TTL ≤ 5 min, scoped to the listed objects). It writes an audit event for every checkout. A rate limit applies per actor.

### 1.8 Phase 1 tests (spec §17)
- [x] Unit: _(idempotency hit/miss/mismatch/scope in `internal/service/idempotency_test.go`, foreign-tenant rejection in `internal/service/artifacts_tenant_test.go`, against in-memory fakes)_
  - canonical hashing is stable across field order and Unicode normalisation (property test with `testing/quick`);
  - branch-name validation table, idempotency hit/miss/mismatch, rejection of foreign-tenant artifacts.
- [x] Integration (`-tags integration`, testcontainers Postgres + MinIO):
  - create repo → branch → 100 commits → tag → checkout, then verify every byte hash;
  - **20 concurrent commits on the same `expected_head`**: exactly 1 succeeds, 19 get 409, and identical-idempotency retries return the same response;
  - **crash between the Git write and the CAS** (inject a failpoint with a build-tagged hook): the retry succeeds, and the orphaned objects are picked up by the reconcile report;
  - restarting the container keeps branches and versions (MVP exit criterion 1).
- [x] Fuzz: `FuzzManifestDecode`, `FuzzBranchName`, `FuzzCanonicalJSON`.

## Phase 2. Dataset semantics (spec §18 phase 2)

### 2.1 Annotation revisions
- [x] The manifest has `annotations: [{annotation_id, revision_id, sample_id, kind, ontology_rev, ref}]`. `ref` points to an immutable annotation-revision document in object storage (canonical JSON).
  - `kind` is one of `box2d`, `polygon2d`, `mask2d`, `region3d`, `timespan`, `measurement` and `textspan`, matching the geometries in `plugin-contracts`.
  - `coordinate_frame` and `calibration` are versioned fields (spec §3.3).
- [x] Map the Studio's annotation model (todo2 `plugin-contracts` geometries) to these kinds in `schemas/versioning/annotation-revision.schema.json`, with **one** owner: `plugin-contracts` emits it. _(2026-10-30: zod source and `toAnnotationRevision` in `packages/plugin-contracts/src/annotation-revision.ts`. The mapping is box→box2d; polygon, polyline, spline and keypoint→polygon2d; 2D mask→mask2d (column-major RLE); 3D mask and point3d→region3d (voxel box); measurement→measurement; span and instant→timespan; module geometries via the plugin's `moduleKinds` (e.g. text spans→textspan). class, track, ellipse and multipolygon have no v1 kind. `pnpm emit:schemas` writes the file. Compared with the hand-written version, the only changes are an explicit `type: string` next to `const`/`enum`, a 2^53−1 `maximum` on integers, and a no-op `propertyNames`. `go test ./...` in `apps/versioning` passes)_

### 2.2 Semantic diff (spec §7)
- [x] `semanticdiff/dispatcher.go`: compare manifest roots, then (Phase 3) chunk hashes, then entries. Outputs paginated change records: `sample.added|removed|replaced`, `annotation.added|removed|changed{fields}`, `ontology.*`, `grouping.*`.
- [x] `annotations.go`: field-level comparison using the plugin-declared diff rules (V13). Tolerances are applied per `kind`, for example two masks with IoU ≥ threshold count as "unchanged geometry".
- [x] `taxonomy.go`: class added, removed or renamed (with a mapping), and required fields added.
- [x] Aggregates (counts, class balance, split membership) are computed synchronously when the diff is under N entries. Otherwise a River job writes the result to object storage, and `GET /diff` returns `202 {job_id}`.
- [x] Redaction: diff output contains ids and enums only, never free text from samples (spec §14).

### 2.3 Three-way merge (spec §8)
- [x] `merge/threeway.go`: `base = MergeBase(ours, theirs)`. If there are several bases, return `ErrMultipleMergeBases` (V8). Compute `Δours` and `Δtheirs` with the semantic diff, then apply the spec §8 table **exactly** as a rule table in code, with one test per row.
- [x] `conflicts.go`: persist `merge_conflicts` rows with a stable `conflict_key` (`sample:<id>` or `annotation:<id>:<field>`).
- [x] `resolutions.go`: choose ours, choose theirs, or a custom resolution (a new annotation revision). The resolved manifest is validated again before the merge.
- [x] Merge commit: two parents built with plumbing (go-git can't do it, per the research), then a CAS on the target head. A stale target returns 409 and moves the review back to `CHECKING`.

### 2.4 Review requests (spec §9)
- [x] `service/reviews.go`: the state machine as an explicit transition table. Invalid transitions return 409. Every transition writes an audit and outbox event.
- [x] Approvals belong to a `source_oid`. A source-head change clears approvals (V8). An author can't approve their own review, and an agent actor can't approve a review authored by itself or by `on_behalf_of` the same user.
- [x] Comments are anchored to `{sample_id | annotation_id, source_oid}`.
- [x] Checks: built-in River jobs run on immutable OIDs and write `review_checks`:
  - manifest referential integrity;
  - artifact existence and checksum;
  - schema compatibility;
  - geometry validity (in bounds, non-degenerate);
  - a de-identification gate: a hook that calls a worker check through an event and is blocked until the result arrives.

  Optional checks (leakage, class balance) report results but don't block.
- [x] Protected branches: direct commits to `main` return 403. Changes reach it only through a merged review with the required approvals and mandatory checks.

### 2.5 Phase 2 tests
- [x] A merge test table generated from spec §8: independent adds, identical edits, opposing labels, delete-vs-edit, ontology rename vs edit, a replaced raw sample, a criss-cross history (expect 409).
- [x] Review state-machine property test: random transition sequences never reach `MERGED` without approvals on the current `source_oid` and passing mandatory checks.
- [x] MVP exit criteria 3 (unapproved changes can't merge to `main`) and 6 (audit attributes every merge to an actor and a commit).

## Phase 3. Scale and recovery (spec §18 phase 3)

- [x] **Chunked Parquet manifests (V7):** 256 hash-bucketed chunks written with `parquet-go`; the root JSON lists `{bucket: chunk_sha256}`.
  - Unchanged buckets reuse their chunk hash, and diffs compare root entries first.
  - Indexes: `manifest_index(repo_id, root_hash, study_uid_hash, series_uid_hash, split, label_counts jsonb)` for filtering without reading chunks.
- [x] Partial checkout: a sample filter resolves to buckets, which are the only chunks fetched.
- [x] Streaming upload: multipart S3 uploads for objects over 64 MiB, with hashing while streaming. Staged uploads expire after a TTL.
- [x] **Outbox relay:** a River periodic job reads `outbox_events WHERE delivered_at IS NULL … FOR UPDATE SKIP LOCKED` and publishes to the event bus (Redis Streams via todo3 E.2 `EventBus`; the subject is `versioning.<event>` from spec §12). It marks events delivered. Consumers are idempotent by `event_id`.
- [x] **Reconciler** (`cmd/reconcile` plus a River periodic job). It detects and reports, and repairs where it's safe:
  - published commits whose objects are missing (this pages someone);
  - orphaned Git commits;
  - staged uploads older than the TTL;
  - a stale `git_refs` projection, rebuilt from `repo_branches`;
  - outbox gaps.
- [x] **GC** (`gc/mark.go`, `gc/sweep.go`):
  - mark roots from spec §13 (branch heads, releases, open reviews, the retention window, legal holds, active checkout leases);
  - walk the Git graph and the manifests;
  - sweep only objects that have been unreferenced for longer than `GC_GRACE_HOURS` and have no lease.
  - Sweeping is a separate, dry-run-by-default command, gated by a flag until retention is signed off (V9).
- [x] Limits: `MAX_COMMIT_ENTRIES`, a maximum diff page size, a maximum commit-walk depth per request, per-actor rate limits on diff and checkout, and request timeouts (spec §14).
- [ ] Load tests (`tests/load`, k6 or a Go harness against compose): _(partial: `tests/load/load_test.go` covers 100k/1M update→diff→merge→partial checkout, GC at 50 branches/200 releases, backup/restore; 100k results recorded in `apps/versioning/README.md` (2026-10-30, all pass). The 1M re-run reached only put-manifest (5 m 22 s) and commit (60 ms) before the Docker daemon went away 35 min in; the partial result and why are in the README)_
  - 100k and 1M entries, with a 1% update → diff → merge → partial checkout;
  - GC at 50 branches and 200 releases;
  - backup/restore (`pg_dump` plus a bucket copy), then verify every release.

  Record the results in `apps/versioning/README.md`.

## Phase 4. Contracts (in `schemas/`, shared with every language)

- [x] `schemas/versioning/`:
  - the six JSON Schemas from spec §1, plus `annotation-revision.schema.json` (2.1) and `openapi.yaml` (the spec §10 internal API);
  - problem+json errors with stable `code`s: `stale_head`, `idempotency_mismatch`, `multiple_merge_bases`, `protected_branch`, `purged`.
- [ ] `openapi.yaml` is the source of truth: _(partial: oapi-codegen server and the Python client in `apps/api/src/studio_api/clients/versioning/` exist; no CI regeneration/diff check yet)_
  - Go server interfaces via `oapi-codegen` (`go generate`);
  - a Python client for `apps/api` via `openapi-python-client`, output to `apps/api/src/studio_api/clients/versioning/` and regenerated in CI with a diff check;
  - no TS client, since browsers never call this service.
- [x] `plugin.yaml` schema (todo2 2.1): add the optional `annotations.diff` block (V13). This is a one-section edit to `plugin-manifest.ts`; coordinate with whoever owns todo2. _(2026-10-30: `annotations.diff` is a list of `AnnotationDiffRule`s (`packages/plugin-contracts/src/annotation-diff.ts`) matching the rule items of `annotation-diff-rules.schema.json`, at most one per kind and with iou thresholds in (0, 1]. A vitest checks the enums against that file. `schemas/plugin.v1.json` and the kernel's pydantic contracts are regenerated, and the kernel checks the same cross-field rules)_
- [ ] A CI drift check: regenerate everything and `git diff --exit-code`. _(partial: `make check-generated` regenerates and runs `git diff --exit-code`; no CI workflow runs it — `.github/workflows/` doesn't exist)_

## Phase 5. Wiring into the monorepo (after todo3 C.3, D.2, D.3 and F exist)

- [ ] **Turbo:** nothing extra; the shim from Phase 0 is enough. Optionally add a root `go.work` listing `./apps/versioning` (only useful once a second Go module exists).
- [ ] **Dockerfile:**
  - `golang:1.27` builder running `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X …version=$GIT_SHA"`;
  - final stage `gcr.io/distroless/static:nonroot` with the binaries `server`, `migrate` and `reconcile`;
  - read-only root filesystem.
- [ ] **compose** (`infra/docker/compose.yaml`):
  - service `versioning` on `:8090`, depending on `postgres` and `minio`;
  - a `minio-init` job creating `${prefix}-objects` and `${prefix}-manifests` with versioning enabled and public access blocked;
  - a `versioning-migrate` one-shot.
- [ ] **k8s** (`infra/k8s/base/versioning/`):
  - Deployment with **2 replicas** (the Postgres Storer allows it; spec §15's single-writer fallback isn't needed, but document it);
  - probes, PDB, ConfigMap and an HPA on CPU;
  - `versioning-migrate` Job and `versioning-reconcile` CronJob (hourly);
  - a `NetworkPolicy` allowing ingress **only from `api` and `worker`** pods and egress only to Postgres and object storage;
  - **no Ingress route**, because it's internal only (spec §2).
- [ ] **Secrets** (todo3 D.4): `versioning-secrets` with `DATABASE_URL` (the `versioning_app` role) and the bucket credentials scoped to the two buckets. The JWT public key comes from a ConfigMap; the private key lives only in `api-secrets`.
- [ ] **CI** (`.github/workflows/ci.yml`): a `go` job running `go vet`, `golangci-lint`, `go test -race ./...`, `govulncheck`, the integration tests (Docker service containers) and the codegen drift check. Path filter: `apps/versioning/**`, `schemas/versioning/**`.
- [ ] **Docs:** move `versioning.md` to `docs/versioning.md` alongside todo3 B.1's doc move, and add a row to the root `README.md` (an `apps/versioning` section and a `schemas/versioning` mention). Add `docs/adr/0002-versioning-storage.md` covering V1, V2, V4 and V9.

## Phase 6. Platform integration (spec §18 phase 4; after todo2 Phases 2.3 and 4)

- [ ] **`apps/api`** (`src/studio_api/routes/versioning.py`): the public routes mirror spec §10 under `/api/v1/datasets/{id}/…`.
  - Each handler authenticates the user, checks workspace permissions, mints the V4 JWT, calls the generated client, and writes a kernel audit entry.
  - Each route is registered as a kernel **command** (`<ns>.versioning.commit`, `.branch`, `.diff`, `.review.open`, `.review.approve`, `.merge`, `.release`, `.checkout`), so the gateway, the agent and MCP get them for free.
- [ ] **Studio save flow:** today annotations are saved to the dataset. Switch to a working branch per user per dataset (`work/<actor-id>/<dataset>`). "Save" becomes a commit with `expected_head`; a 409 shows "someone else saved; refresh and re-apply". "Submit for review" opens a review into `main`.
- [ ] **Web UI** (`apps/web/src/studio/core/versioning/`, V12):
  - a branch switcher in the top bar;
  - a history panel with a commit list and a revert action;
  - a review page (diff list grouped by sample, with a conflict-resolution UI choosing ours/theirs/custom, approvals and checks);
  - a releases list.

  Type-specific previews come from plugin renderers through a `diffPreview` contribution type, added to the todo2 2.3 renderer registry.
- [ ] **Agent** (`apps/agent`, after todo1 is done): kernel tools `dataset_branch`, `dataset_commit`, `dataset_diff` and `dataset_open_review`, under the existing approval policy:
  - commits to `work/agent-*` branches are allowed;
  - opening a review needs user approval;
  - approve and merge are **never** exposed to the agent (spec §16C).
- [ ] **Worker:** subscribe to `versioning.review.opened` to run the de-identification check, and post the result back through the api command.
- [ ] **MCP:** nothing extra; the commands appear automatically through the gateway.
- [ ] **e2e** (`tests/e2e/versioning/`):
  - flow A (initial upload, then `v1` visible);
  - flow B (two users edit the same annotation → conflict → resolve → merge → release);
  - flow C (an agent proposes a change on its branch → a human approves → merged; the agent's attempt to approve is rejected).

## Phase 7. Acceptance (spec §17 MVP exit criteria and load checks)

| Criterion | Test |
|---|---|
| Refs survive restarts | `integration/restart_test.go` (1.8) + k8s pod-kill in `tests/e2e/versioning/chaos_test.py` |
| Same data, reproducible commit, verified bytes | `manifests/canonical_test.go`, `integration/checkout_verify_test.go` |
| Unapproved changes can't merge to protected `main` | `service/reviews_property_test.go`, e2e flow C |
| A stale or concurrent write never replaces newer work | `concurrency/cas_test.go` (20 writers), `merge/stale_target_test.go` (done as `tests/integration/stale_target_test.go`) |
| Every published version is retrievable and verified | `integration/release_verify_test.go` (iterates all releases; done) |
| Audit attributes every merge and revision | `integration/audit_test.go` |
| The reconciler handles orphans without deleting reachable data | `integration/reconcile_test.go` + `gc/mark_test.go` (reachable set ⊇ all roots; done as `tests/integration/gc_mark_test.go`) |
| Cross-tenant references are denied even with known hashes | `authz/tenant_test.go` + RLS test running raw SQL as `versioning_app` with the wrong `app.tenant_id` |
| Scale | Phase 3 load results recorded, with 1M entries at a 1% update finishing diff and merge within the agreed budget |

**Done when** every row above passes in CI (or the scheduled load job), `docs/adr/0002` is merged, and the Studio's save, review and release flows run on `main` against compose and the dev k8s overlay.
