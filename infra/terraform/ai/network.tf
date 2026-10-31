# The agent needs internet egress (Daytona during the D9 trial, spurby-phi's API), so Cloud NAT
# with a fixed address: spurby-phi's agent ingress admits only this address. Build sandboxes get
# no egress at all (NetworkPolicy in infra/k8s/overlays/gke/ai/sandboxes).
resource "google_compute_network" "agent" {
  name                    = "agent"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.this]
}

resource "google_compute_subnetwork" "gke" {
  name                     = "gke"
  network                  = google_compute_network.agent.id
  region                   = var.region
  ip_cidr_range            = var.network.nodes
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.network.pods
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.network.services
  }
}

resource "google_compute_global_address" "psa" {
  name          = "private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  network       = google_compute_network.agent.id
  address       = split("/", var.network.psa)[0]
  prefix_length = tonumber(split("/", var.network.psa)[1])
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.agent.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}

resource "google_compute_router" "nat" {
  name    = "nat"
  network = google_compute_network.agent.id
  region  = var.region
}

resource "google_compute_address" "nat" {
  name   = "nat-egress"
  region = var.region
}

resource "google_compute_router_nat" "nat" {
  name                               = "nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  log_config {
    enable = true
    filter = "ALL"
  }
}

# Public address of the agent's ingress (web in spurby-phi proxies /api/agent here).
resource "google_compute_address" "ingress" {
  name   = "agent-ingress"
  region = var.region
}
