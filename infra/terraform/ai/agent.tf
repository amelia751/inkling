# The agent's own state (sessions, transcripts, run records: no customer data) and run-event
# bus, its Google identity and its secrets.
resource "google_sql_database_instance" "agent" {
  name                = "agent"
  database_version    = "POSTGRES_17"
  region              = var.region
  deletion_protection = true

  settings {
    tier                        = var.sql_tier
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    deletion_protection_enabled = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.agent.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.psa]
}

resource "google_sql_database" "agent" {
  name     = "agent"
  instance = google_sql_database_instance.agent.name
}

resource "google_redis_instance" "agent" {
  name                    = "agent"
  tier                    = "BASIC"
  memory_size_gb          = 1
  region                  = var.region
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.agent.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  reserved_ip_range       = google_compute_global_address.psa.name
  auth_enabled            = true
  transit_encryption_mode = var.redis_transit_encryption
  depends_on              = [google_service_networking_connection.psa]
}

resource "google_service_account" "app" {
  for_each = {
    agent            = "apps/agent: Vertex AI model calls"
    external-secrets = "External Secrets Operator: reads agent-secrets"
  }
  account_id   = each.key == "agent" ? "studio-agent" : each.key
  display_name = each.value
  depends_on   = [google_project_service.this]
}

resource "google_service_account_iam_member" "workload_identity" {
  for_each           = google_service_account.app
  service_account_id = each.value.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.wi[each.key]
  depends_on         = [google_container_cluster.agent]
}

# D8: model calls through Vertex AI (GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION, ADC from
# Workload Identity; apps/agent/src/config.ts). No other Google role.
resource "google_project_iam_member" "agent_vertex" {
  project = var.project
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.app["agent"].email}"
}

# agent-secrets as one JSON object (keys: infra/k8s/README.md). With D8 done it holds no model
# key; DAYTONA_API_KEY stays only while Daytona is the sandbox provider.
resource "google_secret_manager_secret" "agent" {
  secret_id = "agent-secrets"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_iam_member" "eso" {
  secret_id = google_secret_manager_secret.agent.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app["external-secrets"].email}"
}
