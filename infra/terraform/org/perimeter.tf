resource "google_access_context_manager_access_policy" "org" {
  parent = "organizations/${var.org_id}"
  title  = "org"
}

# Only the PHI project is inside. No ingress for the agent (spurby-ai): it uses our API over HTTPS.
# Two rules:
# - ingress for the operators in var.admin_identities (the deploy identity first): once enforced,
#   Terraform's own state bucket and kubectl to the GKE control plane are inside the perimeter;
# - egress for the de-identified release copy: only the release identity, only object creation,
#   only into spurby-data (infra/terraform/data grants it objectCreator on the releases bucket).
locals {
  release_identity = "serviceAccount:${var.release_service_account}@${var.phi_project}.iam.gserviceaccount.com"
}
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

      dynamic "ingress_policies" {
        for_each = length(var.admin_identities) > 0 ? [1] : []
        content {
          ingress_from {
            identities = var.admin_identities
            sources {
              access_level = "*"
            }
          }
          ingress_to {
            resources = ["*"]
            operations {
              service_name = "*"
            }
          }
        }
      }

      dynamic "egress_policies" {
        for_each = var.release_egress ? [1] : []
        content {
          egress_from {
            identities = [local.release_identity]
          }
          egress_to {
            resources = ["projects/${data.google_project.data.number}"]
            operations {
              service_name = "storage.googleapis.com"
              method_selectors {
                method = "google.storage.objects.create"
              }
            }
          }
        }
      }
    }
  }

  dynamic "spec" {
    for_each = var.perimeter_enforced ? [] : [1]
    content {
      resources           = ["projects/${data.google_project.phi.number}"]
      restricted_services = var.restricted_services

      dynamic "ingress_policies" {
        for_each = length(var.admin_identities) > 0 ? [1] : []
        content {
          ingress_from {
            identities = var.admin_identities
            sources {
              access_level = "*"
            }
          }
          ingress_to {
            resources = ["*"]
            operations {
              service_name = "*"
            }
          }
        }
      }

      dynamic "egress_policies" {
        for_each = var.release_egress ? [1] : []
        content {
          egress_from {
            identities = [local.release_identity]
          }
          egress_to {
            resources = ["projects/${data.google_project.data.number}"]
            operations {
              service_name = "storage.googleapis.com"
              method_selectors {
                method = "google.storage.objects.create"
              }
            }
          }
        }
      }
    }
  }
}
