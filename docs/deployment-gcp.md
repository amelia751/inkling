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
| Secrets | Secret Manager + Workload Identity, surfaced as the usual `INKLING_*` env vars |
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
   Google-API ingress for `spurby-ai` (the agent uses our API over HTTPS). Written, not applied: an
   ingress rule for operators (`admin_identities`, the deploy identity first, so Terraform's state
   and kubectl still work once enforced) and the one-way release egress rule to `spurby-data`
   (`release_egress`). Watch dry-run violations (`python3 tests/gcp/perimeter_test.py --expect
   dry-run --check-log`), then enforce before customer data and rerun it with `--expect enforced`.
4. [ ] State bucket key (todo12 A1): `gs://spurby-phi-tfstate` gets a default CMEK key from a
   small hand-made key ring `tfstate` in location `us` (the phi stack's ring is regional and
   doesn't exist before its first apply). Commands: todo12 A1. Until then every stack's
   `terraform init` fails writing its lock (`412 … CMEK is required`).
5. [~] Infrastructure inside each project, written and planned, not applied: one Terraform stack
   per project (`infra/terraform/{phi,ai,data}`, each with a README), and the Kubernetes overlays
   `infra/k8s/overlays/gke/{phi,ai}`. Apply order: `phi`, `data`, `ai` (todo12 A3).
6. [ ] Cluster add-ons (ingress-nginx, cert-manager, External Secrets, KEDA; mirrored images),
   namespace `studio`, ConfigMap `redis-ca` (`infra/k8s/overlays/gke/README.md`).
7. [ ] Databases: set the `postgres` password, fill `db-bootstrap-secrets` and run the suspended
   `db-bootstrap` Job (roles `api_app` and `pipeline_app` with their connection limits, schema
   `pipeline`, owner of `pipeline_engine`; `infra/k8s/base/jobs/db-bootstrap.sql`), then
   versioning's `migrate bootstrap`. Then fill the `<app>-secrets` in Secret Manager
   (`pipeline-secrets` and `pipeline-versioning-jwt` from pipeline Milestone 1).
8. [ ] Images: CI through Workload Identity Federation (`ci.tf`; plus a perimeter ingress rule for
   `ci-images`), or a person under impersonation; digests into the overlays.
9. [ ] Render with real values (`infra/k8s/overlays/gke/live/{phi,ai}`, from git-ignored
   `local.env` files filled from `terraform output`), validate, apply; DNS.
10. [ ] Smoke test on synthetic data, then enforce the perimeter (step 3) before any customer data.

Steps 1–3 come before any customer data arrives; the pipeline's Milestone 3 (Pub/Sub,
`pipeline_connectors_enabled`) and Milestone 4 (GPU, `gpu_workers_enabled` and the L4 quota) each
switch on only when that milestone ships.

### Before the first apply

- The state bucket `gs://spurby-phi-tfstate` sits in `spurby-phi`, where CMEK is now required for
  Cloud Storage, so it refuses new objects (locks, new stacks' state, the next state version of
  `org`) until it has a default KMS key. Give it one, in location `us` (the bucket's), by hand,
  before any Terraform apply: key ring `tfstate`, key `state` (90-day rotation), the Cloud Storage
  service agent as its encrypter/decrypter, then `gcloud storage buckets update
  gs://spurby-phi-tfstate --default-encryption-key=…` (setup order step 4). Not done yet.
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
- The agent's model is on Vertex AI in `spurby-ai` (`AGENT_MODEL=google-vertex:…`, D8) and its
  allowlist holds only Vertex models. Confirm that the BAA covers `spurby-ai` (a separate billing
  account outside the organization) and that the model is on the HIPAA covered list.
