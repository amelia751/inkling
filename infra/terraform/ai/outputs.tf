output "nat_egress_ip" {
  description = "spurby-phi's agent ingress admits only this address (overlay gke/phi). Null while gke_enabled is false."
  value       = one(google_compute_address.nat[*].address)
}

output "ingress_ip" {
  value = one(google_compute_address.ingress[*].address)
}

output "sql_private_ip" {
  value = google_sql_database_instance.agent.private_ip_address
}

output "redis_host" {
  value = one([for r in google_redis_instance.agent : "${r.host}:${r.port}"])
}

output "redis_ca" {
  value = one([for r in google_redis_instance.agent : join("", [for c in r.server_ca_certs : c.cert])])
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
  value = one([for c in google_container_cluster.agent : { name = c.name, location = c.location }])
}
