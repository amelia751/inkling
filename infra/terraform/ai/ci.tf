# GitHub Actions in this project, the same way as infra/terraform/phi/ci.tf: OIDC through
# Workload Identity Federation, only this repository's main branch, no key file. `ci-agent`
# pushes the agent image to `images` and rolls the agent service. Created only when the
# github_* variables are passed in.
locals {
  ci_enabled = var.github_repository != "" && var.github_repository_id != "" && var.github_repository_owner_id != ""
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = local.ci_enabled ? 1 : 0
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "OIDC tokens from GitHub Actions (ci.tf)"
  depends_on                = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = local.ci_enabled ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-main"
  display_name                       = "GitHub main branch"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_id"    = "assertion.repository_id"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
    "attribute.workflow_ref"     = "assertion.workflow_ref"
  }

  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.repository_owner_id == '${var.github_repository_owner_id}'",
    "assertion.repository == '${var.github_repository}'",
    "assertion.ref == 'refs/heads/main'",
  ])
}

resource "google_service_account" "ci_agent" {
  count        = local.ci_enabled ? 1 : 0
  account_id   = "ci-agent"
  display_name = "GitHub Actions on main: push the agent image, roll the agent service"
}

resource "google_service_account_iam_member" "ci_agent_wif" {
  count              = local.ci_enabled ? 1 : 0
  service_account_id = google_service_account.ci_agent[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository_id/${var.github_repository_id}"
}

resource "google_artifact_registry_repository_iam_member" "ci_agent" {
  count      = local.ci_enabled ? 1 : 0
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.ci_agent[0].email}"
}

resource "google_project_iam_member" "ci_agent" {
  count   = local.ci_enabled ? 1 : 0
  project = var.project
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.ci_agent[0].email}"
}

resource "google_service_account_iam_member" "ci_agent_act_as" {
  count              = local.ci_enabled ? 1 : 0
  service_account_id = google_service_account.app["agent"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci_agent[0].email}"
}
