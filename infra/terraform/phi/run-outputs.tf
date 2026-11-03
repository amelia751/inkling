# Cloud Run stage (run.tf).
output "run_urls" {
  description = "run.app URL of each Cloud Run service (web and api are reached through the load balancer, versioning and pipeline only from the VPC)."
  value = {
    web        = google_cloud_run_v2_service.web.uri
    api        = google_cloud_run_v2_service.api.uri
    versioning = google_cloud_run_v2_service.versioning.uri
    pipeline   = google_cloud_run_v2_service.pipeline.uri
  }
}

output "studio_url" {
  description = "The Studio's public URL (the load balancer). The agent's STUDIO_API_URL / STUDIO_WEB_URL (infra/terraform/ai var studio_url)."
  value       = local.studio_url
}

output "studio_lb_ip" {
  description = "The load balancer's address: the DNS A record for var.studio_host."
  value       = google_compute_global_address.studio.address
}

output "workos_urls" {
  description = "Add to the WorkOS environment (staging for staging): redirect URI, sign-out URL, initiate login URL."
  value = {
    redirect_uri       = "${local.studio_url}/api/auth/callback"
    sign_out_url       = "${local.studio_url}/"
    initiate_login_uri = "${local.studio_url}/api/auth/login"
  }
}

output "run_secrets" {
  description = "Secret Manager secrets to add a version to before the first deploy (run-secrets.tf)."
  value       = sort(keys(google_secret_manager_secret.run))
}
