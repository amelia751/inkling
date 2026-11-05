# The agent on Cloud Run (todo22 W6, D6). One instance at most: run events go over the in-memory
# bus, so a second instance needs a shared bus first. State in Cloud SQL `agent` (agent.tf), the
# model on Vertex AI as the existing studio-agent identity (agent.tf, roles/aiplatform.user).
#
# The agent reaches spurby-phi only through the Studio host, as `service:agent` with its kernel
# service token (and the person's WorkOS token on the calls it makes for them): no fixed NAT
# address, no IP allow-list, no cross-project IAM (the organization policy blocks it). web in
# spurby-phi reaches the agent at its run.app URL with STUDIO_AGENT_TOKEN, so invoker IAM is off
# and the agent checks that token itself. Env never sets dev auth or the file store
# (tools/check-deploy-auth.mjs). .agents/skills/data-boundary/deployment-gcp.md, "Cloud Run stage".

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

locals {
  agent_image = var.agent_image != "" ? var.agent_image : "${var.region}-docker.pkg.dev/${var.project}/images/studio-agent:${var.agent_image_tag}"
  # Each value is its own secret (Cloud Run mounts a whole version per env var). Created empty;
  # a person adds versions, so no value is in state.
  run_secrets = toset(concat([
    "run-agent-token",                # same value as spurby-phi's run-web-agent-token
    "run-agent-approval-secret",      # same value as the api's STUDIO_API_APPROVAL_SECRET
    "run-agent-kernel-service-token", # same value as the api's STUDIO_API_AGENT_SERVICE_TOKEN
    "run-agent-database-url",         # postgres://agent:…@<sql_private_ip>/agent?sslmode=require
  ], var.agent_sandbox == "daytona" ? ["run-daytona-api-key"] : [], local.muse ? ["run-agent-muse-api-key"] : []))
  muse = startswith(var.agent_model, "muse:")
  # todo27 W4 (D4, D5): tracing on, exported to Cloud Trace in this project as studio-agent;
  # parent-based, so a sampled run is sampled whole and its trace id rides into spurby-phi.
  otel_env = {
    OTEL_TRACES_EXPORTER    = "gcp"
    OTEL_TRACES_SAMPLER     = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG = tostring(var.trace_sample_ratio)
  }
}

# Spans to Cloud Trace (todo27 W4). Write-only.
resource "google_project_iam_member" "agent_cloudtrace" {
  project = var.project
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.app["agent"].email}"
}

resource "google_secret_manager_secret" "run" {
  for_each  = local.run_secrets
  secret_id = each.key
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_iam_member" "run" {
  for_each  = google_secret_manager_secret.run
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app["agent"].email}"
}

resource "google_cloud_run_v2_service" "agent" {
  name                 = "agent"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true

  template {
    service_account = google_service_account.app["agent"].email
    # Run streams are SSE: the longest request Cloud Run allows.
    timeout                          = "3600s"
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = var.agent_min_instances
      max_instance_count = 1
    }
    # Cloud SQL's private IP through the VPC; everything else (the Studio host, Vertex AI,
    # Daytona) leaves directly.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.agent.id
        subnetwork = google_compute_subnetwork.gke.id
      }
    }
    containers {
      image = local.agent_image
      # todo27 W4: traces to Cloud Trace (local.otel_env); spans carry no content (D3).
      dynamic "env" {
        for_each = merge(local.otel_env, { OTEL_SERVICE_NAME = "studio-agent" })
        content {
          name  = env.key
          value = env.value
        }
      }
      ports {
        container_port = 8100
      }
      # Runs keep working between a person's requests: CPU stays allocated.
      resources {
        cpu_idle = false
        limits   = { cpu = "2", memory = "2Gi" }
      }

      env {
        name  = "STUDIO_ENV"
        value = "production"
      }
      env {
        name  = "STUDIO_AGENT_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "STUDIO_AGENT_PORT"
        value = "8100"
      }
      env {
        name  = "STUDIO_LOG_LEVEL"
        value = "info"
      }
      # Sign-in (todo9 Phase 5, todo22 D1): the person's WorkOS access token on proxied calls.
      env {
        name  = "STUDIO_AGENT_AUTH_MODE"
        value = "workos"
      }
      env {
        name  = "STUDIO_AGENT_WORKOS_CLIENT_ID"
        value = var.workos_client_id
      }
      dynamic "env" {
        for_each = var.workos_issuer == "" ? [] : [var.workos_issuer]
        content {
          name  = "STUDIO_AGENT_WORKOS_ISSUER"
          value = env.value
        }
      }
      env {
        name = "STUDIO_AGENT_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-agent-token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_AGENT_APPROVAL_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-agent-approval-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_AGENT_KERNEL_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-agent-kernel-service-token"].secret_id
            version = "latest"
          }
        }
      }
      # Stores (D6): Postgres, in-memory run-event bus (max one instance).
      env {
        name  = "STUDIO_AGENT_STORE"
        value = "postgres"
      }
      env {
        name = "STUDIO_AGENT_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-agent-database-url"].secret_id
            version = "latest"
          }
        }
      }
      # One instance, no migrate Job on Cloud Run yet: the schema is applied at startup.
      env {
        name  = "STUDIO_AGENT_AUTO_MIGRATE"
        value = "true"
      }
      env {
        name  = "STUDIO_AGENT_EVENT_BUS"
        value = "memory"
      }
      env {
        name  = "STUDIO_AGENT_DATA_DIR"
        value = "/tmp/agent"
      }
      # Cloud Run allows 10 s after SIGTERM.
      env {
        name  = "STUDIO_AGENT_SHUTDOWN_GRACE_S"
        value = "8"
      }
      # The api's agent routes, through the Studio host (its token decides what it may call).
      env {
        name  = "STUDIO_API_URL"
        value = var.studio_url
      }
      env {
        name  = "STUDIO_WEB_URL"
        value = var.studio_url
      }
      env {
        name  = "STUDIO_AGENT_MODEL"
        value = var.agent_model
      }
      dynamic "env" {
        for_each = local.muse ? ["run-agent-muse-api-key"] : []
        content {
          name = "STUDIO_AGENT_MUSE_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.run[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.display_name == "" ? [] : [var.display_name]
        content {
          name  = "STUDIO_DISPLAY_NAME"
          value = env.value
        }
      }
      env {
        name  = "STUDIO_AGENT_MODEL_ALLOWLIST"
        value = var.agent_model_allowlist
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project
      }
      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }
      env {
        name  = "STUDIO_AGENT_SANDBOX"
        value = var.agent_sandbox
      }
      # The in-process sweeper: no CronJob on Cloud Run, and only one instance.
      env {
        name  = "STUDIO_AGENT_SWEEPER_ENABLED"
        value = "true"
      }
      dynamic "env" {
        for_each = var.agent_sandbox == "daytona" ? ["run-daytona-api-key"] : []
        content {
          name = "DAYTONA_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.run[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }

  # deploy.yml rolls the image; Terraform sets it only when it creates the service.
  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_project_service.run, google_secret_manager_secret_iam_member.run]
}
