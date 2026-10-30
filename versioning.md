# Inkling Dataset Versioning — Implementation Specification

**Status:** Proposed architecture / implementation-ready design, subject to load testing  
**Owner:** Inkling platform  
**Primary implementation:** Go service (`apps/versioning`) using `go-git`  
**Last reviewed:** 2026-10-29  
**Scope:** Dataset commits, branching, review requests, semantic diffs, merges, releases, and manifest/object lifecycle. **Pipeline orchestration is intentionally out of scope.**

## 0. Decision summary

Inkling presents each dataset as a **stateful, Git-like repository**. Collaborators and agents create branches, commit changes, request review, resolve semantic conflicts, merge and publish immutable releases. Use the open-source **`go-git` library** to write and read real Git commits, trees, blobs (metadata only), and history. Use object storage (S3/MinIO/GCS through a storage adapter) for raw scientific data, images, DICOM, masks, videos and large tables. Store transactionally authoritative application state and branch heads in PostgreSQL.

**Do not put large data inside Git. Do not model each file as a Git blob. Do not rely on go-git to perform a complete merge:** its v5 documentation explicitly notes missing high-level merge porcelain. Implement a **three-way semantic merge** for datasets, backed by common-ancestor calculations from the commit graph. Pull requests / feedback requests are an Inkling application feature, not a Git feature.

### Non-goals for v1

- Hosting a general-purpose Git forge, implementing Git smart HTTP/SSH fetch/push, or promising compatibility with `git clone` for all dataset bytes.
- Replicating Git LFS, DVC, lakeFS, or an entire lakehouse architecture.
- Pipeline execution / scheduling (this will be a separate architecture decision).
- CRDT/live collaborative editing or arbitrary binary merge.
- Storing or exposing raw PHI in Git, commit messages, audit records or object keys.
- Atomic distributed transactions across PostgreSQL, Git object storage and S3. Use staged immutable objects and reconciliation instead.

## 1. Respect existing monorepo boundaries

The existing repo uses `apps/*` for separately deployable services; applications must not import each other. Keep `apps/api` (Python/FastAPI) as authenticated kernel/command gateway, `apps/agent` (Node + Pi/Daytona as presently specified), `apps/worker` (Python for medical/scientific operations), `apps/mcp` and `apps/web`. The new Go versioning service communicates **only via versioned APIs and events**. Shared cross-language contracts remain in `schemas/`, with generated clients in `packages/`.

```text
inkling/
├── apps/
│   ├── web/                         # Existing React UI; dataset history/review UI only
│   │   └── src/studio/core/versioning/  # Or plugin contribution, per extension-host policy
│   ├── api/                         # Existing FastAPI; auth, policies, command gateway
│   │   └── src/studio_api/routes/versioning.py
│   ├── agent/                       # Existing Node/Pi agent; uses API gateway, never raw Git refs
│   ├── worker/                      # Existing Python data processing
│   ├── mcp/                         # Uses kernel commands only
│   └── versioning/                  # NEW deployable Go service
│       ├── go.mod
│       ├── go.sum
│       ├── Dockerfile
│       ├── Makefile
│       ├── cmd/
│       │   ├── server/main.go       # Internal HTTP/gRPC server
│       │   ├── migrate/main.go      # If migrations are Go-owned
│       │   └── reconcile/main.go    # Scheduled consistency repair
│       ├── internal/
│       │   ├── config/config.go
│       │   ├── server/{router,handlers,middleware}.go
│       │   ├── service/
│       │   │   ├── repository.go
│       │   │   ├── commits.go
│       │   │   ├── branches.go
│       │   │   ├── reviews.go
│       │   │   ├── merges.go
│       │   │   └── releases.go
│       │   ├── gitengine/
│       │   │   ├── repository.go     # go-git storage adapter
│       │   │   ├── objects.go        # Git trees / blobs / commits
│       │   │   ├── ancestry.go       # Merge base(s)
│       │   │   └── refs.go           # Do not use for authoritative concurrent heads
│       │   ├── manifests/
│       │   │   ├── schema.go
│       │   │   ├── chunks.go
│       │   │   ├── index.go
│       │   │   └── canonical.go
│       │   ├── semanticdiff/
│       │   │   ├── dispatcher.go
│       │   │   ├── samples.go
│       │   │   ├── annotations.go
│       │   │   ├── taxonomy.go
│       │   │   └── schema.go
│       │   ├── merge/
│       │   │   ├── threeway.go
│       │   │   ├── conflicts.go
│       │   │   └── resolutions.go
│       │   ├── storage/
│       │   │   ├── blobstore.go      # Interface, S3 implementation
│       │   │   ├── postgres.go
│       │   │   └── gitstorer.go      # Explicitly selected persistent Git storage
│       │   ├── authz/
│       │   │   ├── scope.go
│       │   │   └── policy.go
│       │   ├── events/outbox.go
│       │   ├── gc/{mark,sweep}.go
│       │   └── observability/
│       ├── migrations/
│       ├── tests/
│       │   ├── integration/
│       │   ├── compatibility/
│       │   ├── concurrency/
│       │   └── fuzz/
│       └── README.md
├── schemas/versioning/
│   ├── dataset-repository.schema.json
│   ├── dataset-manifest.schema.json
│   ├── dataset-commit.schema.json
│   ├── review-request.schema.json
│   ├── semantic-diff.schema.json
│   └── events.schema.json
├── packages/
│   ├── plugin-contracts/            # Existing canonical TS/Zod contracts
│   └── api-client/                  # Generated TS client, not direct DB access
├── infra/
│   ├── docker/                      # Add service and MinIO bucket provisioning
│   └── k8s/base/versioning/         # Deployment, Service, probes, policies
├── docs/versioning.md              # This document (or root versioning.md)
└── tests/e2e/versioning/
```

**Why not `packages/dataset-repo` alone?** A library cannot independently enforce authorization, concurrent ref updates, audit, quotas, and garbage collection across service instances. Keep these responsibilities in the service. Pure Go utility packages can be extracted later when another Go app actually needs to import them.

## 2. Architecture and boundaries

```text
Browser / Agent / MCP / Plugin
            |
            v
       apps/api gateway   ---> authz + audit + idempotency
            |
            v (internal authenticated API)
      apps/versioning (Go)
         |           |
         v           v
   PostgreSQL      Git object store + S3/MinIO raw data
   refs, PRs,      metadata commits, immutable manifests,
   leases, ACLs    raw object blobs and derived artifacts
         |
         v
   transactional outbox --> events --> apps/worker / future pipeline service
```

- Web and agents **never** call the versioning service directly with privileged credentials. API gateway validates end-user identity and organization/project scopes, issues scoped service-to-service context, and logs commands.
- Versioning service **revalidates** tenant/repository scope. Service-token authentication alone is insufficient.
- The Go versioning service creates immutable repository snapshots and offers semantic dataset operations. It **does not execute user code**.
- Workers only submit proposed changes via authorized APIs, referring to immutable source commits.
- A future pipeline engine consumes pinned commits and produces candidate branches/commits through the same APIs. No coupling to Temporal/Prefect/Dagster now.

## 3. Source-of-truth model

### 3.1 Logical entities

1. **DatasetRepository:** tenant-scoped logical container; ID, project ID, retention/privacy policy, default branch.
2. **Sample:** stable opaque sample ID, optional asset grouping (study, series, sequence), content hashes and descriptive metadata.
3. **Artifact:** immutable raw or derived object (checksum, byte length, media type, object store key, provenance), with access controls outside Git.
4. **Manifest:** immutable, canonical references from stable sample IDs to objects, annotation revision IDs, ontology/schema revision IDs. Use chunked manifests and indexes.
5. **Commit:** real Git commit with parents, author, timestamp, message and a Git tree referencing **small metadata** and manifest-root pointers.
6. **Branch/tag:** mutable branch head or immutable publication tag that points at a commit. PostgreSQL is the authoritative branch-head registry.
7. **ReviewRequest:** source/target, expected reviewed source SHA, approvals, checks, comments, state and merge outcome.
8. **DatasetRelease:** immutable named release of a commit with validation attestations and retention rules.
9. **LineageRecord:** input commit(s), producing tool/pipeline/code digest, parameters digest, actor and output commit. Store deep provenance in Postgres/object store, not huge Git commit messages.

### 3.2 Object layout

```text
s3://inkling-objects/{tenant-id}/sha256/ab/cd/<content-sha256>
s3://inkling-manifests/{tenant-id}/{repo-id}/chunks/<sha256>.parquet
s3://inkling-manifests/{tenant-id}/{repo-id}/roots/<sha256>.json
# Git objects: persistent go-git Storer, tenant-scoped and backup-enabled.
# Never use mutable human-readable paths as proof of identity or authorization.
```

Object keys deliberately avoid patient names and source filenames. Raw file names may be held as restricted metadata, not public identifiers. Compute SHA-256 of raw payloads and verify after upload; Git object hashes are separate and follow Git's own object encoding. Do not equate a Git SHA with a raw-object SHA-256.

For v1 Git trees, use compact pointers:

```text
.git tree at commit:
  dataset.json            # dataset identity, schema version, manifest-root hash
  ontology.json           # ontology revision reference
  policy.json             # validation/publish policy revision reference
  provenance.json         # small provenance reference, not full logs
```

Use canonical serialization (stable field ordering, normalized strings, fixed encoding rules) for pointer documents; test reproducible hashing. Large manifests live outside Git and are immutable. Partial checkout downloads only requested chunks and underlying objects.

### 3.3 Annotation semantics

An annotation is not a rewrite of the image. Store immutable annotation revisions identified by sample ID, annotation ID, ontology version and geometry coordinates/references. Distinguish 2-D boxes, masks, 3-D regions, time spans, measurements and text spans; version geometry coordinate frames and calibration data. Implement semantic diff adapters by annotation type in plugins only through validated SDK contracts; central service owns merge policy and stable IDs.

## 4. Why go-git, and its limits

Use `github.com/go-git/go-git/v5` **at a pinned audited release** initially. Evaluate stable v6 only after compatibility and migration tests. go-git supports lower-level Git objects and a pluggable `storage.Storer` interface; built-in filesystem and memory storers are documented. Use a persistent storer backed by durable storage with clear consistency semantics; **never use memory storer in production**. The go-git v5 documentation states that its higher-level merge porcelain is incomplete; Inkling must supply three-way semantic merge. See sources at the end.

Avoid assuming the library supplies a transactional distributed ref registry. PostgreSQL remains authoritative for branches. Persist Git objects first, then conditionally move the authoritative Postgres branch head after verification. Provide a repair process for orphaned objects and incomplete operations. Treat `git clone`, `fetch`, and `push` as a later optional Git transport gateway rather than automatic functionality of this service.

## 5. Commit protocol (safe under concurrency)

1. Authorize user/service and validate project, repo, branch, quota and action.
2. Require an `expected_head` commit hash and idempotency key for all writes.
3. Upload/stage immutable raw objects and manifest chunks, verify checksum/length and that references are tenant-authorized; mark objects staged.
4. Build a canonical manifest root and write a Git tree and Git commit pointing to it. New commit parent must equal `expected_head` for ordinary linear commits.
5. PostgreSQL transaction: `UPDATE branch_heads SET commit_oid=:new, generation=generation+1 WHERE repo_id=:repo AND name=:branch AND commit_oid=:expected` (plus tenant scope). If zero rows affected, return HTTP 409 with current head and do not overwrite.
6. Record commit metadata, reachability roots, audit event and transactional outbox event within the same database transaction.
7. Mark candidate objects reachable / finalize staged references via idempotent asynchronous reconciliation. Orphaned immutable objects may later be garbage collected after grace period.

Use a unique `(repo, branch, idempotency_key)` or equivalent scoped deduplication record to make API retries safe. Do not hold a DB transaction while performing slow object uploads. Ensure commits are durably present before publishing their head. Keep a tombstone/retention period for branch deletion and force pushes. Prefer no force-push on protected branches.

## 6. Branches, tags, and releases

- `main` is protected by default; edits occur on private/project branches.
- Branch names use strict path validation and tenant-scoped uniqueness; reject control characters, ambiguous refs and names resembling Git control paths.
- Creating a branch references an existing commit (O(1) in dataset byte volume); no physical copy.
- Tags/releases pin immutable commit IDs and relevant referenced object roots. Protect release tags from mutation.
- Revert creates a new commit restoring a previous manifest, rather than deleting history.
- Allow branch expiration and per-tenant quotas. Long-lived tags, open reviews and legal holds protect reachable objects from GC.

## 7. Semantic diff API

Compute a logical diff **without downloading every raw object**. Compare manifest-root/chunk hashes first, then only changed partitions. Result should include:

- Added/deleted sample IDs and changed blob references.
- Changed annotations: label, geometry, confidence, reviewer, status, provenance.
- Ontology/schema changes, new required fields, removed classes.
- Sample grouping changes (e.g., DICOM study/series organization).
- Aggregate changes: counts, class balance, split membership, suspicious duplicates; expensive checks may run asynchronously.
- Type-specific preview refs: bounding-box overlays, mask overlays, video timestamps, tabular row changes, 3-D scene differences.

Expose paginated `GET /diff?base=<oid>&head=<oid>&cursor=...`; large diffs return a job ID and artifact-backed result. Data redaction and preview entitlements apply to every request. Avoid including PHI in diff text.

## 8. Three-way merge and conflicts

Use common ancestors from Git history and compare **base → ours** and **base → theirs**, then produce a new merged manifest plus a two-parent Git merge commit after approval. Never simply overwrite the target branch or assume go-git can merge binary objects.

| Change | Default behavior |
|---|---|
| Independent additions at different sample IDs | Auto-merge |
| Distinct annotations on one image | Merge if IDs/geometry constraints allow |
| Same annotation changed to different labels | Conflict |
| Deleted sample vs updated annotation | Conflict |
| Ontology rename/mapping vs annotation edits | Revalidation + possible conflict |
| Two revisions of same raw sample | Conflict or explicit versioned replacement |
| Identical changes on both sides | Deduplicate |

Conflicts are persisted as first-class records with sample ID, paths, base/ours/theirs and proposed resolution. A reviewer can choose one side or produce a new resolution. Recompute checks and approval validity if source or target heads change. Before merging use an atomic conditional target-head update; stale requests must be rebased/revalidated. For v1 support a single unambiguous merge base; if criss-cross history has multiple merge bases, fail safely or implement recursive merge-base resolution later.

## 9. Review requests (PR / feedback request)

State machine:

```text
DRAFT -> OPEN -> CHECKING -> READY -> MERGING -> MERGED
                    |           |
                  BLOCKED     CONFLICTED
OPEN/READY/BLOCKED/CONFLICTED -> CLOSED
```

ReviewRequest fields: ID, tenant/repo, source branch and source head, target branch and target head at evaluation, author, title/description, checks, required approvals, comments, conflict records, merge commit, timestamps, actor audit. Support line-less sample/annotation comments anchored to stable IDs and source commit. Approval belongs to a specific commit SHA; new changes invalidate approvals unless policy explicitly allows otherwise. Protected `main` requires validations and review. Agent-proposed commits cannot self-approve under the same identity.

Potential validation checks: manifest referential integrity, raw object checksum existence, schema compatibility, annotation geometry validity, de-identification gate, leakage and class balance reports. Block merges on mandatory failures. Checks run on immutable commit IDs; do not trust user-supplied pass/fail flags.

## 10. Internal service API (proposed)

External clients go through `apps/api` kernel command gateway; these endpoints are internal to the versioning service:

```text
POST /internal/v1/repos
GET  /internal/v1/repos/{repo_id}
POST /internal/v1/repos/{repo_id}/branches
GET  /internal/v1/repos/{repo_id}/branches
POST /internal/v1/repos/{repo_id}/commits  # expected_head + idempotency_key
GET  /internal/v1/repos/{repo_id}/commits/{commit_oid}
GET  /internal/v1/repos/{repo_id}/diff?base=&head=&cursor=
POST /internal/v1/repos/{repo_id}/reviews
GET  /internal/v1/repos/{repo_id}/reviews/{review_id}
POST /internal/v1/repos/{repo_id}/reviews/{review_id}/approve
POST /internal/v1/repos/{repo_id}/reviews/{review_id}/merge
POST /internal/v1/repos/{repo_id}/releases
GET  /internal/v1/repos/{repo_id}/releases/{tag}
POST /internal/v1/repos/{repo_id}/checkouts  # returns scoped manifest and signed object URLs
GET  /healthz
GET  /readyz
GET  /version
```

Prefer opaque UUID/ULID repository identifiers and commit OIDs; use cursor pagination with stable sort. Responses include `request_id`, `head_generation`, and applicable ETag; write operations require authenticated actor context and idempotency keys. Signed object URLs must be short lived, scope-bound and audited; don't expose object-store master credentials. Reserve explicit endpoints for aborting staged commits and deleting branches with retention safeguards.

Example commit request:

```json
{
  "branch": "review/fix-labels",
  "expected_head": "<git-commit-oid>",
  "manifest_root": "sha256:<manifest-root-hash>",
  "message": "Correct imaging annotations",
  "idempotency_key": "<client-generated-uuid>"
}
```

All object/manifest references must be registered and validated; a client-supplied manifest hash alone is not proof that its contents are authorized or even present.

## 11. Database outline

Use PostgreSQL tables with tenant/repository identifiers on every relevant row:

```text
dataset_repositories(id, tenant_id, project_id, default_branch, policy_id, created_at)
repo_branches(repo_id, name, commit_oid, generation, protected, updated_at)
repo_commits(repo_id, oid, manifest_root, author_id, created_at, parent_oids, status)
manifest_roots(root_hash, repo_id, schema_version, object_key, created_at)
artifacts(id, tenant_id, content_sha256, size_bytes, media_type, storage_key, status)
artifact_references(repo_id, root_hash, artifact_id)
review_requests(id, repo_id, source_branch, source_oid, target_branch,
                checked_target_oid, status, merge_oid, created_at)
review_approvals(review_id, reviewer_id, approved_source_oid, created_at)
review_checks(review_id, source_oid, target_oid, name, outcome, artifact_ref)
merge_conflicts(review_id, conflict_key, base_ref, ours_ref, theirs_ref, resolution)
dataset_releases(repo_id, tag, commit_oid, created_at, retention_policy)
idempotency_records(scope_key, key, request_hash, response_json, expires_at)
audit_events(id, tenant_id, repo_id, actor, event_type, payload_ref, created_at)
outbox_events(id, event_type, entity_id, payload, delivered_at)
```

Adapt column names, constraints, foreign keys and RLS to existing API data model; use one migration owner and explicit service DB grants. Repository refs must be consistent with commit-object presence. Use indexes on `(repo_id, name)`, `(repo_id, oid)`, review status, and event delivery state. Treat application SQL rows as the authoritative ref registry and Git refs as projections for interoperability, if materialized.

## 12. Events and future pipelines

Publish through transactional outbox; consumers must be idempotent:

```text
versioning.commit.created
versioning.branch.updated
versioning.review.opened
versioning.review.checks_completed
versioning.review.merged
versioning.release.published
versioning.artifact.unreferenced
```

Events carry opaque IDs, tenant scope, immutable commit OIDs, event ID, version and timestamp; do not carry raw medical data. A future pipeline service can subscribe to `versioning.release.published` or to branch updates, pin its input commit, and later request creation of a candidate commit. **No automatic pipeline selection or orchestrator dependency in v1.**

## 13. Garbage collection, retention and repair

- Mark roots from branch heads, releases, open reviews, retained historical commits, running jobs, audit/legal holds and restore windows.
- Walk the Git graph and manifest DAG; mark referenced object IDs. Garbage-collect **only after a quarantine/grace window** and no active lease.
- No tenant-crossing physical deduplication in MVP; simplifying isolation and deletion rights takes precedence over saving bytes.
- Reconciler detects missing objects referenced by published commits, orphaned Git commits, staged uploads older than TTL, stale Git ref projections and outbox delivery gaps.
- Back up Postgres and Git object storage consistently and practice restore; protect against GC racing backups or in-flight commits.
- Define retention and deletion rules for sensitive/scientific datasets before enabling automated deletion. Object storage lifecycle policies alone cannot know Git reachability.

## 14. Security and medical-data considerations

- **Tenant isolation** is enforced at the API gateway **and** the versioning service, with scoped DB access and authorized object retrieval.
- Never pass raw patient identifiers into Git author names, commit messages, branch names, object keys or logs.
- Encrypt at rest and in transit. Require strict storage-bucket permissions and secret rotation.
- Restrict export of sensitive samples, artifact preview and dataset checkout independently of commit-history permissions.
- Validate all manifest references, annotation geometry, content types, file sizes and paths; use safe parsing of archives in workers.
- Do not assume using open-source libraries provides HIPAA compliance. Add deployment-specific policies and audit requirements before processing PHI.
- Protect `main` and releases; require review for destructive changes; record impersonation/service-actor provenance for agents.
- Rate-limit diff/checkout requests, cap manifest traversal, and protect against zip bombs / enormous commit walks.

## 15. Local development and boot

In the existing monorepo, add `apps/versioning/go.mod` and register the service in `infra/docker/compose.yaml`. Use a pinned supported Go toolchain and lock go-git via `go.mod`/`go.sum`.

```sh
# in apps/versioning
go mod init example.com/studio/versioning  # replace with actual repository module path
go get github.com/go-git/go-git/v5@<pinned-tested-version>
go mod tidy
go test ./...
go run ./cmd/server
```

`<pinned-tested-version>` is a placeholder: choose and pin a tested stable release, **do not paste it literally into a shell**. The server requires Postgres, MinIO/S3, an internal service authentication secret and separately scoped bucket credentials. Provide `.env.example`, not committed real secrets.

```dotenv
VERSIONING_HTTP_ADDR=:8090
VERSIONING_DATABASE_URL=postgres://versioning:***@localhost:5432/studio?sslmode=disable
VERSIONING_OBJECT_ENDPOINT=http://localhost:9000
VERSIONING_OBJECT_BUCKET=inkling-objects
VERSIONING_MANIFEST_BUCKET=inkling-manifests
VERSIONING_GIT_STORAGE_DIR=./.dev-git-objects
VERSIONING_MAX_COMMIT_ENTRIES=100000
VERSIONING_DEFAULT_BRANCH=main
VERSIONING_GC_GRACE_HOURS=168
```

For local development `.dev-git-objects` can be a persistent volume. **For production, ephemeral pod-local Git directories are forbidden** unless backed by a documented durable storage protocol. Evaluate a purpose-built `Storer` or dedicated volume-backed repository service, with multi-replica tests and explicit recovery strategy. Launch one writer replica initially if necessary; scale only after durable object persistence and ref coordination tests pass.

Go endpoints: `/healthz` verifies process liveness, `/readyz` verifies DB/object-store access (bounded timeout), `/version` reports build SHA, git library version and schema version. Wire OpenTelemetry propagation from `apps/api` and log request IDs without leaking object contents.

## 16. Example workflows

### A. Initial upload

1. User uploads files through the API to staging in object storage.
2. Worker validates content, computes checksums, extracts safe metadata.
3. Versioning creates manifest chunks/root and root Git commit.
4. Transactionally creates `main` at that commit; emits `commit.created`.
5. UI shows version `v1` and individual ingestion issues, not a false all-or-nothing success.

### B. Human feedback request

1. Reviewer creates `review/labels` from main head.
2. Annotation tools submit edits to that branch, creating new immutable annotation revisions and commits.
3. Reviewer opens a feedback request; service calculates semantic diff and runs checks.
4. Required approvals are associated with source SHA.
5. Merge computes 3-way result and conditionally updates `main`; conflict or stale target => request refreshed, never silent overwrite.

### C. Agent proposal

1. Agent runs in Daytona, reads only scoped samples and tool API.
2. Agent calls authorized API to create proposal branch and submit annotations/data artifact pointers.
3. Versioning validates references and makes immutable commit.
4. Agent opens review; human or policy-authorized reviewer approves. Agent does not bypass approval.

### D. Later: pull / checkout

1. Client requests commit or tag and optional sample filter.
2. Server returns small manifest index, object hashes and short-lived authorized download links.
3. Client fetches only needed chunks/data. Local changes produce candidate manifest deltas for a future commit.
4. Git native smart HTTP/SSH support requires a separate compatibility design and auth scheme; not promised in v1.

## 17. Testing strategy and acceptance criteria

### Unit tests

- Canonical manifest serialization produces identical hashes for equivalent input.
- Stable sample ID and annotation revision semantics; schema migration and ontology diff.
- Merge combinations: independent adds, identical edits, opposing edits, delete-vs-edit, changed ontology, multi-parent history.
- Invalid branch names, unauthorized artifact pointers, missing hashes, malformed manifests.

### Integration tests (Postgres + MinIO + real go-git)

- Create repo → branch → 100 commits → tag → diff → review → merge → checkout immutable output.
- Kill service after Git-object write but before ref CAS: retry is idempotent, incomplete commit safely collectable.
- Kill service after DB CAS before event delivery: outbox later emits exactly-once *effect* with idempotent consumers.
- 20 concurrent commits against same expected head: exactly one successful branch advancement, others 409 (unless identical idempotent retries).
- Rebuild Git ref projections from PostgreSQL; detect and repair missing objects.
- Deny cross-tenant object references even if hashes are known.

### Load/scale checks before production

- 100k and 1M manifest entries, 1% update diff, merge and partial checkout.
- Millions of raw objects without giant Git trees or per-image Git blobs.
- Worst-case ontology-change fanout; large semantic-diff pagination.
- Storage growth and GC at multiple release/branch counts; backup restore and corrupted-object detection.
- Repo-wide search/filters are index-backed (Postgres/Parquet or later format) rather than recursively reading all raw objects.

### MVP exit criteria

- Version and branch references survive container/pod restarts.
- Same-data commit is reproducible and byte references are verified.
- Unapproved changes cannot merge to protected main.
- A stale or concurrent write never replaces newer work.
- Every published version can be retrieved and its blob references verified.
- Audit trail attributes all merges and revisions to user/service actor and exact commit.
- Reconciler handles orphaned objects and incomplete staging without deleting reachable data.

## 18. Implementation phases

**Phase 1 — Proven Git metadata core:** Persistent go-git storage, Postgres branch-head CAS, S3 adapter, versioned compact manifest, create/list commits/branches/tags, basic checkout and tests. Focus on one modality, e.g. 2-D images.

**Phase 2 — Dataset semantics:** Annotation revisions, semantic diffs, three-way merge, conflict records, review requests, approvals, validation checks, protected branches.

**Phase 3 — Scale and interoperability:** Chunked manifests, indexing, partial checkout, streaming upload, retention/GC, comprehensive recovery, load tests, export format. Only then consider Git smart HTTP/SSH gateway if demanded by users.

**Phase 4 — Platform integrations:** Agent tools through command gateway, plugin-specific diff renderers, future pipeline events, advanced release/lineage policies, branch templates, compare/revert UI.

## 19. Open questions / ADRs

1. Git SHA-1 default vs Git SHA-256 object-format compatibility: pin strategy and verify go-git support before any repository format migration; raw artifact hashes remain SHA-256 regardless.
2. Actual Git object storage in production: durable filesystem with one designated writer, database-backed Storer, or object-store-backed custom Storer—test read-after-write and concurrency first.
3. Repository granularity: one repo per dataset (recommended MVP) versus multi-dataset repository.
4. Manifest chunk partitioning by stable sample ID vs modality/study; optimize update granularity and semantic diff access.
5. Whether to expose native Git transport, Git LFS, or a dedicated `studio pull` CLI; current plan is manifest/object API.
6. Policy for approvals after rebasing and for multiple common ancestors.
7. Retention and deletion policy for regulated data; how to handle immutable old versions and withdrawal requests.
8. Whether annotations should physically use JSON/Parquet/Lance while retaining unchanged logical commit semantics.

## 20. Source references (reviewed for architectural claims)

- go-git source and maintenance: https://github.com/go-git/go-git
- go-git documented v5 API and limitations (notably merges): https://pkg.go.dev/github.com/go-git/go-git/v5
- go-git storage extensibility (`Storer`): https://github.com/go-git/go-git/blob/main/EXTENDING.md
- go-git release history: https://github.com/go-git/go-git/releases
- Git conditional reference-update semantics (reference design, **not** a claim of automatic Go API support): https://git-scm.com/docs/git-update-ref

---

**Architecture invariant:** Git commits describe **which immutable dataset artifacts and annotation revisions belong to a snapshot**; object storage holds the bytes; PostgreSQL controls authoritative refs and review policy; only authorized Inkling services may publish changes. Pipelines and agents produce proposals through this boundary, never silently mutate a published dataset.
