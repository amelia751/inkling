# Values the gke overlay needs (infra/k8s/overlays/gke/phi): none of them secret.
output "buckets" {
  value = { for k, b in google_storage_bucket.this : k => b.name }
}

output "plugin_signing_key" {
  description = "Signer gcpkms key version (INKLING_API_SIGNER_KMS_KEY)."
  value       = "${google_kms_crypto_key.plugin_signing.id}/cryptoKeyVersions/1"
}

output "sql_private_ip" {
  value = google_sql_database_instance.studio.private_ip_address
}

output "sql_connection_name" {
  value = google_sql_database_instance.studio.connection_name
}

output "redis_host" {
  value = "${google_redis_instance.studio.host}:${google_redis_instance.studio.port}"
}

output "redis_ca" {
  description = "PEM of the Memorystore server CA (ConfigMap redis-ca in the overlay)."
  value       = join("", [for c in google_redis_instance.studio.server_ca_certs : c.cert])
}

output "data_services_cidr" {
  value = var.network.psa
}

output "nat_egress_ip" {
  description = "spurby-ai admits the web proxy from this address only."
  value       = google_compute_address.nat.address
}

output "ingress_ip" {
  value = google_compute_address.ingress.address
}

output "images_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project}/images"
}

output "service_accounts" {
  description = "Workload Identity annotations (iam.gke.io/gcp-service-account) per Kubernetes service account."
  value       = { for k, s in google_service_account.app : k => s.email }
}

output "cluster" {
  value = { name = google_container_cluster.studio.name, location = google_container_cluster.studio.location }
}

output "healthcare_dataset" {
  value = google_healthcare_dataset.studio.id
}
