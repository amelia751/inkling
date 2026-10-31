output "nat_egress_ip" {
  description = "spurby-phi's agent ingress admits only this address (overlay gke/phi)."
  value       = google_compute_address.nat.address
}

output "ingress_ip" {
  value = google_compute_address.ingress.address
}

output "sql_private_ip" {
  value = google_sql_database_instance.agent.private_ip_address
}

output "redis_host" {
  value = "${google_redis_instance.agent.host}:${google_redis_instance.agent.port}"
}

output "redis_ca" {
  value = join("", [for c in google_redis_instance.agent.server_ca_certs : c.cert])
}

output "data_services_cidr" {
  value = var.network.psa
}

output "images_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project}/images"
}

output "service_accounts" {
  value = { for k, s in google_service_account.app : k => s.email }
}

output "cluster" {
  value = { name = google_container_cluster.agent.name, location = google_container_cluster.agent.location }
}
