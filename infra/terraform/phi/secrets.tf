# One Secret Manager secret per Kubernetes Secret (`<app>-secrets`, infra/k8s/README.md), each a
# JSON object of its keys. Terraform creates the empty secrets; a person adds versions
# (README.md), so no value is ever in state. The External Secrets Operator syncs them into the
# cluster (infra/k8s/overlays/gke/phi/external-secrets.yaml).
# pipeline-versioning-jwt holds {"jwt.key": "<PEM>"} for the pipeline's versioning calls (kid
# `pipeline`). db-bootstrap-secrets holds the admin DSN and the role passwords the db-bootstrap
# Job sets; add a version only while bootstrapping, then disable it. workos-secrets holds the
# WorkOS API key, session cookie password (a Fernet key) and client id (todo9), read by api and
# worker; it stays empty until sign-in is turned on (overlays/gke/phi/components/workos).
locals {
  app_secrets = toset([
    "web-secrets",
    "api-secrets",
    "worker-secrets",
    "versioning-secrets",
    "api-versioning-jwt",
    "pipeline-secrets",
    "pipeline-versioning-jwt",
    "db-bootstrap-secrets",
    "workos-secrets",
  ])
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.app_secrets
  secret_id = each.key
  replication {
    user_managed {
      replicas {
        location = var.region
        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.cmek["secrets"].id
        }
      }
    }
  }
  depends_on = [google_kms_crypto_key_iam_member.cmek]
}

resource "google_secret_manager_secret_iam_member" "eso" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app["external-secrets"].email}"
}
