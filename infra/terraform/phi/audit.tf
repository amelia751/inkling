# Data Access logs on for every service, and every audit log copied to the audit bucket
# (retention-locked once var.audit_retention_locked is set). Access Transparency is an
# organization setting (console), not managed here.
resource "google_project_iam_audit_config" "all" {
  project = var.project
  service = "allServices"
  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_logging_project_sink" "audit" {
  name                   = "audit-to-bucket"
  destination            = "storage.googleapis.com/${google_storage_bucket.this["audit-logs"].name}"
  filter                 = "logName:\"cloudaudit.googleapis.com\""
  unique_writer_identity = true
}

resource "google_storage_bucket_iam_member" "audit_writer" {
  bucket = google_storage_bucket.this["audit-logs"].name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.audit.writer_identity
}
