# Schema migrations as Cloud Run jobs, the commands of infra/k8s/base/jobs/*-migrate.yaml.
# .github/workflows/deploy.yml points each at the new image and runs it before any service
# moves, so migrations must stay backwards compatible with the revision still serving.
locals {
  migrate_jobs = {
    api = {
      command     = ["alembic", "upgrade", "head"]
      working_dir = "/app/apps/api"
      secrets     = { STUDIO_API_DATABASE_URL = "run-api-database-url" }
    }
    versioning = {
      command     = ["/app/bin/migrate", "up"]
      working_dir = null
      secrets     = { STUDIO_VERSIONING_MIGRATE_DATABASE_URL = "run-versioning-migrate-database-url" }
    }
    pipeline = {
      command     = ["/app/bin/migrate", "up"]
      working_dir = null
      secrets = {
        STUDIO_PIPELINE_DATABASE_URL        = "run-pipeline-database-url"
        STUDIO_PIPELINE_ENGINE_DATABASE_URL = "run-pipeline-engine-database-url"
      }
    }
  }
}

resource "google_cloud_run_v2_job" "migrate" {
  for_each            = local.migrate_jobs
  name                = "${each.key}-migrate"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account = local.run_sa[each.key]
      max_retries     = 0
      timeout         = "900s"
      vpc_access {
        egress = "ALL_TRAFFIC"
        network_interfaces {
          network    = google_compute_network.studio.id
          subnetwork = google_compute_subnetwork.gke.id
          tags       = [local.run_vpc_tag[each.key]]
        }
      }
      containers {
        image       = local.run_image[each.key]
        command     = each.value.command
        working_dir = each.value.working_dir
        dynamic "env" {
          for_each = each.value.secrets
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.run[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_project_service.run, google_secret_manager_secret_iam_member.run]
}
