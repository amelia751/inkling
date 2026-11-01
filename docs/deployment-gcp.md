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
| `spurby-phi` | Everything a customer uploads; `apps/api`, `apps/worker`, `apps/versioning` serving it; Cloud SQL, Cloud Storage, Cloud KMS, Healthcare API, Sensitive Data Protection | Inside a VPC Service Controls perimeter. Only products on Google's HIPAA covered-products list. |
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
routes in `spurby-phi`, enforced by the agent's token scope in `apps/api`:

- `get_fingerprint`, `get_fixtures`: scrubbed structure and synthetic files;
- `verify_on_sample`, `probe_sample`: fixed-schema reports and typed answers, free text dropped or
  checked;
- job start and job summary: counts, statuses, error classes;
- environment and plugin control-plane routes (no item bytes). The plugin artifact routes
  (`/plugins/{id}/files`, `…/export`, `/plugins/import`, promotions, `…/plugins/load-refused`)
  aren't on the agent allow-list (`kernel/agent_scope.py`); export, import and promotion review
  also need `plugins.approve`, which agent tokens never carry;
- a filtered annotation view: geometries and controlled-vocabulary labels; free text checked first.

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
| Postgres | Cloud SQL for PostgreSQL 17, private IP, CMEK |
| `BlobStore`, plugin artifacts | Cloud Storage; retention lock on the artifacts bucket |
| Bundle delivery | Cloud CDN in front of the artifacts bucket |
| Platform signing key | Cloud KMS asymmetric key, HSM protection (cosign `gcpkms://…`) |
| First-party CI signing | GitHub OIDC through Workload Identity Federation |
| Container images, OCI artifacts | Artifact Registry; Binary Authorization |
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
4. [~] Infrastructure inside each project, written and planned, not applied: one Terraform stack
   per project (`infra/terraform/{phi,ai,data}`, each with a README), and the Kubernetes overlays
   `infra/k8s/overlays/gke/{phi,ai}`.

Steps 1–3 come before any customer data arrives.

### Before the first apply

- The state bucket `gs://spurby-phi-tfstate` sits in `spurby-phi`, where CMEK is now required for
  Cloud Storage, so it refuses new objects (locks, new stacks' state, the next state version of
  `org`) until it has a default KMS key. Give it one, in location `us` (the bucket's), by hand,
  before any Terraform apply.
- `spurby-ai` is outside the organization, so the deploy identity needs a role there, granted by
  the project's owner (`infra/terraform/ai/README.md`).

### How the pieces connect

- Both clusters are GKE Autopilot with private nodes. Plugin code on real data runs only in the
  `spurby-phi` worker, under GKE Sandbox (`runtimeClassName: gvisor`), with no egress except the
  api. Build sandboxes in `spurby-ai` (agent-sandbox, gVisor) have no network at all.
- The two projects talk over HTTPS between fixed Cloud NAT addresses: web → the agent's host, the
  agent → a separate agent-only host on the api (the Studio's host refuses the agent's address).
  Details: `infra/k8s/overlays/gke/README.md`.
- Pods use Workload Identity; app secrets are Secret Manager secrets synced by the External
  Secrets Operator into the usual `<app>-secrets`. Cloud Storage is reached through its native API
  (`BLOB_STORE=gcs` in apps/api, `OBJECT_STORE=gcs` in apps/versioning), never HMAC keys.
- The agent's model is on Vertex AI in `spurby-ai` (`AGENT_MODEL=google-vertex:…`, D8) and its
  allowlist holds only Vertex models. Confirm that the BAA covers `spurby-ai` (a separate billing
  account outside the organization) and that the model is on the HIPAA covered list.
