# CI pushes images to Artifact Registry `images` with GitHub's OIDC token through Workload
# Identity Federation: no key file anywhere (todo12 A6). Created only when the repository is
# passed in (-var github_repository=… -var github_repository_id=… -var
# github_repository_owner_id=…), so no account identifier is committed.
#
# Who gets in: the provider refuses any token whose repository and owner IDs differ from ours or
# whose ref isn't refs/heads/main (pull requests, other branches, tags and forks get nothing). Only
# that one repository may impersonate `ci-images`, which may only write to `images`.
#
# The perimeter (infra/terraform/org) also has to admit `ci-images` to Artifact Registry from
# outside; that ingress rule is a person's change to the org stack.
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

  # Evaluated on every token exchange; a mismatch gets no credential at all.
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.repository_owner_id == '${var.github_repository_owner_id}'",
    "assertion.repository == '${var.github_repository}'",
    "assertion.ref == 'refs/heads/main'",
  ])
}

resource "google_service_account" "ci_images" {
  count        = local.ci_enabled ? 1 : 0
  account_id   = "ci-images"
  display_name = "GitHub Actions on main: push images to Artifact Registry `images`"
}

resource "google_service_account_iam_member" "ci_images_wif" {
  count              = local.ci_enabled ? 1 : 0
  service_account_id = google_service_account.ci_images[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository_id/${var.github_repository_id}"
}

resource "google_artifact_registry_repository_iam_member" "ci_images" {
  count      = local.ci_enabled ? 1 : 0
  repository = google_artifact_registry_repository.this["images"].name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.ci_images[0].email}"
}

# .github/workflows/deploy.yml: new revisions of the Cloud Run services and the migrate jobs.
# It can't change their identities, env or secrets (Terraform owns those), only roll images.
resource "google_service_account" "ci_deploy" {
  count        = local.ci_enabled ? 1 : 0
  account_id   = "ci-deploy"
  display_name = "GitHub Actions on main: roll Cloud Run images"
}

resource "google_service_account_iam_member" "ci_deploy_wif" {
  count              = local.ci_enabled ? 1 : 0
  service_account_id = google_service_account.ci_deploy[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository_id/${var.github_repository_id}"
}

resource "google_project_iam_member" "ci_deploy" {
  count   = local.ci_enabled ? 1 : 0
  project = var.project
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.ci_deploy[0].email}"
}

resource "google_artifact_registry_repository_iam_member" "ci_deploy" {
  count      = local.ci_enabled ? 1 : 0
  repository = google_artifact_registry_repository.this["images"].name
  location   = var.region
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.ci_deploy[0].email}"
}

resource "google_service_account_iam_member" "ci_deploy_act_as" {
  for_each           = local.ci_enabled ? toset(distinct(values(local.run_sa))) : toset([])
  service_account_id = "projects/${var.project}/serviceAccounts/${each.value}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci_deploy[0].email}"
}
