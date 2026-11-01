# Pipelines on Google Cloud: first deploy, then the pipeline service

**Goal.** Two things, in this order:

1. **Part A — deploy the platform on Google Cloud** for the first time: `spurby-phi`, `spurby-data`
   and `spurby-ai` stacks applied, clusters running, perimeter enforced, everything on synthetic data.
2. **Part B — build the pipeline service** from `docs/pipeline.md`: a Go service on DBOS that turns
   uploads into validated candidate dataset versions, inside `spurby-phi`, reusing the kernel job
   queue, the worker and the versioning service.

Part B's Milestone 0 runs locally and doesn't wait for Part A. Milestone 1 ships to Google Cloud on
top of Part A.

**Status (2026-11-01, night).** Part B Milestones 0–1 merged. Part A: A0–A7 done (all three
stacks applied, add-ons, secrets, db-bootstrap, both overlays applied with sslip.io hosts); A8
passes except the worker, which waits for an SSD quota increase only a person can request; A9
(enforcement) waits for the dry-run findings and a week of logs. Where each step stands:
`docs/deployment-gcp.md`, "Setup order".

**Naming.** The product name appears only in `packages/contracts/src/naming.ts`. This file never
uses it. Env vars are written **without their prefix**: `PIPELINE_DATABASE_URL` means
`NAMING.envPrefix + "PIPELINE_DATABASE_URL"`. Python reads the prefix from the naming config, Go
from `schemas/naming.json` (as `apps/versioning/internal/config` does), TypeScript from `envVar()`.
Never type the prefix or the product name into code, YAML, Terraform, docs or commit messages;
`pnpm check:names` enforces it. Renaming the product later is one edit to `naming.ts` plus
`tools/rename-namespace.mjs`, and nothing in this plan should make that harder.

---

## Start here (agents)

This file plus `AGENTS.md` is the whole brief.

1. **Read, in order:**
   1. `AGENTS.md`;
   2. this file: §0 (audit), §1 principles, §2 decisions, your part (§3 for infrastructure, §4 for
      the milestone you're on), §5 (workstreams, contracts, rules), §6 (config);
   3. `docs/pipeline.md` (the design; section numbers below refer to it as "P§");
   4. `docs/deployment-gcp.md`, `infra/terraform/*/README.md`, `infra/k8s/README.md`,
      `infra/k8s/overlays/gke/README.md`;
   5. the files in your workstream's row in §5.
2. **Set up:** `git worktree add .worktrees/todo12-<name> -b todo12-<name> main`. Work only there;
   never merge, never edit this file (report instead).
3. **Google Cloud is read-only for agents.** You may run `terraform plan` through impersonation and
   read-only `gcloud` / `kubectl get`. Never `terraform apply`, never change IAM, enable APIs,
   enforce the perimeter or `kubectl apply` to a Google cluster: those are a person's steps in §3,
   each needing a go-ahead in chat. No service-account keys, ever.
4. **The data boundary holds** (`todo/todo10.md`, "Start here", point 3; `docs/deployment-gcp.md`):
   customer data lives only in `spurby-phi`; nothing reads it from `spurby-ai`; no real sample or
   item bytes reach a sandbox or the model's context. Dev, test and staging use synthetic data only.
5. **Never commit** account emails, organization, folder, billing or project numbers. They live in
   the git-ignored `secrets/gcp.local.md`; pass them as `-var` or read them at run time.
6. **Hand back:**
   - done per item against its exit tests;
   - commits, migrations, env vars, events, routes and Terraform resources added;
   - `terraform plan` summaries (add/change/destroy counts) for any stack you touched;
   - the checks run (`AGENTS.md` list, `go test -race ./...` for Go, your e2e);
   - numbers for the gates in §7 you touched;
   - what's left.

**Prompt for each agent:**

> Read `todo/todo12.md` in the repo from "Start here (agents)" and follow it. You are workstream
> `todo12-<name>`. Do every item §5 assigns to you, to its exit tests.

---

## 0. Where we are (audit, 2026-11-01, `main` ebf7ed5)

### Google Cloud

| Layer | State |
|---|---|
| Organization, folders, org policies | Applied (`infra/terraform/org`) |
| Google Cloud BAA | Accepted |
| VPC Service Controls perimeter around `spurby-phi` | Applied in **dry-run**. Operator ingress and the release egress rule written, not applied |
| `infra/terraform/phi` (VPC, KMS, buckets, Cloud SQL, Memorystore, GKE, IAM, secrets, registry, audit, Healthcare, CDN) | Written and planned, **not applied**. Healthcare dataset fixed to Google-managed encryption (122441a) |
| `infra/terraform/data`, `infra/terraform/ai` | Written, **not applied** |
| `infra/k8s/overlays/gke/{phi,ai}` | Written with placeholders, never rendered against real outputs |
| State bucket `gs://spurby-phi-tfstate` | Exists; refuses new objects until it has a default CMEK key (phi's org policy) |
| Dev and staging projects (`*-dev`, `*-staging`) | Don't exist |

### Code the pipeline builds on (P§1.1)

- **Kernel job queue** (`apps/api/src/studio_api/kernel/queue.py`, `jobs.py`): SQL with
  `SKIP LOCKED` or Redis; workers claim over HTTP (`POST /api/v1/worker/claim`); leases set at
  claim time; `max_attempts`; idempotency keys; cancel sets state only.
- **Kernel outbox** `plugin_events` (`apps/api/src/studio_api/models.py`): `event_id`,
  `workspace_id`, `type`, `payload`, `payload_ref`, `source`, `correlation_id`, `depth`,
  `idempotency_key`; `job.succeeded` / `job.failed` exist in `kernel/events.py`.
- **Ingest**: `kernel/imports.py` (chunked uploads to a quarantine prefix, SHA-256,
  content-addressed sources), worker inspection, todo11 `item.*` lifecycle and derivatives.
- **Boundary jobs** (todo10): `fingerprint`, `synthesize_fixtures`, `verify_plugin`, `probe`,
  `build_plugin`; agent allowlist `kernel/agent_scope.py`.
- **Versioning** (`apps/versioning`, Go 1.27, module `studio.local/versioning`): commits with
  `expected_head`, branches, reviews, semantic merge, releases with `studio_tree`, River outbox, GC.
  The api calls it with Ed25519-signed JWTs (Secret `api-versioning-jwt`, ConfigMap
  `versioning-jwks`).
- **Network policies**: default deny plus DNS; the worker may reach only `api:8000`; api and
  versioning reach Google APIs through `restricted.googleapis.com` (`overlays/gke/phi/network.yaml`).

### Gaps the pipeline needs closed (P§1.1)

- No job heartbeat: progress doesn't renew the lease.
- Cancel doesn't stop the worker's child process.
- No resource classes, no per-workspace claim caps, no resource leases.
- No service principal for a backend caller other than the worker; no cross-workspace event feed
  for services.
- No `apps/pipeline`, no pipeline tables, routes, events or UI.
- No stable schema field IDs; releases don't carry a schema version or pipeline revision.

---

## 1. Principles

1. **Customer data never leaves `spurby-phi`**, except a de-identified, approved, audited release to
   `spurby-data`. Pipeline state is customer-data-adjacent and stays inside too.
2. **One owner per concern.** Versioning owns dataset truth; DBOS owns workflow progress; the kernel
   owns job execution and retries; the pipeline schema owns definitions, runs and lineage.
3. **Immutable in, immutable out.** Runs pin their inputs; outputs are staged under attempt-unique
   keys; only versioning's CAS makes anything visible.
4. **No workflow waits for a human.** Review state lives in Postgres; an approval starts a short
   `PublishWorkflow` (P§5.2).
5. **Measured, not assumed.** DBOS is selected pending Milestone 0. Thresholds in §7 are starting
   values, replaced with measurements.
6. **Infrastructure as code, applied by a person.** Agents write and plan; a person applies.

---

## 2. Decisions (settled 2026-11-01, from `docs/pipeline.md`)

| # | Decision | Where |
|---|---|---|
| E1 | Engine: DBOS Transact Go only, behind a thin `Engine` adapter with conformance tests. Switch target, under measured triggers only: self-hosted Temporal inside `spurby-phi`. Not Temporal Cloud. | P§5.1, P§5.5 |
| E2 | Python work goes through the kernel job queue; the kernel is the only retry owner for a job; the waiting engine step has engine retries off. | P§5.3 |
| E3 | No workflow waits for a human; run deadline 24 h; explicit `ApplicationVersion` = workflow package digest; drain policy on workflow-code changes. | P§5.2 |
| E4 | Fairness at two gates: DBOS partitioned queues by `workspace_id`, and kernel claim caps per workspace and resource class, with GPU and memory-heavy jobs holding a Postgres `resource_leases` row. | P§11 |
| E5 | Idempotent starts use workflow IDs and our own keys, never DBOS queue deduplication IDs (they don't combine with partition keys). | P§5.3 |
| E6 | Workers (CPU and GPU) reach only `api:8000` and have no Google identity; the api brokers every Google call. The pipeline pod reaches api, versioning, Cloud SQL, and (from Milestone 3) Pub/Sub through `restricted.googleapis.com`. | P§2.1 |
| E7 | Pipeline tables in schema `pipeline` of database `studio`; DBOS state in database `pipeline_engine` on the same Cloud SQL instance, with a connection budget and move-out thresholds. | P§16 |
| E8 | GPU work is a GPU-class kernel job claimed by a second worker Deployment on L4 + gVisor. | P§2, P§5.3 |
| E9 | Pipeline events use the kernel outbox envelope; `depth` guards trigger loops. | P§15 |
| E10 | The agent gets no pipeline routes until Milestone 4; agent-authored steps follow the todo10 ladder. | P§13 |

---

## 3. Part A — Google Cloud deployment guide

Who does what: **[person]** steps need a go-ahead in chat and are run by a person (or by an agent
only after that go-ahead, in the same chat). **[agent]** steps are code changes in a
`todo12-deploy` worktree, plus `terraform plan`.

Everything here uses synthetic data. Customer data waits for A9 (perimeter enforced).

### A0. Workstation setup [person, once]

Tools: `gcloud` (with `gke-gcloud-auth-plugin`), `terraform` ≥ 1.9, `kubectl`, `helm` ≥ 3.15,
`crane` (image mirroring), `jq`.

The gcloud configurations already exist: `spurby-phi` and `spurby-data` (the organization admin
account), `spurby-ai` (the personal account that owns that project). Leave `default` alone; it's
used for other work.

Terraform never uses a key file. Every stack gets a short-lived token by impersonating the deploy
identity:

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com \
  --configuration=spurby-phi)
```

Tokens last an hour; rerun this when a plan fails with 401. Organization and billing IDs come from
`secrets/gcp.local.md`; pass them as `-var org_id=…` and never write them to a `.tfvars` file in the
repo.

### A1. Give the state bucket a CMEK key [person]

The phi org policy requires CMEK on new Cloud Storage objects, so the state bucket refuses state
writes until it has a default key. The phi stack's own key ring can't be used (it doesn't exist
before the first apply, and it's regional while the bucket is in `us`), so create a small,
separate one by hand:

```sh
P=spurby-phi
gcloud kms keyrings create tfstate --location=us --project=$P --configuration=spurby-phi
gcloud kms keys create state --keyring=tfstate --location=us --purpose=encryption \
  --rotation-period=90d --next-rotation-time=$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ) \
  --project=$P --configuration=spurby-phi
GCS_AGENT=$(gcloud storage service-agent --project=$P --configuration=spurby-phi)
gcloud kms keys add-iam-policy-binding state --keyring=tfstate --location=us \
  --member=serviceAccount:$GCS_AGENT --role=roles/cloudkms.cryptoKeyEncrypterDecrypter \
  --project=$P --configuration=spurby-phi
gcloud storage buckets update gs://spurby-phi-tfstate \
  --default-encryption-key=projects/$P/locations/us/keyRings/tfstate/cryptoKeys/state \
  --configuration=spurby-phi
```

Check: `terraform -chdir=infra/terraform/org plan` (with the token from A0) succeeds and shows no
changes. Record the key ring in `docs/deployment-gcp.md` "Before the first apply" as done.

### A2. Infrastructure changes before the first apply [agent: `todo12-deploy`]

Make these in code, then `terraform plan` each stack and report the counts:

1. **Database bootstrap path.** Cloud SQL has no public IP and the cluster is default-deny, so
   operators can't reach Postgres from a laptop. Add a `db-bootstrap` Job template
   (`infra/k8s/base/jobs/db-bootstrap.yaml`, `postgres:17` image mirrored to Artifact Registry,
   suspended by default, reads `db-bootstrap-secrets`), and add its name to the `migrations`
   NetworkPolicy (`components/network-policies/jobs.yaml`). It runs the role SQL in A5.
2. **Pipeline database** (`infra/terraform/phi/data-services.tf`): `google_sql_database`
   `pipeline_engine` on instance `studio`. No roles or passwords in Terraform.
3. **Secret Manager** (`secrets.tf`): add `pipeline-secrets` and `db-bootstrap-secrets` to the list.
4. **Image registry entries**: `studio-pipeline` in the phi kustomization `images:` list (digest
   placeholder).
5. **`docs/deployment-gcp.md`**: add the pipeline to "Service per piece" and the setup order.

Exit: `terraform plan` for phi shows only creates (first apply), `kubectl kustomize
infra/k8s/overlays/gke/phi` renders, `node infra/k8s/check-no-secrets.mjs` passes,
`pnpm check:names` passes.

### A3. Apply the stacks [person]

Order: `phi`, then `data`, then `ai`. Each is `terraform init && terraform plan -out=tfplan`, read
the plan, then `terraform apply tfplan`.

1. **phi** (`infra/terraform/phi`). Takes 20–30 minutes (Cloud SQL, GKE, Memorystore). Leave
   `artifacts_retention_locked` and `audit_retention_locked` off; they are irreversible.
2. **data** (`infra/terraform/data`). Leave `public_read=false` until an
   `iam.allowedPolicyMemberDomains` exception exists for this project.
3. **ai** (`infra/terraform/ai`). First, once, as the owner of `spurby-ai`:

   ```sh
   gcloud projects add-iam-policy-binding spurby-ai --configuration=spurby-ai \
     --member=serviceAccount:terraform@spurby-phi.iam.gserviceaccount.com --role=roles/owner
   ```

Save the outputs (they contain no secrets, but keep them out of the repo):

```sh
for s in phi data ai; do terraform -chdir=infra/terraform/$s output -json > /tmp/tf-$s.json; done
```

Check: `gcloud sql instances describe studio --project=spurby-phi` shows `ipAddresses` with only a
`PRIVATE` entry; `gcloud container clusters describe studio --region=us-central1
--project=spurby-phi` shows private nodes; the perimeter dry-run log is still quiet for these
identities (`python3 tests/gcp/perimeter_test.py --expect dry-run --check-log`).

### A4. Cluster access and add-ons [person]

```sh
gcloud container clusters get-credentials studio --region=us-central1 --project=spurby-phi \
  --dns-endpoint --configuration=spurby-phi
gcloud container clusters get-credentials agent --region=us-central1 --project=spurby-ai \
  --dns-endpoint --configuration=spurby-ai
```

Mirror third-party images into each project's `images` registry first (phi nodes have no general
egress), for example `crane copy registry.k8s.io/ingress-nginx/controller:<tag>
us-central1-docker.pkg.dev/spurby-phi/images/ingress-nginx-controller:<tag>`, and point each chart's
image values at the mirror.

Install with Helm, pinned versions, recorded in `infra/k8s/overlays/gke/README.md`:

| Add-on | Cluster | Notes |
|---|---|---|
| ingress-nginx | both | `controller.service.externalTrafficPolicy=Local`, `controller.service.loadBalancerIP=<ingress_ip output>` |
| cert-manager | both | plus a `letsencrypt` ClusterIssuer |
| External Secrets Operator | both | namespace `external-secrets`; its service account annotated `iam.gke.io/gcp-service-account=external-secrets@<project>.iam.gserviceaccount.com` |
| KEDA | phi | for the worker ScaledObjects |
| agent-sandbox controller | ai | only when the GKE sandbox provider is trialled |

Then `kubectl create namespace studio` and the ConfigMap `redis-ca` (`terraform output -raw
redis_ca`) in it, in each cluster.

### A5. Databases and secrets [person]

1. Set the `postgres` password once:
   `gcloud sql users set-password postgres --instance=studio --project=spurby-phi --prompt-for-password`.
2. Put the admin DSN in Secret Manager `db-bootstrap-secrets` (JSON with one key, `ADMIN_DATABASE_URL`),
   and run the `db-bootstrap` Job with this SQL through `psql -v api_pw=… -v pipeline_pw=…`
   (passwords generated with `openssl rand -base64 32`, passed from your shell, never saved to a
   file in the repo):

   ```sql
   CREATE ROLE api_app LOGIN PASSWORD :'api_pw' CONNECTION LIMIT 60;
   GRANT ALL ON DATABASE studio TO api_app;
   -- versioning: `migrate bootstrap` creates versioning_owner and versioning_app
   CREATE ROLE pipeline_app LOGIN PASSWORD :'pipeline_pw' CONNECTION LIMIT 20;
   GRANT pipeline_app TO postgres;  -- Cloud SQL: needed before postgres can hand ownership over
   \c studio
   CREATE SCHEMA IF NOT EXISTS pipeline AUTHORIZATION pipeline_app;
   GRANT CONNECT ON DATABASE studio TO pipeline_app;
   ALTER DATABASE pipeline_engine OWNER TO pipeline_app;
   ALTER ROLE pipeline_app SET search_path = pipeline;
   ```

   `CONNECTION LIMIT` is the connection budget (E7): the pipeline gets at most 20% of
   `max_connections` across both databases. Then run versioning's `migrate bootstrap`
   (`apps/versioning/README.md`).
3. Fill each Secret Manager secret with one JSON object. Key names (prepend the env prefix; the
   full list per Secret is `infra/k8s/README.md`):
   - `api-secrets`: `API_DATABASE_URL` (role `api_app`, `sslmode=require`), `API_SECRET_KEY`,
     `API_WORKER_TOKEN`, and from Milestone 1 `API_PIPELINE_TOKEN`;
   - `worker-secrets`: `API_WORKER_TOKEN`, `KEDA_REDIS_PASSWORD`, `KEDA_REDIS_TLS`, `KEDA_REDIS_CA`;
   - `versioning-secrets`: `VERSIONING_DATABASE_URL`, `VERSIONING_MIGRATE_DATABASE_URL`;
   - `pipeline-secrets` (Milestone 1): `PIPELINE_DATABASE_URL`, `PIPELINE_ENGINE_DATABASE_URL`,
     `PIPELINE_API_TOKEN`;
   - `api-versioning-jwt` and, from Milestone 1, `pipeline-versioning-jwt`: `{"jwt.key":"<PEM>"}`,
     generated with `node tools/versioning-keys.mjs` (it never prints the key).

   ```sh
   gcloud secrets versions add api-secrets --data-file=- --project=spurby-phi <<< "$API_SECRETS_JSON"
   ```

### A6. Images [person, or CI once wired]

Build each app's image from its Dockerfile and push by digest to
`us-central1-docker.pkg.dev/spurby-phi/images/studio-<app>` (and `spurby-ai/images/studio-agent`).
CI does this through GitHub's OIDC token and Workload Identity Federation; if the pool isn't in
`infra/terraform/phi` yet, `todo12-deploy` adds it (provider restricted to this repository and the
`main` branch, role `artifactregistry.writer` on `images` only). Until then, a person pushes with
`gcloud auth configure-docker us-central1-docker.pkg.dev` under impersonation. Binary Authorization
admits only images from these registries.

### A7. Render and apply the overlays [person]

1. Replace the placeholders listed in `infra/k8s/overlays/gke/README.md` with values from
   `/tmp/tf-*.json` (CIDRs, Redis host, bucket names, signing key, service accounts, hosts, image
   digests). These are not secrets but they are environment-specific: keep them in a
   git-ignored `infra/k8s/overlays/gke/*/local.env` consumed by a `configMapGenerator`, or commit
   them only if they contain no project numbers.
2. Render, validate and apply:

   ```sh
   kubectl kustomize infra/k8s/overlays/gke/phi > /tmp/phi.yaml
   kubeconform -strict -summary /tmp/phi.yaml
   kubectl --context=<phi> apply -f /tmp/phi.yaml
   kubectl --context=<phi> -n studio wait --for=condition=complete job/api-migrate job/versioning-migrate --timeout=10m
   kubectl kustomize infra/k8s/overlays/gke/ai/app | kubectl --context=<ai> apply -f -
   ```

3. DNS: point `studio.<domain>` and `agent-api.<domain>` at the phi ingress IP and
   `agent.<domain>` at the ai ingress IP (GoDaddy manages the domain today).

### A8. Smoke test on synthetic data [person + agent]

- `curl https://studio.<domain>/api/healthz`, `/readyz`, `/version` for every service (through
  `kubectl port-forward` for the ones without an ingress).
- Upload the e2e synthetic fixtures (from `spurby-data`'s `fixtures` bucket, never real data);
  open a Studio; run an agent boot; confirm thumbnails and `item.*` events.
- Network checks (pipeline test 20): from a worker pod, DNS for `storage.googleapis.com` and a
  connection to `169.254.169.254` both fail; `api:8000` works.
- `python3 tests/gcp/perimeter_test.py --expect dry-run --check-log` shows no violations from our
  own service accounts. Investigate every one before A9.

### A9. Enforce the perimeter [person, before any customer data]

1. Apply the operator ingress and release egress rules:
   `terraform -chdir=infra/terraform/org apply -var admin_identities='[…]' -var release_egress=true`.
2. Watch dry-run violations for at least a week of normal synthetic use.
3. Enforce: `-var perimeter_enforced=true`, apply, then
   `python3 tests/gcp/perimeter_test.py --expect enforced`.
4. Update `docs/deployment-gcp.md` step 3 to `[x]`.

Only after this may a customer upload anything.

### A10. Pipeline additions on Google Cloud (per milestone)

| Milestone | Change | Who |
|---|---|---|
| 1 | `pipeline` Deployment, Service, PDB, ConfigMap, ServiceAccount (no Google identity), NetworkPolicy (ingress from api; egress to `api:8000`, `versioning:8090`, data services `5432`, DNS); api policy gains egress to pipeline; versioning policy gains ingress from pipeline; `pipeline-migrate` Job in the `migrations` policy; `pipeline-versioning-jwt` Secret and its public key in `versioning-jwks` | agent writes, person applies |
| 1 | Database `pipeline_engine` and role `pipeline_app` (A2, A5) | as above |
| 3 | Google service account `studio-pipeline` with `roles/pubsub.subscriber` on its subscription and `roles/storage.objectViewer` on connector landing buckets; Workload Identity binding; `pipeline` added to the `google-apis` NetworkPolicy; Pub/Sub topic and pull subscription; bucket notification configs | as above |
| 4 | GPU worker Deployment (`worker-gpu`): `cloud.google.com/compute-class: Accelerator`, `cloud.google.com/gke-accelerator: nvidia-l4`, `runtimeClassName: gvisor`, Spot for retryable classes; its own ScaledObject; same NetworkPolicy as the worker; regional L4 quota requested (on-demand and Spot) | as above, quota by a person |

### Rollback, per step

- Terraform: every apply has a saved plan; to undo, revert the commit and plan again. Never delete
  KMS keys (they have `prevent_destroy`), Cloud SQL (deletion protection) or locked buckets.
- Kubernetes: `kubectl rollout undo deployment/<app>`; migrations are forward-only, so each migration
  ships with its downgrade tested locally first.
- Perimeter: set `perimeter_enforced=false` and apply; that returns it to dry-run in minutes.

---

## 4. Part B — the pipeline service

### Milestone 0: validate the engine (`todo12-engine`, `todo12-kernel`), local only

Stage 0 of P§19. Runs on compose (Postgres, RustFS, Redis); no Google Cloud needed.

**`todo12-engine`:**

1. Scaffold `apps/pipeline` (Go 1.27, module `studio.local/pipeline`, `@studio/pipeline` in
   `package.json` with the same scripts as `apps/versioning`): `cmd/server`, `internal/config`
   (reads the prefix from `schemas/naming.json`, §6), `/healthz`, `/readyz`, `/version`,
   Dockerfile producing image `studio-pipeline`, compose service under the `full` profile.
2. `internal/engine`: the `Engine` interface (start, step, send, receive with timeout, cancel,
   fork, list) and conformance tests (retry, cancel, recovery after restart, recovery after an
   `ApplicationVersion` change, idempotent start by workflow ID, partitioned-queue fairness).
3. `internal/engine/dbos`: the implementation on the current DBOS Transact Go release (pin it;
   v1.8 at the time of writing). Our config only: DBOS gets its database URL and application
   version from `PIPELINE_ENGINE_DATABASE_URL` and the build's workflow-package digest, never from
   its own `DBOS_*` env vars. Don't enable Conductor.
4. `internal/dispatch`: a step that enqueues a kernel job (idempotency key
   `run_id/step_id/partition_id`), then waits on topic `job:<job_id>` with `Recv`; on timeout it
   reads `GET /api/v1/service/jobs/{id}` once and either returns or waits again. Engine retries are
   off for this step (E2).
5. `internal/triggers`: a consumer of the kernel's service event feed (§5 contracts) that turns
   `job.succeeded` / `job.failed` into `Send(job:<id>)` with the event ID as idempotency key.
6. The three decisive tests (P§19), as Go integration tests under `apps/pipeline/tests/chaos`,
   runnable with `pnpm --filter @studio/pipeline test:chaos`:
   - **deploy with pending work:** runs on version A (some mid-step, some `awaiting_review`),
     deploy B, retire A at the drain deadline; nothing lost or published twice;
   - **fan-out with a competing workspace:** A starts 10,000 tasks, then B starts 20; report B's
     start delay and completion time with both fairness gates on;
   - **database contention:** checkpoint load while versioning commits and API requests run;
     report the §7 database signals.

**`todo12-kernel`:**

1. **Heartbeat:** the worker's progress call renews `lease_until`; a renewal after the lease was
   lost returns 409 and the worker stops (fencing).
2. **Cancel stops work:** a cancelled job's next heartbeat returns 409; the worker kills the child
   process group within 5 s.
3. **Resource classes** on `PluginJob` (`cpu` default, `memory`, `gpu`); a worker claims only the
   classes it's configured for (`WORKER_RESOURCE_CLASSES`).
4. **Kernel fairness gate (E4):** `workspace_resource_limits` (per workspace and class: max running)
   and `resource_leases` (Postgres; acquired in the claim transaction for `gpu` and `memory`,
   renewed by the heartbeat, released on any terminal state, reconciled when expired). The claim
   query skips jobs whose workspace is at its cap. The Redis queue path checks the same Postgres
   caps; Redis stays the wake-up list.
5. **Service principal** `service:pipeline`, authenticated by `API_PIPELINE_TOKEN`, allowed only:
   enqueue jobs, read job status (`GET /api/v1/service/jobs/{id}`), read the service event feed,
   publish pipeline events. A test checks every other route returns 403 for it (as
   `agent_scope.py` does for agents).
6. **Service event feed:** `GET /api/v1/service/events?after=<cursor>&types=<csv>` (long-poll, up to
   25 s, cross-workspace, service principals only), backed by the outbox.

**Exit tests (Milestone 0):**

- the conformance suite passes on DBOS;
- the three decisive tests pass their targets in §7, or the hand-back explains which failed, why,
  and whether it can be fixed on DBOS (a switch needs a P§5.5 trigger and a decision in chat);
- kernel: heartbeat, fencing, cancel-kills, claim caps and leases have pytest coverage, including a
  worker that loses its lease mid-job and can't report success;
- `AGENTS.md` checks, `go test -race ./...` in `apps/pipeline`.

### Milestone 1: the implicit ingest pipeline (`todo12-pipeline`, `todo12-kernel`, `todo12-web`, `todo12-deploy`)

Stage 1 of P§19. Upload → inspect/type detect → two typed plugin steps → validation → immutable
artifact → candidate dataset commit → review → publish.

**`todo12-pipeline`:**

1. **Contracts** in `packages/contracts/src/pipeline/` (zod): pipeline graph (P§4), step I/O, run
   record, error envelope, reproducibility envelope (P§3), event payloads. `apiVersion` uses `NS`.
   Run `pnpm emit:schemas`; Go reads the emitted JSON Schemas.
2. **Compiler** (`internal/compiler`): RFC 8785 canonicalization (reuse the lockfile's), unique
   IDs, cycle detection, type checks, resolution to signed plugin versions, bounded fan-out,
   frozen plan and digest. Table-driven tests with the P§20 graphs.
3. **Tables** (goose, schema `pipeline`): `pipeline_definitions`, `pipeline_revisions`,
   `pipeline_runs`, `step_executions`, `step_attempts`, `run_artifacts`, `lineage_edges`,
   `pipeline_outbox`, `pipeline_inbox_dedupe` with the P§16 keys. The rest arrive with their
   milestone.
4. **`PipelineWorkflow` and `PublishWorkflow`** as P§5.2: stage outputs under
   `pipeline/<run>/<step>/<attempt>/…` in the api's BlobStore (through the service API, since the
   pipeline has no Google identity), create the candidate commit on branch `pipeline/<run_id>`,
   open a review, record `awaiting_review`, end. An approval starts `PublishWorkflow` (workflow ID
   = approval ID), which merges the review with `expected_head`; a stale head opens a rebase review.
5. **Implicit ingest definition** (`registry/pipelines/ingest.json` or the plugin manifest): the
   import flow's existing steps (inspect, derivatives) plus validation and propose. Uploads keep
   working without a pipeline; with one, the same files also become a candidate version.
6. **Versioning client** with its own Ed25519 key (kid `pipeline`).

**`todo12-versioning`** (small; can be part of `todo12-pipeline` if one agent prefers):

- accept kid `pipeline` from `versioning-jwks` as principal `service:pipeline`, allowed only to
  create branches and commits under `pipeline/*`, open reviews, and merge reviews that carry a
  current approval; everything else 403;
- test: a pipeline token can't move `main` directly, can't approve, and can't merge an unapproved
  or stale review.

**`todo12-kernel`:**

- gateway routes in `apps/api/src/studio_api/routes/pipelines.py` (P§15), calling the private
  pipeline API with a JWT signed by the api (the pipeline verifies against a JWKS ConfigMap, kid
  `api`);
- event types registered in `kernel/events.py`: `pipeline.run.started|completed|failed|paused`,
  `pipeline.step.started|completed|failed`, `pipeline.output.staged`, `dataset.candidate.created`,
  `review.requested|approved`; project-scoped ones flow to the project SSE stream;
- approvals: `POST /api/v1/pipeline-runs/{id}/approve` records the approval in versioning (bound to
  the candidate digest) and starts `PublishWorkflow`;
- not on the agent allowlist (E10).

**`todo12-web`:**

- `apps/web/src/studio/core/pipelines/`: run list and run detail (steps, states, per-file report,
  quarantined items, candidate commit link, approve button for reviewers), fed by the project SSE
  stream; no DAG editor;
- `data-testid`s: `pipeline-run-row`, `pipeline-run-status`, `pipeline-step-row`,
  `pipeline-file-report`, `pipeline-approve` (a regression contract from here on);
- e2e `apps/web/e2e/pipeline_runs_test.py` against fixtures, and `tests/e2e/pipeline_ingest_test.py`
  across api, worker, pipeline and versioning with the 10-mixed-files fixture (P§20 test 1).

**`todo12-deploy`:** everything in A10's Milestone 1 row, plus `infra/k8s/base/pipeline/`
(Deployment with `/readyz` probe, 2 replicas, PDB, HPA on CPU), `pipeline-migrate` Job, and the
`apps/pipeline` entry in compose and `docs/running.md`.

**Exit tests (Milestone 1):**

- P§20 tests 1, 4, 5, 6, 7, 8, 9, 14, 15, 17 (where the source is uploads), 19, 20;
- a review held across two workflow-code deploys still publishes exactly once (test 15);
- the pipeline pod's network: reaches api, versioning and Cloud SQL; nothing else;
- deployed to `spurby-phi` (after A9) and run on synthetic fixtures end to end;
- `AGENTS.md` checks, `pnpm emit:schemas --check`, `go test -race ./...`.

### Milestone 2: schema evolution, reviews, de-identified releases (`todo12-schema`)

Stage 2 of P§19.

- **Versioning:** schema versions with stable field IDs (P§7.1); releases gain
  `schema_version_id`, `pipeline_definition_revision`, `ontology_version_id`, `checks_digest`
  next to `studio_tree` (P§9).
- **Pipeline:** compatibility classification and modes (P§7.2); review checks (P§7.3);
  `schema_impact_reports`, `migration_plans`.
- **Release pipeline to `spurby-data`** (P§9.1): de-identify (Healthcare API for DICOM through the
  api; Sensitive Data Protection otherwise), small-count suppression under 20, access tier, an
  approver, copy by `studio-release` through the `release_egress` rule, audit record. Needs A9.
- **Exit:** P§20 tests 2, 3, 9; a release lands in `spurby-data/releases` only after approval, and
  a release attempt without de-identification is refused.

### Milestone 3: continuous and incremental pipelines (`todo12-connectors`)

Stage 3 of P§19.

- Connectors with `source_connectors`, `source_cursors`; Cloud Storage notifications → Pub/Sub pull
  subscription; dedupe on `bucket/object#generation` in the workflow ID; periodic prefix
  reconciliation (A10 Milestone 3 row).
- Incremental caching with the P§8 cache key; bounded backfills (`backfills` table, chunked
  coordinators); trigger-loop guard with `depth`.
- **Exit:** P§20 tests 13, 16, 17, 18; a missed notification is caught by reconciliation within one
  cycle.

### Milestone 4: agent authoring and GPU (`todo12-authoring`)

Stage 4 of P§19.

- Agent pipeline tools (proposal only) and their routes added to `kernel/agent_scope.py` and to the
  agent-facing route list in `docs/deployment-gcp.md`; agent-authored steps through the todo10
  ladder (P§13); approval always required on protected datasets.
- GPU worker Deployment and quota (A10 Milestone 4 row); segmentation step as the first GPU-class
  job.
- **Exit:** P§20 tests 10, 11, 12 (with GPU jobs in the mix); no real sample bytes reach the build
  sandbox or the agent (asserted on sandbox inputs and agent-visible payloads).

---

## 5. Workstreams

| Branch | Milestone | Owns | Must not touch |
|---|---|---|---|
| `todo12-deploy` | A, 1, 3, 4 (infra) | `infra/terraform/{phi,data,ai}`, `infra/k8s/**`, `docs/deployment-gcp.md`, `docs/running.md` (pipeline parts) | app code; `infra/terraform/org` beyond variables (the perimeter is applied by a person) |
| `todo12-engine` | 0 | `apps/pipeline/**` (scaffold, config, engine, dispatch, triggers, chaos tests), compose service | `apps/api`, `apps/worker`, `apps/versioning` |
| `todo12-kernel` | 0, 1 | `apps/api/src/studio_api/kernel/{queue,jobs,events}.py`, models and Alembic migrations for leases and limits, service principal and event feed, `routes/pipelines.py`, `apps/worker` heartbeat and cancel | `apps/pipeline`, web, versioning |
| `todo12-pipeline` | 1 | `packages/contracts/src/pipeline/**`, `apps/pipeline/internal/{compiler,domain,persistence,publication,lineage}`, workflows, ingest definition, `apps/versioning` pipeline principal | web, kernel internals |
| `todo12-web` | 1 | `apps/web/src/studio/core/pipelines/**`, its e2e | API, pipeline, engines |
| `todo12-schema` | 2 | versioning schema versions and release fields, pipeline compatibility engine, release pipeline | web beyond the review checks panel |
| `todo12-connectors` | 3 | connectors, Pub/Sub consumer, incremental cache, backfills | versioning internals |
| `todo12-authoring` | 4 | agent pipeline tools, agent scope entries, GPU job class wiring | the boundary jobs' semantics (todo10) |

**Order.** Part A's A0–A2 and Milestone 0 (`todo12-engine`, `todo12-kernel`) run in parallel.
Milestone 1 starts when Milestone 0's exit tests pass and the engine decision is confirmed in chat;
its four workstreams run in parallel against the contracts below. Milestone 1 deploys after A9.
Milestones 2–4 follow in order.

**Contracts** (names fixed; change only through the integrator):

- **Kernel → pipeline job completion:** `job.succeeded|failed {job_id, workspace_id, idempotency_key,
  attempts, result_ref?, error_class?}` on the service event feed.
- **Service event feed:** `GET /api/v1/service/events?after=<cursor>&types=<csv>` →
  `{events: [envelope], cursor}`; envelope = the `plugin_events` columns (P§15).
- **Service job routes:** `POST /api/v1/service/jobs {workspace_id, kind, plugin?, input_ref,
  resource_class, idempotency_key}` → `{job_id}` (200 on a repeated key with the same job);
  `GET /api/v1/service/jobs/{id}` → `{state, attempts, result_ref?, error_class?}`.
- **Pipeline private API** (called only by the api): `POST /v1/runs`, `GET /v1/runs/{id}`,
  `POST /v1/runs/{id}/cancel`, `POST /v1/approvals {run_id, approval_id, candidate_digest}`,
  `POST /v1/definitions/{id}/validate`.
- **Run states:** `queued → running → awaiting_review → publishing → published | rejected |
  failed | cancelled`.
- **Item states** (extend todo11's `item.*`): `discovered → staged → validated | quarantined →
  processed → proposed | rejected`.
- **Events:** the P§15 list, with `source = "pipeline"` and `idempotency_key =
  <run_id>/<event>[/<step_id>]`.
- **Branch names:** `pipeline/<run_id>` for candidates; agents keep `work/agent-*`.

**Rules** (as todo10 §11 and todo11 §6):

- branch slug in Alembic and goose filenames;
- never merge, never edit this file;
- no product name anywhere outside `naming.ts`, no prefixed env var names in code (§6);
- synthetic fixtures only;
- no Google Cloud writes (Start here, point 3);
- the `AGENTS.md` checks plus your exit tests before handing back.

**Merge order:** `todo12-deploy` (A2) → `todo12-kernel` (M0) → `todo12-engine` (M0) →
`todo12-versioning`/`todo12-pipeline` → `todo12-kernel` (M1) → `todo12-web` → `todo12-deploy` (M1).
After each merge, run the full checks and the Milestone 0 chaos suite.

---

## 6. Configuration

Names are without the prefix (see "Naming"). Each service reads them only in its config module.

**`apps/pipeline`:**

| Key | What |
|---|---|
| `PIPELINE_PORT` | HTTP port (default 8095) |
| `PIPELINE_DATABASE_URL` | database `studio`, role `pipeline_app`, `search_path=pipeline`, `sslmode=require` |
| `PIPELINE_ENGINE_DATABASE_URL` | database `pipeline_engine`, same role |
| `PIPELINE_DB_POOL_MAX` | per-pod pool size; pods × pool ≤ the role's `CONNECTION LIMIT` |
| `PIPELINE_API_URL`, `PIPELINE_API_TOKEN` | the kernel's service routes |
| `PIPELINE_VERSIONING_URL`, `PIPELINE_VERSIONING_JWT_KID`, `PIPELINE_VERSIONING_JWT_KEY_FILE` | signed calls to versioning (kid `pipeline`) |
| `PIPELINE_API_JWKS_FILE` | verifies the api's calls (kid `api`) |
| `PIPELINE_APP_VERSION` | set at build time to the workflow package digest (E3) |
| `PIPELINE_RUN_DEADLINE`, `PIPELINE_DRAIN_DEADLINE` | 24h and 72h to start |
| `PIPELINE_ENGINE_RETENTION` | DBOS workflow record retention (30d) |

**`apps/api`:** `API_PIPELINE_URL`, `API_PIPELINE_TOKEN` (the token the pipeline presents),
`API_PIPELINE_JWT_KID` (`api`).

**`apps/worker`:** `WORKER_RESOURCE_CLASSES` (`cpu,memory` for the CPU Deployment, `gpu` for
`worker-gpu`).

---

## 7. Gates and budgets

Initial values from P§16 and P§19, replaced with Milestone 0 measurements (record the
replacements here through the integrator).

**Engine decision gates (Milestone 0):**

| Test | Target |
|---|---|
| Deploy with pending work | 0 lost runs, 0 double publishes; every stranded run forked or rerun per P§5.2 |
| Fan-out: B's first task starts after a slot frees | within one claim cycle |
| Fan-out: B's 20 tasks finish | within 2× their time on an idle system |
| Recovery after a pipeline pod is killed mid-step | the run resumes from its last completed step, no duplicate kernel jobs |

**Shared Cloud SQL thresholds** (move `pipeline_engine` to its own instance if any holds, sustained
over a day or under the contention test):

| Signal | Threshold |
|---|---|
| API or versioning p95 transaction latency with pipelines running | +10% over the same load without |
| Instance CPU | > 60% |
| Engine writes | > ⅓ of the instance's write IOPS |
| DBOS checkpoint p95 | > 50 ms |
| `pipeline_engine` size after retention | > 50 GB |
| Pipeline connections | above the role's limit |

**Tracked, not gated:** per-file import throughput, time from upload to candidate commit for the
10-file and 200-file fixtures, queue depth, retries by class, cost per 1,000 items.

---

## 8. Not now

- Temporal (self-hosted or Cloud), Dagster, Composer, Dataflow, Eventarc (P§5.1, P§2).
- A visual DAG editor (Milestone 4 at the earliest).
- Lance or Iceberg as storage formats (P§21).
- Dedicated per-customer projects (`spurby-phi-<customer>`).
- Dev and staging Google Cloud projects: worth having before the first customer, but a separate
  decision (they need their own billing and policies).

---

## 9. References

- `docs/pipeline.md` (the design), `docs/deployment-gcp.md`, `docs/versioning.md`,
  `docs/agent.md`, `docs/plugins.md`.
- `todo/todo10.md` (data boundary, Phase 9), `todo/todo11.md` (boot, item lifecycle).
- `infra/terraform/{org,phi,data,ai}/README.md`, `infra/k8s/README.md`,
  `infra/k8s/overlays/gke/README.md`, `tests/gcp/perimeter_test.py`.
- DBOS Transact Go: https://github.com/dbos-inc/dbos-transact-golang and
  https://docs.dbos.dev/golang/reference/methods.
- Cloud SQL users and roles: https://cloud.google.com/sql/docs/postgres/create-manage-users.
- GKE private clusters' DNS endpoint: https://cloud.google.com/kubernetes-engine/docs/concepts/network-isolation.
- GKE Autopilot GPUs: https://cloud.google.com/kubernetes-engine/docs/how-to/autopilot-gpus.
- Cloud Storage default CMEK on a bucket: https://cloud.google.com/storage/docs/encryption/using-customer-managed-keys.
