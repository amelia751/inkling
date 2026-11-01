# One Google service account per Kubernetes service account that needs Google APIs, bound
# through Workload Identity (no key files). The worker and web have none: the worker talks only
# to the api, web only to the agent. The pipeline gets one only from Milestone 3
# (pipeline_connectors_enabled, pipeline-connectors.tf): Pub/Sub and connector bucket reads.
resource "google_service_account" "app" {
  for_each = merge({
    api              = "apps/api: BlobStore, plugin signing, Healthcare API, Sensitive Data Protection"
    versioning       = "apps/versioning: object and manifest buckets"
    release          = "De-identified release copy to spurby-data (one-way, audited)"
    external-secrets = "External Secrets Operator: reads app secrets from Secret Manager"
    }, var.pipeline_connectors_enabled ? {
    pipeline = "apps/pipeline (Milestone 3): connector notifications and bucket listing, read-only"
  } : {})
  account_id   = each.key == "external-secrets" ? "external-secrets" : "studio-${each.key}"
  display_name = each.value
  depends_on   = [google_project_service.this]
}

resource "google_service_account_iam_member" "workload_identity" {
  for_each           = google_service_account.app
  service_account_id = each.value.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.wi[each.key]
  depends_on         = [google_container_cluster.studio]
}

# Signed URLs without a key file: the app signs through the IAM signBlob API as itself.
resource "google_service_account_iam_member" "self_sign" {
  for_each           = toset(["api", "versioning"])
  service_account_id = google_service_account.app[each.key].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.app[each.key].email}"
}

# Fingerprinting and free-text checks (todo10 Phase 9 item 4) are brokered by the api.
resource "google_project_iam_member" "api_dlp" {
  project = var.project
  role    = "roles/dlp.user"
  member  = "serviceAccount:${google_service_account.app["api"].email}"
}
