# Deploying on Google Cloud

Where each part of the product runs on Google Cloud, and the one boundary that must hold: **customer
data lives only in `spurby-phi`, and nothing reads it from `spurby-ai`.** The reasoning and the
remaining work are in [todo10 §6](../todo/todo10.md#6-sandboxes-daytona-and-friends) and Phase 9.

Status (2026-10-31): folders, organization policies and the perimeter (dry-run) are applied from
`infra/terraform/org`. Google Cloud BAA accepted. The infrastructure inside the projects is written
and planned (`infra/terraform/{phi,ai,data}`, `infra/k8s/overlays/gke`), not applied. Not done yet:
applying it and enforcing the perimeter (see "Before the first apply").

## Projects

`spurby-phi` and `spurby-data` sit in the company's Google Cloud organization (folders: `shared`,
`nonprod`, `prod`). `spurby-ai` stays **outside** the organization, under its existing billing account,
on purpose. It never holds customer data, so the organization's policies don't need to cover it. The
boundary is enforced from the `spurby-phi` side:

- the VPC Service Controls perimeter refuses `spurby-ai` identities on Google APIs inside it (Cloud
  Storage, Cloud SQL, KMS, Healthcare API);
- the agent reaches `spurby-phi` only over HTTPS through our API, with a scoped service token, on the
  routes listed under "What the agent sees". It holds no Google credentials for `spurby-phi`.
- the organization's domain-restricted sharing policy only admits organization identities, so
  `spurby-ai` service accounts can't be granted roles in `spurby-data` either. The agent reads
  synthetic and public data through our API too.

No service-account keys anywhere (key creation is blocked by organization policy). People use their
own accounts; Terraform impersonates a keyless deploy service account; pods use Workload Identity;
CI uses Workload Identity Federation; app secrets live in Secret Manager.

Moving `spurby-ai` into the organization later is a single `gcloud beta projects move`. Credits are
usually attached to the billing account, not the project, but check the credit's terms first.

| Project | Holds | Rules |
|---|---|---|
| `spurby-ai` | `apps/agent`, model calls, egress to Daytona | Never holds customer data. Reaches `spurby-phi` only through the agent-facing API routes below. |
| `spurby-phi` | Everything a customer uploads; `apps/api`, `apps/worker`, `apps/versioning`, `apps/pipeline` serving it; Cloud SQL, Cloud Storage, Cloud KMS, Healthcare API, Sensitive Data Protection | Inside a VPC Service Controls perimeter. Only products on Google's HIPAA covered-products list. |
| `spurby-data` | Data we curate: public datasets, seed data, e2e and synthetic fixtures, demos, de-identified releases | Normal controls; may be public-facing. |

Development and staging get their own projects (`*-dev`, `*-staging`) with synthetic data only. Never
copy production customer data into them. Large customers may later get a dedicated
`spurby-phi-<customer>` project with its own key.

## Classification follows control, not content

- **Every customer upload is treated as patient data**, whatever the uploader says. DICOM headers and
  burned-in text hide identifiers, and people mislabel files.
- Data moves from `spurby-phi` to `spurby-data` only as a **de-identified release**: our
  de-identification pipeline (Healthcare API DICOM de-identify, Sensitive Data Protection for other
  formats), a person's approval, then a one-way, audited copy through a perimeter egress rule. Nothing
  else leaves.

## What the agent sees

The agent works on the Studio's shell, never the data. From `spurby-ai` it may call only these API
routes in `spurby-phi`. An agent token (principal `agent:*`) gets 403 on every other route, whatever
its scopes: the allowlist is `AGENT_ROUTES` in `apps/api/src/studio_api/kernel/agent_scope.py`, and a
test checks each entry exists. Change this list and that file together.

- Data boundary (`/api/v1/boundary/*`, todo10 Phase 7; results are the fixed schemas in
  `schemas/boundary/`):
  - `POST fingerprints` (`get_fingerprint`), `POST fixtures`, `GET fixtures/{set}/{name}`
    (`get_fixtures`: synthetic files made from the fingerprint alone);
  - `POST verify` (`verify_on_sample`), `POST probes` (`probe_sample`; budgeted, audited);
  - `POST builds` (`build_plugin_artifact`: our worker rebuilds and signs the source);
  - `GET jobs/{id}` (job summary: counts, states, error classes; the typed result of boundary jobs);
  - `GET annotations` (filtered view: geometries and vocabulary labels, free text as placeholders),
    `POST annotations/export` (a server-side snapshot; the document never passes through the agent).
- Job start: `POST /api/v1/commands` (answers agents with job summaries; `versioning.checkout` refused).
- Environment control plane: `GET`/`PATCH /api/environments/{id}`, `GET …/history`,
  `POST /api/environments/validate`, `GET /api/catalog…`. The API enforces todo11 D2 on every
  write (`kernel/environment_policy.py`): a required `revision`, only the agent's own drafts or the
  task the person opened it on, an allowlist of patchable paths, installed modules only, and
  shape and reference checks.
- Boots (todo11 D1): `POST /api/v1/projects/{id}/boots` (drafts only, on behalf of a person),
  `GET /api/v1/boots/{id}`, `GET /api/v1/tasks/{id}`. `POST /api/v1/tasks/{id}/publish` is not on
  the list: only a person publishes.
- Studio definitions (todo10 Phases 1, 2, 4): `GET /api/environments/{id}/lockfile`,
  `…/last-known-good`, `…/audit`, `PUT …/readme` (notes), `GET /api/v1/datasets/{id}/studio` and
  `POST …/studio/commits` (only onto `work/agent-*`). Moving last-known-good, boot checks and
  rollback refuse agent tokens.
- Plugin control plane: plugin search, detail and docs; workspace state, capabilities, plugins and
  install requests; `plan`, `stage`, `activate`, `configure`, `disable`, `rollback`;
  `POST /api/v1/plugins/artifacts` as a dry run only. Not on the list: the artifact routes (`/plugins/{id}/files`, `…/export`, `/plugins/import`,
  promotions, `…/plugins/load-refused`); export, import and promotion review also need
  `plugins.approve`, which agent tokens never carry.
- Dataset versioning on the agent's own `work/agent-*` branch: branches, commits, diff, reviews
  (approve, merge and release are refused for agents in the kernel). No document, checkout or
  artifact routes.
- Project reads with no file contents: project, overview, sources, proposals (read, create),
  review, search, drive listing, imports, source nodes and their activity; asset metadata
  (`GET /api/v1/assets`: ids, paths, types, sizes).
- Project context and health (todo17 D9, D10): `GET …/projects/{id}/context` (rules, findings by
  rule, what's published, recent changes), `GET …/findings`, `POST …/findings/{id}/fix` and
  `POST …/gardener`; for an agent a fix only ever opens a change request. Findings carry rule
  codes, resource ids and messages, never file names.
- Org settings (todo15 D2): `GET /api/v1/org`, so the agent can refuse runs when `aiAssist` is off.
- Project rules (todo17 D3): `GET /api/v1/projects/{id}/rules` and `…/rules/history` (writes stay a
  person's; agents propose them).
- Outside agents (todo17 D12): the same allowlist applies to an MCP OAuth token (principal
  `agent:<client name>`, on behalf of the person who signed it in, `auth/oauth.py`), plus
  `GET /api/v1/approvals/{id}` to poll the approval a person gives for its destroy (which always
  answers 202 with an approval link first). Its scopes (`project:read`, `project:write`,
  `project:trash`, `project:destroy`, `rules:propose`, `auth/scopes.py`) gate each route by the
  operation catalogue's tier; a missing one is 403 `insufficient_scope`. A connection revoked in
  Settings › Connected agents answers 401.
- Drops (todo13 D3): `GET /api/v1/drops/{id}` answers an agent with the drop's `DropSummary`
  only: counts by kind and state, groups, and per file its node id, its screened name and
  technical facts (dimensions, frames, duration, modality, column names and types, pages). The
  agent tool is `get_drop`; the same summary rides on the user's message as a `<drop>` block.

**Screened names (todo13 D13).** Every JSON answer to an agent token goes through one serializer
(the API's `agent_names` middleware, `kernel/agent_view.py`): file and folder names that are
flagged, or not yet screened, are replaced wherever they appear (names, paths, sequence rows,
reasons, proposal text) by the node's `agent_name` (`dicom-0001.dcm`, `folder-0002`; unscreened:
`file-<n>.<ext>`), with a regex net over name-like fields on the file routes. People's answers are
unchanged. Names are screened on import, after namespace edits and by a backfill
(`files.screen_names`, `python -m studio_api.kernel.name_screen backfill`). In `spurby-phi` the
screen is Sensitive Data Protection (`projects.locations.content.inspect` in `us-central1`, names
only, batched by `API_NAME_SCREEN_BATCH`, paced by `API_NAME_SCREEN_QPS`; `PERSON_NAME`,
`FIRST_NAME`, `LAST_NAME`, `DATE_OF_BIRTH`, `EMAIL_ADDRESS`, `PHONE_NUMBER`,
`US_SOCIAL_SECURITY_NUMBER` and a custom MRN-like regex), ORed with the in-process regex screen;
an API error flags the whole batch (fail closed). No new API, IAM binding or perimeter change:
`dlp.googleapis.com` and `roles/dlp.user` are already there. `API_NAME_SCREEN_MODE=off` is
refused in production. Test: `apps/api/tests/test_drops.py` walks `AGENT_ROUTES` with an
identifier-like fixture name.
- Drop plans and dataset structure (todo13 Milestone 2): `GET`/`PUT /api/v1/drops/{id}/plan` (read,
  change before apply), `POST /api/v1/drops/{id}/apply` (only plans that touch nothing but the
  person's own drafts, D6; `…/undo` is not on the list), `GET`/`PUT /api/v1/datasets/{id}/structure`
  (writes land on the agent's own `work/agent-*` branch; accepting stays a person's), and
  `GET /api/v1/projects/{p}/datasets/{d}/collections`. Plans and structures carry node ids,
  kinds, counts, generic collection names and column names (technical facts), never file names.

Summaries suppress small counts (as All of Us does with counts under 20), so a rare cohort can't be
singled out. The annotator's browser talks to the API in `spurby-phi` directly, never through the
agent.

## Access tiers for datasets

| Tier | Like | Where |
|---|---|---|
| Public | Hugging Face, Kaggle | `spurby-data` |
| Registered: sign-in plus accepted terms | Hugging Face gated datasets | `spurby-data` |
| Credentialed: data use agreement plus an approver | PhysioNet | `spurby-data` (de-identified) |
| Enclave: data never leaves, only checked results do | All of Us, UK Biobank | `spurby-phi` |

## Service per piece

| Piece | Google service |
|---|---|
| Postgres | Cloud SQL for PostgreSQL 17, private IP, CMEK; database `studio` (api, versioning and pipeline schemas) and `pipeline_engine` (DBOS state), one role per service with a `CONNECTION LIMIT` |
| `BlobStore`, plugin artifacts | Cloud Storage; retention lock on the artifacts bucket |
| Bundle delivery | Cloud CDN in front of the artifacts bucket |
| DICOM de-identification | Healthcare API dataset with Google-managed encryption, the one exception to CMEK: the API can't de-identify CMEK-encrypted resources or use CMEK inside a perimeter |
| Platform signing key | Cloud KMS asymmetric key, HSM protection (cosign `gcpkms://…`) |
| First-party CI signing, image pushes | GitHub OIDC through Workload Identity Federation (`infra/terraform/phi/ci.tf`: this repository's `main` branch only, service account `ci-images` with `artifactregistry.writer` on `images` only) |
| Container images, OCI artifacts | Artifact Registry; Binary Authorization |
| Pipeline service (`apps/pipeline`, docs/pipeline.md) | GKE Deployment `pipeline` (2+ replicas, HPA on CPU, PDB), port 8095, called only by the api; reaches the api, versioning and Cloud SQL. No Google identity until Milestone 3 |
| Bucket notifications (pipeline Milestone 3) | Pub/Sub topic and **pull** subscription with CMEK (push is restricted inside a perimeter); `pipeline_connectors_enabled` |
| GPU steps (pipeline Milestone 4) | `worker-gpu` Deployment on Autopilot's Accelerator class (NVIDIA L4, GKE Sandbox, Spot), regional L4 quota requested by a person; `gpu_workers_enabled` |
| Kubernetes | GKE Autopilot; a `gke` overlay next to `infra/k8s/overlays/{dev,staging,prod}` |
| Worker running untrusted plugin code | GKE Sandbox (gVisor) node pool, NetworkPolicy denying egress, read-only input |
| Secrets | Secret Manager + Workload Identity, surfaced as the usual `STUDIO_*` env vars |
| Audit | Cloud Audit Logs with Data Access logs on, sunk to a locked bucket; Access Transparency |

## Setup order

1. [x] Google Cloud BAA accepted (2026-10-31; IAM & Admin → Privacy & Security, in any one project).
2. [x] Organization policies (`infra/terraform/org/policies.tf`):
   - no service-account key creation (organization default);
   - only organization identities in IAM (organization default);
   - `prod` folder: US locations only, uniform bucket-level access, no public IP on Cloud SQL;
   - `spurby-phi` only: CMEK required for Cloud Storage and Cloud SQL, public access prevention, no
     external IPs on VMs (GKE nodes). `spurby-data` keeps these off so it can serve public data.
3. [~] VPC Service Controls perimeter around `spurby-phi` (`perimeter.tf`), in **dry-run**. No
   Google-API ingress for `spurby-ai` (the agent uses our API over HTTPS). Applied: the operator
   ingress rule for the deploy identity. Not yet: the one-way release egress rule to `spurby-data`
   (`release_egress`). `python3 tests/gcp/perimeter_test.py --expect dry-run --check-log` passes
   (2026-11-01: every probe from `spurby-ai` logged as a would-be refusal). Three groups of
   dry-run violations must be fixed before enforcing, or enforcement breaks them:
   - `ci-images` pushing to Artifact Registry from GitHub (needs an ingress rule for that identity);
   - `gke-nodes` pulling images with no caller network (most likely Autopilot's image streaming;
     confirm with the troubleshooting token in the log entry, then add the rule it needs);
   - the operators' own kubectl and gcloud calls (`admin_identities` must list the people, not
     only the deploy identity).
   Then watch a week of dry-run, enforce, and rerun the test with `--expect enforced`.
4. [x] State bucket key (todo12 A1): `gs://spurby-phi-tfstate` has a default CMEK key from key
   ring `tfstate` in location `us`.
5. [x] Infrastructure: `infra/terraform/{phi,data,ai}` applied (2026-11-01), in that order.
6. [x] Cluster add-ons on both clusters (ingress-nginx, cert-manager with leader election in its
   own namespace, External Secrets; KEDA on phi; images mirrored to phi's registry), namespace
   `studio`, ConfigMap `redis-ca`. Not yet: the agent-sandbox controller on ai (the agent uses
   Daytona until the GKE Sandbox provider lands), so `SandboxTemplate` and `SandboxWarmPool` are
   left out of the ai apply.
7. [x] Databases and secrets: `postgres` password set, every `<app>-secrets` filled in Secret
   Manager (never in files), `db-bootstrap` run (it also creates the versioning roles and schema),
   all migrate Jobs complete. Disable the `db-bootstrap-secrets` version once nothing reruns it.
8. [~] Images: CI pushes to phi's registry by digest. The agent image is still built by hand and
   pushed to `spurby-ai`'s registry (CI has no federation there yet).
9. [x] Rendered from `live/{phi,ai}`, validated (kubeconform), applied. Hosts are sslip.io names
   on the two ingress addresses until real DNS exists. The Studio host admits only
   `STUDIO_ALLOW_CIDRS`: people don't sign in yet and the api trusts dev headers. Sign-in with
   WorkOS (todo9) is ready but off: ExternalSecret and Secret Manager secret `workos-secrets`
   exist, `overlays/gke/phi/components/workos` turns it on (`infra/k8s/README.md`, "WorkOS
   runbook"); the allow-list stays until a sign-in is verified.
10. [~] Smoke test (2026-11-01): every service's `/healthz`, `/readyz` and `/version` pass; web →
    agent → api works across the projects; outside callers get 403 on both agent hosts; a
    synthetic upload lands in Cloud Storage. **Blocked:** the worker (GKE Sandbox) can't get a
    node, because the regional SSD quota (250 GB, Autopilot boot disks of 100 GB each) is used up
    and automatic increases were denied. A person must request the increase in the console
    (IAM & Admin → Quotas, `SSD_TOTAL_GB` in us-central1, 500 GB). Until then imports stop at
    `inspecting`.
11. **Paused (2026-11-02).** The MVP runs locally. Every Deployment in both clusters is scaled to
    0, the worker's ScaledObject paused, CronJobs suspended, both Cloud SQL instances stopped
    (data kept). Nothing was deleted. To resume, and to avoid the quota by running the worker
    without GKE Sandbox while data is synthetic: `todo/todo15.md` §8.
12. **Torn down (2026-11-03).** Idle billing stopped: both GKE clusters, both Memorystore
    instances, the ingress load balancers, Cloud NAT and the static addresses are deleted
    (`gke_enabled=false`, the default in `phi` and `ai`). Kept: both Cloud SQL instances,
    stopped (`sql_running=false`), KMS keys, buckets, registries, the VPCs, Secret Manager and
    the Healthcare dataset. The next deployment is Cloud Run with WorkOS sign-in
    (`todo/todo22.md` W6), not GKE. The `phi` stack needs the `github_*` variables on every
    apply, or the plan drops CI's federation; apply only what you changed until they live in
    a git-ignored tfvars file.

Steps 1–3 come before any customer data arrives; the pipeline's Milestone 3 (Pub/Sub,
`pipeline_connectors_enabled`) and Milestone 4 (GPU, `gpu_workers_enabled` and the L4 quota) each
switch on only when that milestone ships.

### Before the first apply

- The state bucket `gs://spurby-phi-tfstate` sits in `spurby-phi`, where CMEK is now required for
  Cloud Storage, so it refuses new objects (locks, new stacks' state, the next state version of
  `org`) until it has a default KMS key. Give it one, in location `us` (the bucket's), by hand,
  before any Terraform apply: key ring `tfstate`, key `state` (90-day rotation), the Cloud Storage
  service agent as its encrypter/decrypter, then `gcloud storage buckets update
  gs://spurby-phi-tfstate --default-encryption-key=…` (setup order step 4). Done 2026-11-01.
- `spurby-ai` is outside the organization, so the deploy identity needs a role there, granted by
  the project's owner (`infra/terraform/ai/README.md`).

### How the pieces connect

- Both clusters are GKE Autopilot with private nodes. Plugin code on real data runs only in the
  `spurby-phi` worker (and, from pipeline Milestone 4, `worker-gpu`), under GKE Sandbox
  (`runtimeClassName: gvisor`), with no egress except the api. The pipeline pod reaches only the
  api, versioning and Cloud SQL (from Milestone 3 also `restricted.googleapis.com` for Pub/Sub);
  only the api calls it. Build sandboxes in `spurby-ai` (agent-sandbox, gVisor) have no network at all.
- The two projects talk over HTTPS between fixed Cloud NAT addresses: web → the agent's host, the
  agent → a separate agent-only host on the api (the Studio's host refuses the agent's address).
  Details: `infra/k8s/overlays/gke/README.md`.
- Pods use Workload Identity; app secrets are Secret Manager secrets synced by the External
  Secrets Operator into the usual `<app>-secrets`. Cloud Storage is reached through its native API
  (`BLOB_STORE=gcs` in apps/api, `OBJECT_STORE=gcs` in apps/versioning), never HMAC keys.
- Destroy approvals (todo16 D8): the agent signs the person's "delete forever" approval with
  HMAC-SHA256 and the api verifies it (person, operation, project, targets, ten-minute expiry,
  single use in `approvals_used`). The key is one random value (`openssl rand -base64 48`) held
  twice: Secret Manager secret `approval-secret` in **`spurby-ai`** synced into `agent-secrets`
  as `STUDIO_AGENT_APPROVAL_SECRET`, and the same value in **`spurby-phi`** synced into
  `api-secrets` as `STUDIO_API_APPROVAL_SECRET`. Both services refuse to start in production
  without it. Rotate by updating both, then restarting api and agent (approvals in flight fail
  and are asked again).
- The agent's model is on Vertex AI in `spurby-ai` (`AGENT_MODEL=google-vertex:…`, D8) and its
  allowlist holds only Vertex models. Confirm that the BAA covers `spurby-ai` (a separate billing
  account outside the organization) and that the model is on the HIPAA covered list.

## Cloud Run stage

The GKE clusters are being torn down; deployed stages move to Cloud Run (todo22 W6, D6). Defined in
`infra/terraform/phi/run*.tf` (the Studio project) and `infra/terraform/ai/run*.tf` (the agent
project); written and validated, not applied. Every deployed stage signs people in with WorkOS:
nothing in these files sets dev auth, trusted headers, the agent's file store or a SQLite URL, and
`tools/check-deploy-auth.mjs` checks the `env` blocks.

| Service | Runs as | Ingress | Notes |
|---|---|---|---|
| `web` | service, `studio-web` (no Google roles) | load balancer and VPC | Image built with `STUDIO_WEB_AUTH_MODE=workos` (the build's fallback); the service also sets it, which is what nginx and `/config.json` read. Proxies `/api/agent/*` to the agent's run.app URL with `STUDIO_AGENT_TOKEN`. |
| `api` | service, `studio-api` (iam.tf) | load balancer and VPC | Min 1 instance (the WorkOS event sync and SQL housekeeping). |
| `versioning` | service, `studio-versioning` (iam.tf) | VPC only | Events to the log (no Redis). |
| `pipeline` | service, CPU always allocated | VPC only | Max instances × pool size stays under `pipeline_app`'s connection limit. |
| `worker` | service, fixed instances, CPU always allocated, `studio-worker` (no Google roles) | VPC only (health probes) | First-generation execution environment (gVisor). A worker pool once the provider lets a pool pick the execution environment. |
| `agent` | service in the agent project, existing `studio-agent` identity (Vertex AI user) | all (token-checked) | Max 1 instance. |

- **Network.** Direct VPC egress on the existing subnet, all traffic through the VPC, so Cloud SQL's
  private IP is reachable and calls to another service's run.app URL count as internal (Private
  Google Access). Services name each other by their deterministic run.app URLs. A Cloud NAT with
  Google-allocated addresses (`run_nat_enabled`; off while the GKE NAT still exists) gives the api
  its route to WorkOS. Nothing allow-lists an address any more.
- **One HTTPS load balancer** for the Studio host: a global address, a Google-managed certificate,
  serverless NEGs for web and api, the routes of `infra/k8s/base/ingress.yaml` (`/api/auth/verify`
  and `/api/agent` → web, `/api` and `/seed` → api, the rest → web), and plain HTTP redirected to
  HTTPS. Point the host's DNS record at output `studio_lb_ip`. The remote MCP server (`/mcp`) isn't
  on Cloud Run yet.
- **Invoker IAM is off** on every service: the organization policy blocks granting `run.invoker`
  across projects, and each app checks its own credentials (WorkOS sessions, the worker, pipeline,
  agent and kernel service tokens, api-signed JWTs). Ingress settings keep versioning, pipeline and
  the worker off the internet.
- **The agent reaching the api.** The agent calls the Studio host (`STUDIO_API_URL`, ai variable
  `studio_url`) as `service:agent` with `STUDIO_AGENT_KERNEL_SERVICE_TOKEN` (= the api's
  `STUDIO_API_AGENT_SERVICE_TOKEN`), and with the person's WorkOS token on calls made for them. The
  agent-scope allowlist above still decides which routes it may use. No fixed NAT addresses, no
  separate agent-only host.

### Stores (D6)

- api: Cloud SQL `studio`, zonal on a 1-vCPU tier while data is synthetic (`sql_tier`,
  `sql_high_availability=false`), with `STUDIO_JOB_QUEUE=sql` and `STUDIO_EVENT_BUS=sql`: no Redis.
  Blobs in Cloud Storage (`STUDIO_BLOB_STORE=gcs`, the objects and artifacts buckets) with the
  service's own identity.
- agent: Cloud SQL `agent` in the agent project (`ai/agent.tf`, small tier),
  `STUDIO_AGENT_STORE=postgres`, the in-memory run-event bus, so the agent stays at one instance
  until a shared bus exists. With no migrate Job on Cloud Run it applies its schema at startup
  (`STUDIO_AGENT_AUTO_MIGRATE=true`). Its database role and password are created by hand, like
  every other role, so no password is in Terraform state.
- WorkOS: the staging environment for staging, the production environment (its own Google client,
  todo9 Phase 14) for production.

### How secrets get in

Cloud Run mounts one secret version per env var or file, so each value is its own Secret Manager
secret (`run-*`, listed by output `run_secrets` in both stacks), CMEK-encrypted in the Studio
project. Terraform creates them empty and grants `secretAccessor` to the service that reads each
one; a person adds the values (`gcloud secrets versions add <id> --data-file=-`), so no value is
ever in state or in a file. Shared values are one secret read by both sides (the worker token, the
pipeline token); values shared across the two projects are set twice with the same value:

| Studio project | Agent project |
|---|---|
| `run-web-agent-token` | `run-agent-token` |
| `run-api-agent-service-token` | `run-agent-kernel-service-token` |
| `run-api-approval-secret` | `run-agent-approval-secret` |

Key files (the versioning and pipeline signing keys, their JWKS) are mounted as files at the paths
the GKE overlay used. Add every version before the first deploy, or the revision fails to start.

The agent's model is ai variable `agent_model` (`provider:model`, `apps/agent/src/agent/providers`).
The default is Muse on the Meta Model API, whose key is `run-agent-muse-api-key`. That API is outside
the Google BAA, so a stage using it runs on synthetic data only.

Each stage can show its own product name: variable `display_name` in both stacks sets
`STUDIO_DISPLAY_NAME` on web (served in `/config.json`) and on the agent (its prompts). Empty keeps
`NAMING.displayName`.

### Deploys

Every push to main deploys itself (`.github/workflows/deploy.yml`, `tools/deploy-run.sh`). After
`images` finishes, the deploy waits for `ci` on the same commit and skips it if main has moved
on. Then, for each app whose image was rebuilt (`sha-<commit>`):

1. the migrate jobs (`api-migrate`, `versioning-migrate`, `pipeline-migrate`, `phi/run-jobs.tf`)
   run on the new image;
2. versioning, pipeline, api, worker, the agent and web get a new revision in that order. Cloud
   Run only routes to a revision whose startup probe passes, so an image that doesn't boot never
   takes traffic;
3. a smoke test checks the Studio host (`/healthz`, `/config.json`, web's `/version`, the api's
   sign-in redirect) and the agent's `/version`;
4. if a rollout or the smoke test fails, every service it moved goes back to its previous
   revision and the run fails.

Migrations aren't rolled back, so each one has to work with the revision before it (add columns
and tables first, drop them in a later release). Terraform sets images only when it creates a
service; after that the deploy owns them (`ignore_changes`). CI signs in through Workload
Identity Federation in both projects (`ci.tf`): `ci-deploy` in the Studio project and
`ci-agent` in the agent project, each limited to main. Repo variables come from the two stacks'
`ci_*` outputs, plus `STUDIO_URL` (set once the certificate is active) and `AGENT_URL`. To
redeploy main by hand, run `gh workflow run deploy.yml`.

### WorkOS staging

In the WorkOS dashboard's staging environment (Redirects), add for the stage's host (output
`workos_urls`):

- redirect URI `https://<studio host>/api/auth/callback`;
- sign-out redirect `https://<studio host>/`;
- initiate login URL `https://<studio host>/api/auth/login`.

Set `workos_client_id` (both stacks) and the API key and cookie password secrets. Then sign in on
synthetic data and confirm a request with `X-Dev-Principal` gets 401.

### Plugin isolation

The worker runs plugin code in Cloud Run's first-generation execution environment (gVisor). Its VPC
egress is limited by firewall to the Studio load balancer's address on 443, which is the api's routes
with the worker token: no Google APIs, no Cloud SQL, no internet. Cloud Run's sandbox isn't a GKE
Sandbox node with NetworkPolicy, and the perimeter is still in dry-run, so **the stage holds
synthetic data only until the perimeter is enforced (todo10 A9)**.

### Not done yet

- Migrations: the api, versioning and pipeline migrate Jobs have no Cloud Run job yet; run them by
  hand (or as `gcloud run jobs`) before the first deploy.
- Cloud Run caps an HTTP/1 request body at 32 MiB, so large uploads must arrive in chunks.
- The perimeter must list `run.googleapis.com` among its restricted services before it is enforced.

## Sample templates

Sample projects (todo14 §3, §4.3) are templates in the Samples organization; "Try a sample"
makes a copy in the person's organization whose `assets` rows share the template's blob keys
(bytes are never copied per person). The bytes those keys name live in **`spurby-phi`**, under
the `samples/` prefix of the api's bucket (`gs://spurby-phi-objects/samples/`):

| What | Where |
|---|---|
| Template rows (projects, datasets, tasks) | `spurby-phi` Postgres, Samples org, upserted from `samples/manifest.json` once per api process (`ensure_seeds_once`) |
| Template bytes (`<template>/…`, `manifest.json`, `<template>/workspace.json`) | `gs://spurby-phi-objects/samples/` |
| A copy's rows | the person's organization, like any project |
| A copy's bytes | the template's keys under `samples/`; uploads to a copy go under `.data/` like any upload |

The api reads seed assets under `STUDIO_API_SAMPLES_PREFIX` (`samples` in
`overlays/gke/phi/patches/endpoints.yaml`): the seed manifest, `/seed/*`, signed asset URLs for
templates and copies. `.data/` (uploads, derived data) is unaffected. Its service account has
`roles/storage.objectUser` on the whole bucket (`infra/terraform/phi/storage.tf`), so no extra
grant is needed.

**Why a copy inside the perimeter.** The sample set is public data and its curated home is
`spurby-data` (`spurby-data-public`). But the api runs inside the VPC Service Controls perimeter,
and reading another project's bucket from there needs an egress rule, which the perimeter keeps
for the de-identified release path only. A one-off copy of public bytes into `spurby-phi` crosses
no boundary that matters and keeps the perimeter rules unchanged.

**Restricted templates are never uploaded.** Hyper-Kvasir, ACDC and TCGA (`restricted` in
`seed-data/manifest.json`) restrict commercial use or redistribution and stay local development
only. For a `gs://` target the tool drops them and their manifest entries, whatever the
arguments, so the api on Google Cloud never offers them.

**The copy (once per environment, and again when the sample set changes).** From a machine with
`seed-data/` (`pnpm seeds`), signed in as an operator listed in the perimeter's
`admin_identities` with object create rights on the bucket (or impersonating the deploy
identity). The upload goes from local disk to the bucket, never bucket to bucket across the
perimeter:

```sh
gcloud auth application-default login            # or --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com
uv run tools/fetch-seeds.py --upload-only=gs://spurby-phi-objects/samples/ --dry-run   # what would go up
uv run tools/fetch-seeds.py --upload-only=gs://spurby-phi-objects/samples/
```

It is idempotent: objects already there with the same size and `sha256` metadata are skipped,
so a second run uploads nothing. `manifest.json` goes up last, so the api never lists a
template whose bytes are still uploading. The api picks the templates up on its next start
(rollout restart of `api`). To check: `gcloud storage ls gs://spurby-phi-objects/samples/` lists
only public templates, and `GET /seed/manifest.json` on the Studio host lists the same ones.

The same command with `gs://spurby-data-public/samples/` keeps the curated copy in `spurby-data`
current (outside the perimeter; also public templates only).

## Drops: config, monitoring and rollout (todo13)

todo13 (drop anything into chat, plans, collections, the Datasets tab) adds no Google Cloud
product, API, IAM binding or perimeter change: Sensitive Data Protection is already enabled in
`spurby-phi` and the api has `roles/dlp.user`. What changes is config, log-based metrics and the
order flags go on.

**Config** (`infra/k8s/base/{api,worker}/configmap.yaml`; prod defaults, keys with the naming
config's `envPrefix`):

| Key | Base (prod) | What |
|---|---|---|
| `API_DROP_MAX_FILES` / `API_DROP_MAX_BYTES` | 10,000 / 50 GB | per drop; above it the card points to Files' folder upload |
| `API_DROP_RATE_PER_MINUTE` | 20 | drops a minute per person (429 with a retry hint) |
| `API_DROP_UNDO_SECONDS` | 30 | Undo window of an automatically applied plan |
| `API_NAME_SCREEN_MODE` | `dlp` | `regex` in dev and tests; `off` is refused in production |
| `API_NAME_SCREEN_BATCH` / `_QPS` / `_LOCATION` | 500 / 5 / `us-central1` | names per call, calls per second per pod (live and backfill share it) |
| `API_NAME_SCREEN_PROJECT` | `spurby-phi` (phi overlay) | where the screening calls go |
| `API_FEATURE_CHAT_DROPS`, `_DATASETS_TAB`, `_FAST_PATH`, `_AUTO_APPLY` | `false` | on by rollout (below); the dev overlay turns all on |
| `WORKER_UNPACK_MAX_BYTES` / `_MAX_FILES` / `_MAX_RATIO` / `_MAX_DEPTH` / `_TMP_BYTES` | 20 GB / 50,000 / 100 / 2 / 6 GB | archive unpack, sized to the worker pod (4 GiB memory, 8 GiB `/tmp`) |

**Monitoring** (`infra/terraform/phi/monitoring.tf`, applied by a person with the phi stack). The
api logs one JSON line per drop transition (`drop.received` … `drop.applied`, `drop.undone`,
`drop.failed {step, errorClass}`, `drop.stuck`), the browser's timeline (`drop.timeline`,
durations only, from `POST /api/v1/telemetry/timeline`) and name screening calls
(`name_screen.batch`, `name_screen.error`). Log-based metrics: `drop_first_interactive_ms`
(distribution; p50/p95 in Metrics Explorer), `drop_failures` (by step and error class),
`drop_unpack_refusals` (by reason), `drops_stuck_inspecting`, `name_screen_errors` and
`name_screen_batches`, `drop_auto_applied` and `drop_auto_undone` (the undo rate is their
ratio). Alerts: p95 drop to first interactive over 30 s for 15 minutes; screening error rate
over 5 %; any drop stuck inspecting over 10 minutes. Set `alert_notification_channels` to page
someone; without it the alerts only open incidents.

### Rolling out drops (runbook)

Run from the repo root with the deploy identity; every `kubectl` against the phi cluster
(namespace `studio`). Nothing here deletes a File.

**Dev** (kind/k3d, `infra/k8s/overlays/dev`): every flag is on and names use the regex screen.

1. `kubectl apply -k infra/k8s/overlays/dev`, then run the journeys:
   `python3 tests/e2e/journey_test.py --port <vite>` (its docstring has the commands); J1–J9 and
   the D13 walk test (`uv run --package studio-api pytest apps/api/tests/test_drops.py -k no_agent_route`)
   green.

**Staging** (synthetic data only):

1. Deploy the images with the flags off (the base). The api runs the Alembic migrations
   `0011` (drops, screened-name columns) and `0012` (collections, drop plans, structures; it
   backfills one collection per detected kind for existing datasets and points each task at
   the one holding its items).
2. Screening backfill: `kubectl exec deploy/api -- python -m studio_api.kernel.name_screen
   backfill` (resumable; the worker's `files.screen_names` also does it about once a minute).
   Wait until it reports nothing left; meanwhile agents see `file-<n>.<ext>`.
3. Check every existing Studio opens on the same items (open a few; the journeys' J11 does this
   for a fixture database).
4. Turn the flags on one at a time, **a day apart**, each by editing the api ConfigMap value and
   `kubectl rollout restart deploy/api` (the web app reads flags once at start; reload):
   `API_FEATURE_CHAT_DROPS` → `API_FEATURE_DATASETS_TAB` → `API_FEATURE_FAST_PATH` →
   `API_FEATURE_AUTO_APPLY`. After each, watch the §7.3 metrics for a day: drop failures by
   step, screening errors, p95 drop to first interactive, and (after auto-apply) the undo rate.

**Prod** (a person, after review):

1. `terraform plan` then `apply` in `infra/terraform/phi` (adds only `monitoring.tf`'s metrics
   and alerts); set `alert_notification_channels`.
2. Deploy with the flags off (the base values); the migrations `0011`/`0012` run.
3. Screening backfill as in staging, then measure the Sensitive Data Protection cost per 10,000
   names (Billing, SKU "Inspection") and record it here.
4. Check that every existing Studio opens on the same items.
5. The flags, in the staging order, a day apart, watching the alerts.

**Rollback.** Turn the flag off and restart the api: its UI and routes disappear (they answer
404), drops already made stay in Files. With every flag off the product behaves as before
todo13. The collections migration has a tested `downgrade` (`alembic downgrade 0011` drops the
collections, drop plans and structures, never files); the screened-name columns are additive and
stay. Never roll back by deleting Files.
