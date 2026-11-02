# One VPC. Google APIs resolve to restricted.googleapis.com (the VPC Service Controls VIP), so
# pods reach only services the perimeter allows. Cloud SQL and Memorystore sit on private
# services access (var.network.psa). Cloud NAT exists for the web pods' proxy to the agent in
# spurby-ai and, once sign-in is on (todo9), api calls to api.workos.com;
# NetworkPolicies (infra/k8s/overlays/gke/phi) keep every other pod off it.
resource "google_compute_network" "studio" {
  name                    = "studio"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.this]
}

resource "google_compute_subnetwork" "gke" {
  name                     = "gke"
  network                  = google_compute_network.studio.id
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
  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
  }
}

resource "google_compute_global_address" "psa" {
  name          = "private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  network       = google_compute_network.studio.id
  address       = split("/", var.network.psa)[0]
  prefix_length = tonumber(split("/", var.network.psa)[1])
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.studio.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}

# restricted.googleapis.com: 199.36.153.4/30.
resource "google_compute_route" "restricted_apis" {
  name             = "restricted-google-apis"
  network          = google_compute_network.studio.id
  dest_range       = "199.36.153.4/30"
  next_hop_gateway = "default-internet-gateway"
}

resource "google_dns_managed_zone" "restricted" {
  for_each   = toset(["googleapis.com", "gcr.io", "pkg.dev"])
  name       = replace(each.key, ".", "-")
  dns_name   = "${each.key}."
  visibility = "private"
  private_visibility_config {
    networks {
      network_url = google_compute_network.studio.id
    }
  }
}

resource "google_dns_record_set" "restricted_a" {
  for_each     = google_dns_managed_zone.restricted
  managed_zone = each.value.name
  name         = each.key == "googleapis.com" ? "restricted.googleapis.com." : each.value.dns_name
  type         = "A"
  ttl          = 300
  rrdatas      = ["199.36.153.4", "199.36.153.5", "199.36.153.6", "199.36.153.7"]
}

resource "google_dns_record_set" "restricted_cname" {
  for_each     = google_dns_managed_zone.restricted
  managed_zone = each.value.name
  name         = "*.${each.value.dns_name}"
  type         = "CNAME"
  ttl          = 300
  rrdatas      = [each.key == "googleapis.com" ? "restricted.googleapis.com." : each.value.dns_name]
}

resource "google_compute_router" "nat" {
  name    = "nat"
  network = google_compute_network.studio.id
  region  = var.region
}

# A fixed egress address, so spurby-ai's ingress can admit only this project's web proxy.
resource "google_compute_address" "nat" {
  name       = "nat-egress"
  region     = var.region
  depends_on = [google_project_service.this]
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

# Public address of the Studio's ingress (ingress-nginx's LoadBalancer Service uses it).
resource "google_compute_address" "ingress" {
  name       = "studio-ingress"
  region     = var.region
  depends_on = [google_project_service.this]
}
