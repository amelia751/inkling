# spurby-phi stack

Everything that touches customer data, inside the perimeter (`../org/perimeter.tf`). Layout and
reasons: `.agents/skills/data-boundary/deployment-gcp.md`; the Kubernetes side is `infra/k8s/overlays/gke/phi`.

| File | What |
|---|---|
| `network.tf` | VPC, private services access (Cloud SQL, Memorystore), DNS for `restricted.googleapis.com`, Cloud NAT with a fixed address (only the web proxy to the agent may use it) |
| `kms.tf` | key ring `studio`: one CMEK key per service; `plugin-signing` (HSM, `EC_SIGN_P256_SHA256`) |
| `storage.tf` | buckets `objects` (api BlobStore), `artifacts` (retention, lockable), `versioning-objects`, `versioning-manifests`, `audit-logs` |
| `data-services.tf` | Cloud SQL for PostgreSQL 17 (private IP, CMEK, PITR; databases `studio` and `pipeline_engine`), Memorystore for Redis (AUTH, TLS, CMEK) |
| `gke.tf` | GKE Autopilot, private nodes, DNS control-plane endpoint, Secrets encrypted with CMEK, Binary Authorization; GKE Sandbox per pod (`runtimeClassName: gvisor`) |
| `iam.tf` | one Google service account per Kubernetes service account that needs Google APIs (Workload Identity) |
| `secrets.tf` | empty Secret Manager secrets, one per `<app>-secrets` (JSON of its keys) |
| `registry.tf` | Artifact Registry `images` and `plugins` (OCI) |
| `audit.tf` | Data Access logs on; audit logs sunk to the `audit-logs` bucket |
| `healthcare.tf` | Healthcare API dataset and DICOM stores for de-identification |
| `cdn.tf` | Cloud CDN on the artifacts bucket, off until `cdn_domain` is set (read its comment first) |
| `ci.tf` | GitHub OIDC → Workload Identity Federation: pool `github`, provider `github-main` (this repository's `main` only), service account `ci-images` (`artifactregistry.writer` on `images`). Off until the `github_*` variables are passed |
| `pipeline-connectors.tf` | Milestone 3, off (`pipeline_connectors_enabled`): service account `studio-pipeline`, Pub/Sub topic + pull subscription (CMEK key `pubsub`, dead-letter topic), `landing` bucket, notifications |
| `gpu.tf` | Milestone 4, off (`gpu_workers_enabled`): regional NVIDIA L4 quota preferences (on-demand and Spot) |

Same keyless deploy identity and state bucket as `../org` (state prefix `phi`):

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com --configuration=spurby-phi)
terraform init
terraform plan -var github_repository=<owner>/<name> \
  -var github_repository_id=$(gh api repos/<owner>/<name> --jq .id) \
  -var github_repository_owner_id=$(gh api repos/<owner>/<name> --jq .owner.id)
terraform apply          # a person's go-ahead only
```

Without the `github_*` variables the CI federation isn't created (and a later plan without them
would destroy it), so keep passing them. Milestone switches, off by default:
`pipeline_connectors_enabled` (Milestone 3), `gpu_workers_enabled` with `quota_contact_email`
(Milestone 4).

Irreversible switches, off by default: `artifacts_retention_locked`, `audit_retention_locked`.

## After apply (by hand, never in Terraform state)

- Database roles: set the `postgres` password (`gcloud sql users set-password postgres
  --instance=studio --prompt-for-password`), put `{"ADMIN_DATABASE_URL":…,"API_APP_PASSWORD":…,
  "PIPELINE_APP_PASSWORD":…}` in `db-bootstrap-secrets`, and run the suspended `db-bootstrap` Job
  (`infra/k8s/base/jobs/db-bootstrap.yaml`; the SQL is `db-bootstrap.sql` next to it): roles
  `api_app` and `pipeline_app`, schema `pipeline`, owner of `pipeline_engine`. Then versioning's
  `migrate bootstrap` (`apps/versioning/README.md`). Destroy the `db-bootstrap-secrets` version after.
- Secret values: one JSON object per secret, e.g.
  `gcloud secrets versions add api-secrets --data-file=- <<< '{"STUDIO_API_DATABASE_URL":"…",…}'`.
  Keys per secret are in `infra/k8s/README.md`; `workos-secrets` stays empty until sign-in is turned on (todo9; `README.md`, "Signing in"). `api-versioning-jwt` and `pipeline-versioning-jwt` hold `{"jwt.key":"<PEM>"}`, written by
  `node tools/versioning-keys.mjs --gcp-project spurby-phi …` (it never prints a key).
- Copy the outputs into `infra/k8s/overlays/gke/live/phi/local.env` (git-ignored;
  `infra/k8s/overlays/gke/README.md` lists which).
- CI: set the repository variables `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_CI_SERVICE_ACCOUNT`
  (outputs `ci_workload_identity_provider`, `ci_service_account`) and `GCP_IMAGES_REGISTRY`
  (`us-central1-docker.pkg.dev/<project>/images`); `.github/workflows/images.yml` then also
  pushes there. Admit `ci-images` to Artifact Registry through the perimeter
  (an ingress rule in `../org`, a person's change).
