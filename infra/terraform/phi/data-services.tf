# Cloud SQL for PostgreSQL 17 (api and versioning share database `studio`, as in the prod
# overlay) and Memorystore for Redis (job queue, event bus, KEDA's queue length). Private IP
# only, CMEK. Database roles and passwords are created out of band (README.md), so no password
# is ever in Terraform state.
resource "google_sql_database_instance" "studio" {
  name                = "studio"
  database_version    = "POSTGRES_17"
  region              = var.region
  encryption_key_name = google_kms_crypto_key.cmek["sql"].id
  deletion_protection = true

  settings {
    tier                        = var.sql_tier
    edition                     = "ENTERPRISE"
    availability_type           = var.sql_high_availability ? "REGIONAL" : "ZONAL"
    deletion_protection_enabled = true
    disk_autoresize             = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.studio.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 30
      }
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }

    maintenance_window {
      day  = 7
      hour = 4
    }
  }

  depends_on = [google_service_networking_connection.psa, google_kms_crypto_key_iam_member.cmek]
}

resource "google_sql_database" "studio" {
  name     = "studio"
  instance = google_sql_database_instance.studio.name
}

resource "google_redis_instance" "studio" {
  name                    = "studio"
  tier                    = "STANDARD_HA"
  memory_size_gb          = var.redis_memory_gb
  region                  = var.region
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.studio.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  reserved_ip_range       = google_compute_global_address.psa.name
  auth_enabled            = true
  transit_encryption_mode = var.redis_transit_encryption
  customer_managed_key    = google_kms_crypto_key.cmek["redis"].id

  depends_on = [google_service_networking_connection.psa, google_kms_crypto_key_iam_member.cmek]
}
