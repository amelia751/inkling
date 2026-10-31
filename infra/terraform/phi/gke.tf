# GKE Autopilot for web, api, worker and versioning (infra/k8s/overlays/gke/phi).
#
# GKE Sandbox: on Autopilot there are no node pools to manage; a pod asks for gVisor with
# `runtimeClassName: gvisor` and Autopilot schedules it on sandboxed nodes. The gke overlay sets
# it on the worker, the only pod that runs plugin code on real data.
#
# Private nodes (no external IPs, per the org policy). kubectl reaches the control plane through
# its DNS endpoint, authorised by IAM; the IP endpoint admits no public networks.
resource "google_container_cluster" "studio" {
  name                = "studio"
  location            = var.region
  enable_autopilot    = true
  network             = google_compute_network.studio.id
  subnetwork          = google_compute_subnetwork.gke.id
  deletion_protection = true

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.master_ipv4_cidr
  }

  master_authorized_networks_config {
    gcp_public_cidrs_access_enabled = false
  }

  control_plane_endpoints_config {
    dns_endpoint_config {
      allow_external_traffic = true
    }
  }

  # Kubernetes Secrets encrypted with our key at the application layer.
  database_encryption {
    state    = "ENCRYPTED"
    key_name = google_kms_crypto_key.cmek["gke"].id
  }

  binary_authorization {
    evaluation_mode = "PROJECT_SINGLETON_POLICY_ENFORCE"
  }

  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  depends_on = [google_project_service.this, google_kms_crypto_key_iam_member.cmek]
}

# Nodes log, report metrics and pull our images; nothing else.
resource "google_service_account" "nodes" {
  account_id   = "gke-nodes"
  display_name = "GKE nodes (studio cluster)"
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/autoscaling.metricsWriter",
  ])
  project = var.project
  role    = each.key
  member  = "serviceAccount:${google_service_account.nodes.email}"
}
