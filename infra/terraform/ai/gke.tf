# GKE Autopilot for the agent and its build sandboxes. Sandboxes are agent-sandbox `Sandbox`
# pods with `runtimeClassName: gvisor` (GKE Sandbox); Autopilot runs them on gVisor nodes, so
# no node pool is declared. Pre-warmed sandboxes come from a SandboxWarmPool (the overlay).
resource "google_container_cluster" "agent" {
  count               = var.gke_enabled ? 1 : 0
  name                = "agent"
  location            = var.region
  enable_autopilot    = true
  network             = google_compute_network.agent.id
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

  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_service_account" "nodes" {
  account_id   = "gke-nodes"
  display_name = "GKE nodes (agent cluster)"
  depends_on   = [google_project_service.this]
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

# studio-agent and the sandbox base image (pinned dependencies, no package downloads).
resource "google_artifact_registry_repository" "images" {
  repository_id = "images"
  location      = var.region
  format        = "DOCKER"
  description   = "Agent and build-sandbox images"
  docker_config {
    immutable_tags = true
  }
  depends_on = [google_project_service.this]
}

resource "google_artifact_registry_repository_iam_member" "nodes" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.nodes.email}"
}
