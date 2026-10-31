output "folders" {
  value = { for k, f in google_folder.this : k => f.name }
}

output "access_policy" {
  value = google_access_context_manager_access_policy.org.name
}

output "perimeter_mode" {
  value = var.perimeter_enforced ? "enforced" : "dry-run"
}
