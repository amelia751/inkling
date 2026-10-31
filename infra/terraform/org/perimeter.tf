resource "google_access_context_manager_access_policy" "org" {
  parent = "organizations/${var.org_id}"
  title  = "org"
}

# Only the PHI project is inside. No ingress for outside identities: the agent (spurby-ai) uses our
# API over HTTPS. Egress for the de-identified release copy to spurby-data is added with its bucket.
resource "google_access_context_manager_service_perimeter" "phi" {
  parent = "accessPolicies/${google_access_context_manager_access_policy.org.name}"
  name   = "accessPolicies/${google_access_context_manager_access_policy.org.name}/servicePerimeters/phi"
  title  = "phi"

  use_explicit_dry_run_spec = !var.perimeter_enforced

  dynamic "status" {
    for_each = var.perimeter_enforced ? [1] : []
    content {
      resources           = ["projects/${data.google_project.phi.number}"]
      restricted_services = var.restricted_services
    }
  }

  dynamic "spec" {
    for_each = var.perimeter_enforced ? [] : [1]
    content {
      resources           = ["projects/${data.google_project.phi.number}"]
      restricted_services = var.restricted_services
    }
  }
}
