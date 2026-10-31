# Container images for the apps in this project, and OCI plugin artifacts (todo10 Phase 8, ORAS).
# Inside the perimeter, so nodes pull through restricted.googleapis.com. CI pushes with GitHub
# OIDC through Workload Identity Federation (not set up here; needs a perimeter ingress rule).
resource "google_artifact_registry_repository" "this" {
  for_each      = { images = "Studio container images", plugins = "Plugin bundles as OCI artifacts" }
  repository_id = each.key
  location      = var.region
  format        = "DOCKER"
  description   = each.value
  kms_key_name  = google_kms_crypto_key.cmek["registry"].id

  docker_config {
    immutable_tags = true
  }

  depends_on = [google_kms_crypto_key_iam_member.cmek]
}

resource "google_artifact_registry_repository_iam_member" "nodes" {
  repository = google_artifact_registry_repository.this["images"].name
  location   = var.region
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.nodes.email}"
}
