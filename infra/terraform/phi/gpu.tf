# Milestone 4 (todo12 A10): GPU steps run as GPU-class kernel jobs on a second worker
# Deployment, `worker-gpu`, on Autopilot's Accelerator compute class (NVIDIA L4, GKE Sandbox,
# Spot for retryable jobs; infra/k8s/overlays/gke/phi/components/gpu-worker). Autopilot makes
# the nodes, so the only Google Cloud piece is quota: new projects start with no L4s.
#
# Off until gpu_workers_enabled=true. Applying it files the quota request; a person does that
# (it can need billing review, and Google may grant less than asked, in which case the console
# shows the granted value and Terraform shows a diff until preferred_value matches it). The same
# request can be made by hand: IAM & Admin → Quotas, filter "NVIDIA L4", region var.region.
locals {
  gpu_quotas = var.gpu_workers_enabled ? {
    l4-on-demand = { quota_id = "NVIDIA-L4-GPUS-per-project-region", value = var.gpu_l4_quota.on_demand, dims = { region = var.region } }
    l4-spot      = { quota_id = "PREEMPTIBLE-NVIDIA-L4-GPUS-per-project-region", value = var.gpu_l4_quota.spot, dims = { region = var.region } }
    # The project-wide GPU cap, 0 by default on new projects, bounds both of the above.
    all-regions = { quota_id = "GPUS-ALL-REGIONS-per-project", value = var.gpu_l4_quota.on_demand + var.gpu_l4_quota.spot, dims = {} }
  } : {}
}

resource "google_cloud_quotas_quota_preference" "gpu" {
  for_each      = local.gpu_quotas
  parent        = "projects/${var.project}"
  name          = "compute-${each.key}"
  service       = "compute.googleapis.com"
  quota_id      = each.value.quota_id
  dimensions    = each.value.dims
  contact_email = var.quota_contact_email
  justification = "GKE Autopilot GPU worker (NVIDIA L4, GKE Sandbox) for image segmentation steps."
  quota_config {
    preferred_value = each.value.value
  }
  depends_on = [google_project_service.this]

  lifecycle {
    precondition {
      condition     = var.quota_contact_email != ""
      error_message = "gpu_workers_enabled needs -var quota_contact_email=… (who Google contacts about the request)."
    }
  }
}
