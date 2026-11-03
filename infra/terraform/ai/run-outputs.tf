output "agent_url" {
  description = "The agent's Cloud Run URL: spurby-phi's var agent_url (web's nginx proxies /api/agent/* there)."
  value       = google_cloud_run_v2_service.agent.uri
}

output "run_secrets" {
  description = "Secret Manager secrets to add a version to before the first deploy (run.tf)."
  value       = sort(keys(google_secret_manager_secret.run))
}
