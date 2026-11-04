# Secrets for the Cloud Run stage. Cloud Run mounts a whole secret version as one env var or
# file, so each value is its own secret here (the GKE `<app>-secrets` JSON objects in secrets.tf
# stay for External Secrets until the cluster is gone). Terraform creates them empty; a person
# adds versions (`gcloud secrets versions add <id> --data-file=-`), so no value is in state.
# Shared values are one secret read by both sides (the worker token, the pipeline token).
locals {
  # secret id => services that read it.
  run_secrets = {
    "run-api-database-url"                = ["api"]
    "run-api-secret-key"                  = ["api"]
    "run-api-approval-secret"             = ["api"]
    "run-api-agent-service-token"         = ["api"] # same value as the agent's STUDIO_AGENT_KERNEL_SERVICE_TOKEN
    "run-api-workos-api-key"              = ["api"]
    "run-api-workos-cookie-password"      = ["api"] # a Fernet key
    "run-api-versioning-jwt-key"          = ["api"] # Ed25519 PKCS8 PEM (tools/versioning-keys.mjs), mounted as a file
    "run-api-provider-key-meta"           = ["api"] # todo25 D4: the Studio-managed Meta Model API key (SAM 3.1); add a version before the apply that references it
    "run-worker-token"                    = ["api", "worker"]
    "run-pipeline-token"                  = ["api", "pipeline"]
    "run-web-agent-token"                 = ["web"] # same value as the agent's STUDIO_AGENT_TOKEN
    "run-versioning-database-url"         = ["versioning"]
    "run-versioning-migrate-database-url" = ["versioning"] # the schema owner, for the versioning-migrate job
    "run-versioning-jwks"                 = ["versioning"] # public keys of the api and pipeline signers, a file
    "run-pipeline-database-url"           = ["pipeline"]
    "run-pipeline-engine-database-url"    = ["pipeline"]
    "run-pipeline-versioning-jwt-key"     = ["pipeline"] # a file
    "run-api-jwks"                        = ["pipeline"] # the api signer's public key, a file
  }
  run_secret_access = merge([
    for id, readers in local.run_secrets : { for r in readers : "${id}/${r}" => { secret = id, reader = r } }
  ]...)
}

resource "google_secret_manager_secret" "run" {
  for_each  = local.run_secrets
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

resource "google_secret_manager_secret_iam_member" "run" {
  for_each  = local.run_secret_access
  secret_id = google_secret_manager_secret.run[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.run_sa[each.value.reader]}"
}
