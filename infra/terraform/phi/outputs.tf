# Values the gke overlay needs (infra/k8s/overlays/gke/phi): none of them secret.
output "buckets" {
  value = { for k, b in google_storage_bucket.this : k => b.name }
}

output "plugin_signing_key" {
  description = "Signer gcpkms key version (STUDIO_API_SIGNER_KMS_KEY)."
  value       = "${google_kms_crypto_key.plugin_signing.id}/cryptoKeyVersions/1"
}

output "sql_private_ip" {
  value = google_sql_database_instance.studio.private_ip_address
}

output "sql_connection_name" {
  value = google_sql_database_instance.studio.connection_name
}

output "redis_host" {
  value = one([for r in google_redis_instance.studio : "${r.host}:${r.port}"])
}

output "redis_ca" {
  description = "PEM of the Memorystore server CA (ConfigMap redis-ca in the overlay)."
  value       = one([for r in google_redis_instance.studio : join("", [for c in r.server_ca_certs : c.cert])])
}

output "data_services_cidr" {
  value = var.network.psa
}

output "nat_egress_ip" {
  description = "spurby-ai admits the web proxy from this address only."
  value       = one(google_compute_address.nat[*].address)
}

output "ingress_ip" {
  value = one(google_compute_address.ingress[*].address)
}

output "images_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project}/images"
}

output "service_accounts" {
  description = "Workload Identity annotations (iam.gke.io/gcp-service-account) per Kubernetes service account."
  value       = { for k, s in google_service_account.app : k => s.email }
}

output "cluster" {
  value = one([for c in google_container_cluster.studio : { name = c.name, location = c.location }])
}

output "healthcare_dataset" {
  value = google_healthcare_dataset.studio.id
}

output "ci_workload_identity_provider" {
  description = "For google-github-actions/auth `workload_identity_provider` (empty until the github_* variables are set)."
  value       = local.ci_enabled ? google_iam_workload_identity_pool_provider.github[0].name : ""
}

output "ci_service_account" {
  description = "For google-github-actions/auth `service_account`: pushes to `images` only."
  value       = local.ci_enabled ? google_service_account.ci_images[0].email : ""
}

output "pipeline_connector_subscription" {
  description = "Milestone 3: the pull subscription apps/pipeline consumes (empty while pipeline_connectors_enabled=false)."
  value       = var.pipeline_connectors_enabled ? google_pubsub_subscription.connector_objects[0].id : ""
}
