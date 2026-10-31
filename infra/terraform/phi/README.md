# spurby-phi stack

Everything that touches customer data, inside the perimeter (`../org/perimeter.tf`). Layout and
reasons: `docs/deployment-gcp.md`; the Kubernetes side is `infra/k8s/overlays/gke/phi`.

| File | What |
|---|---|
| `network.tf` | VPC, private services access (Cloud SQL, Memorystore), DNS for `restricted.googleapis.com`, Cloud NAT with a fixed address (only the web proxy to the agent may use it) |
| `kms.tf` | key ring `studio`: one CMEK key per service; `plugin-signing` (HSM, `EC_SIGN_P256_SHA256`) |
| `storage.tf` | buckets `objects` (api BlobStore), `artifacts` (retention, lockable), `versioning-objects`, `versioning-manifests`, `audit-logs` |
| `data-services.tf` | Cloud SQL for PostgreSQL 17 (private IP, CMEK, PITR), Memorystore for Redis (AUTH, TLS, CMEK) |
| `gke.tf` | GKE Autopilot, private nodes, DNS control-plane endpoint, Secrets encrypted with CMEK, Binary Authorization; GKE Sandbox per pod (`runtimeClassName: gvisor`) |
| `iam.tf` | one Google service account per Kubernetes service account that needs Google APIs (Workload Identity) |
| `secrets.tf` | empty Secret Manager secrets, one per `<app>-secrets` (JSON of its keys) |
| `registry.tf` | Artifact Registry `images` and `plugins` (OCI) |
| `audit.tf` | Data Access logs on; audit logs sunk to the `audit-logs` bucket |
| `healthcare.tf` | Healthcare API dataset and DICOM stores for de-identification |
| `cdn.tf` | Cloud CDN on the artifacts bucket, off until `cdn_domain` is set (read its comment first) |

Same keyless deploy identity and state bucket as `../org` (state prefix `phi`):

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com --configuration=spurby-phi)
terraform init
terraform plan
terraform apply          # a person's go-ahead only
```

Irreversible switches, off by default: `artifacts_retention_locked`, `audit_retention_locked`.

## After apply (by hand, never in Terraform state)

- Database roles: connect as `postgres` (set its password with `gcloud sql users set-password`),
  create the api's role and `versioning_owner` / `versioning_app` (`apps/versioning/README.md`,
  `migrate bootstrap`).
- Secret values: one JSON object per secret, e.g.
  `gcloud secrets versions add api-secrets --data-file=- <<< '{"INKLING_API_DATABASE_URL":"…",…}'`.
  Keys per secret are in `infra/k8s/README.md`. `api-versioning-jwt` holds `{"jwt.key":"<PEM>"}`.
- Copy the outputs into `infra/k8s/overlays/gke/phi` (its README lists which).
