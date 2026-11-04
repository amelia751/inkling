# The Cloud Run stage (todo22 W6, D6): web, api, versioning and pipeline as services, the worker
# as a worker pool, one HTTPS load balancer for the Studio host. Signed in with WorkOS only: the
# env below never sets dev auth, trusted headers, a SQLite URL or a local blob store
# (tools/check-deploy-auth.mjs reads these blocks). docs/deployment-gcp.md, "Cloud Run stage".
#
# Network: every service uses Direct VPC egress on the existing subnet, so Cloud SQL's private
# IP is reachable and calls to another service's run.app URL count as internal (Private Google
# Access is on for the subnet). Ingress: web and api take traffic from the load balancer and the
# VPC only; versioning and pipeline from the VPC only. Invoker IAM is off on every service:
# each app checks its own tokens (WorkOS sessions, the worker, pipeline and agent tokens, the
# api-signed JWTs), and the organization policy blocks granting run.invoker across projects.
#
# Stores (D6): Cloud SQL `studio` (job queue and event bus in SQL, no Redis), Cloud Storage for
# blobs, Secret Manager for every secret (run-secrets.tf).

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

locals {
  registry = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.this["images"].repository_id}"
  run_image = { for s in ["web", "api", "versioning", "pipeline", "worker"] :
    s => lookup(var.images, s, "${local.registry}/studio-${s}:${var.image_tag}")
  }
  # Deterministic run.app URLs, so services can name each other without a dependency cycle.
  run_url    = { for s in ["web", "api", "versioning", "pipeline"] : s => "https://${s}-${local.number}.${var.region}.run.app" }
  studio_url = "https://${var.studio_host}"

  # Google identities. api and versioning are the iam.tf ones; web, worker and pipeline (until
  # its connector identity exists, Milestone 3) get one here with no project role at all.
  run_sa = {
    api        = google_service_account.app["api"].email
    versioning = google_service_account.app["versioning"].email
    pipeline   = var.pipeline_connectors_enabled ? google_service_account.app["pipeline"].email : google_service_account.run["pipeline"].email
    web        = google_service_account.run["web"].email
    worker     = google_service_account.run["worker"].email
  }
  run_vpc_tag = { for s in ["web", "api", "versioning", "pipeline", "worker"] : s => "run-${s}" }
}

resource "google_service_account" "run" {
  for_each = merge({
    web    = "apps/web on Cloud Run: no Google API access"
    worker = "apps/worker on Cloud Run: plugin code; reaches only the api, no Google API access"
    }, var.pipeline_connectors_enabled ? {} : {
    pipeline = "apps/pipeline on Cloud Run (until Milestone 3's identity in iam.tf)"
  })
  account_id   = "studio-${each.key}"
  display_name = each.value
  depends_on   = [google_project_service.this]
}

# ---- Services ---------------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "web" {
  name                 = "web"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true

  template {
    service_account = local.run_sa.web
    # Agent run streams are SSE through web's nginx: the longest request Cloud Run allows.
    timeout = "3600s"
    scaling {
      min_instance_count = var.run_scaling["web"].min
      max_instance_count = var.run_scaling["web"].max
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.studio.id
        subnetwork = google_compute_subnetwork.gke.id
        tags       = [local.run_vpc_tag.web]
      }
    }
    containers {
      image = local.run_image.web
      ports {
        container_port = 8080
      }
      # The image is built with STUDIO_WEB_AUTH_MODE=workos (docs/deployment-gcp.md); nginx reads
      # the same key at start for /config.json's `auth` and the agent proxy's identity headers.
      env {
        name  = "STUDIO_WEB_AUTH_MODE"
        value = "workos"
      }
      dynamic "env" {
        for_each = var.display_name == "" ? [] : [var.display_name]
        content {
          name  = "STUDIO_DISPLAY_NAME"
          value = env.value
        }
      }
      # /_auth asks the api (internal URL) for the person's access token.
      env {
        name  = "STUDIO_API_URL"
        value = local.run_url.api
      }
      env {
        name  = "STUDIO_AGENT_URL"
        value = var.agent_url
      }
      env {
        name = "STUDIO_AGENT_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-web-agent-token"].secret_id
            version = "latest"
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

resource "google_cloud_run_v2_service" "api" {
  name                 = "api"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true

  template {
    service_account = local.run_sa.api
    timeout         = "3600s"
    scaling {
      min_instance_count = var.run_scaling["api"].min
      max_instance_count = var.run_scaling["api"].max
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.studio.id
        subnetwork = google_compute_subnetwork.gke.id
        tags       = [local.run_vpc_tag.api]
      }
    }
    volumes {
      name = "versioning-jwt"
      secret {
        secret = google_secret_manager_secret.run["run-api-versioning-jwt-key"].secret_id
        items {
          version = "latest"
          path    = "jwt.key"
        }
      }
    }
    containers {
      image = local.run_image.api
      ports {
        container_port = 8000
      }
      resources {
        limits = { cpu = "2", memory = "2Gi" }
      }
      volume_mounts {
        name       = "versioning-jwt"
        mount_path = "/etc/api/versioning"
      }

      env {
        name  = "STUDIO_ENV"
        value = "production"
      }
      env {
        name  = "STUDIO_API_CREATE_TABLES"
        value = "0"
      }
      # todo24 D1: the stage's feature flags (var.features); unset flags keep the production default.
      dynamic "env" {
        for_each = var.features
        content {
          name  = "STUDIO_API_FEATURE_${upper(env.key)}"
          value = env.value ? "1" : "0"
        }
      }
      # Sign-in (todo9, todo22 D1): WorkOS only.
      env {
        name  = "STUDIO_API_AUTH_MODE"
        value = "workos"
      }
      env {
        name  = "STUDIO_API_DEV_TRUST_HEADERS"
        value = "0"
      }
      env {
        name  = "STUDIO_API_PUBLIC_URL"
        value = local.studio_url
      }
      env {
        name  = "STUDIO_API_WORKOS_REDIRECT_URI"
        value = "${local.studio_url}/api/auth/callback"
      }
      env {
        name  = "STUDIO_API_WORKOS_CLIENT_ID"
        value = var.workos_client_id
      }
      dynamic "env" {
        for_each = var.workos_issuer == "" ? [] : [var.workos_issuer]
        content {
          name  = "STUDIO_API_WORKOS_ISSUER"
          value = env.value
        }
      }
      env {
        name = "STUDIO_API_WORKOS_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-api-workos-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_API_WORKOS_COOKIE_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-api-workos-cookie-password"].secret_id
            version = "latest"
          }
        }
      }
      # Stores (D6): Cloud SQL `studio` (postgresql+psycopg://…, sslmode=require), queue and bus
      # in SQL, blobs in Cloud Storage with the service's own identity.
      env {
        name = "STUDIO_API_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-api-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "STUDIO_JOB_QUEUE"
        value = "sql"
      }
      env {
        name  = "STUDIO_EVENT_BUS"
        value = "sql"
      }
      env {
        name  = "STUDIO_BLOB_STORE"
        value = "gcs"
      }
      env {
        name  = "STUDIO_GCS_BUCKET"
        value = google_storage_bucket.this["objects"].name
      }
      env {
        name  = "STUDIO_API_ARTIFACTS_BUCKET"
        value = google_storage_bucket.this["artifacts"].name
      }
      env {
        name  = "STUDIO_API_SAMPLES_PREFIX"
        value = "samples"
      }
      env {
        name = "STUDIO_API_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-api-secret-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_API_APPROVAL_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-api-approval-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_API_WORKER_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-worker-token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_API_PIPELINE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-pipeline-token"].secret_id
            version = "latest"
          }
        }
      }
      # The agent's service calls (principal service:agent) arrive over the Studio host with
      # this token; the person's own calls carry their WorkOS access token.
      env {
        name = "STUDIO_API_AGENT_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-api-agent-service-token"].secret_id
            version = "latest"
          }
        }
      }
      # Plugin signing in Cloud KMS (output plugin_signing_key).
      env {
        name  = "STUDIO_API_SIGNER"
        value = "gcpkms"
      }
      env {
        name  = "STUDIO_API_SIGNER_KMS_KEY"
        value = "${google_kms_crypto_key.plugin_signing.id}/cryptoKeyVersions/1"
      }
      env {
        name  = "STUDIO_API_NAME_SCREEN_MODE"
        value = "dlp"
      }
      env {
        name  = "STUDIO_API_NAME_SCREEN_PROJECT"
        value = var.project
      }
      env {
        name  = "STUDIO_API_NAME_SCREEN_LOCATION"
        value = var.region
      }
      env {
        name  = "STUDIO_API_VERSIONING_URL"
        value = local.run_url.versioning
      }
      env {
        name  = "STUDIO_API_VERSIONING_JWT_KEY_FILE"
        value = "/etc/api/versioning/jwt.key"
      }
      env {
        name  = "STUDIO_API_VERSIONING_JWKS_FILE"
        value = "/tmp/versioning-jwks.json"
      }
      env {
        name  = "STUDIO_API_VERSIONING_JWT_KID"
        value = "api"
      }
      env {
        name  = "STUDIO_API_PIPELINE_URL"
        value = local.run_url.pipeline
      }
      env {
        name  = "STUDIO_API_PIPELINE_JWT_KID"
        value = "api"
      }
      startup_probe {
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 24
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

resource "google_cloud_run_v2_service" "versioning" {
  name                 = "versioning"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true

  template {
    service_account = local.run_sa.versioning
    scaling {
      min_instance_count = var.run_scaling["versioning"].min
      max_instance_count = var.run_scaling["versioning"].max
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.studio.id
        subnetwork = google_compute_subnetwork.gke.id
        tags       = [local.run_vpc_tag.versioning]
      }
    }
    volumes {
      name = "jwks"
      secret {
        secret = google_secret_manager_secret.run["run-versioning-jwks"].secret_id
        items {
          version = "latest"
          path    = "jwks.json"
        }
      }
    }
    containers {
      image = local.run_image.versioning
      ports {
        container_port = 8090
      }
      volume_mounts {
        name       = "jwks"
        mount_path = "/etc/versioning/jwks"
      }
      env {
        name  = "STUDIO_VERSIONING_HTTP_ADDR"
        value = ":8090"
      }
      env {
        name = "STUDIO_VERSIONING_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-versioning-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "STUDIO_VERSIONING_OBJECT_STORE"
        value = "gcs"
      }
      env {
        name  = "STUDIO_VERSIONING_OBJECT_ENDPOINT"
        value = ""
      }
      env {
        name  = "STUDIO_VERSIONING_OBJECT_BUCKET"
        value = google_storage_bucket.this["versioning-objects"].name
      }
      env {
        name  = "STUDIO_VERSIONING_MANIFEST_BUCKET"
        value = google_storage_bucket.this["versioning-manifests"].name
      }
      env {
        name  = "STUDIO_VERSIONING_JWT_PUBLIC_KEY_FILE"
        value = "/etc/versioning/jwks/jwks.json"
      }
      env {
        name  = "STUDIO_VERSIONING_JWT_AUDIENCE"
        value = "versioning"
      }
      env {
        name  = "STUDIO_VERSIONING_JWT_ISSUER"
        value = "api"
      }
      # No Redis in this stage (D6): events go to the log.
      env {
        name  = "STUDIO_VERSIONING_EVENT_BUS"
        value = "log"
      }
      env {
        name  = "STUDIO_VERSIONING_GC_SWEEP_ENABLED"
        value = "false"
      }
      env {
        name  = "STUDIO_VERSIONING_PURGE_ENABLED"
        value = "false"
      }
      env {
        name  = "STUDIO_VERSIONING_TEMP_DIR"
        value = "/tmp"
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

resource "google_cloud_run_v2_service" "pipeline" {
  name                 = "pipeline"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true

  template {
    service_account = local.run_sa.pipeline
    scaling {
      min_instance_count = var.run_scaling["pipeline"].min
      max_instance_count = var.run_scaling["pipeline"].max
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.studio.id
        subnetwork = google_compute_subnetwork.gke.id
        tags       = [local.run_vpc_tag.pipeline]
      }
    }
    volumes {
      name = "versioning-jwt"
      secret {
        secret = google_secret_manager_secret.run["run-pipeline-versioning-jwt-key"].secret_id
        items {
          version = "latest"
          path    = "jwt.key"
        }
      }
    }
    volumes {
      name = "api-jwks"
      secret {
        secret = google_secret_manager_secret.run["run-api-jwks"].secret_id
        items {
          version = "latest"
          path    = "jwks.json"
        }
      }
    }
    containers {
      image = local.run_image.pipeline
      ports {
        container_port = 8095
      }
      # DBOS workflows run between requests: CPU stays allocated.
      resources {
        cpu_idle = false
      }
      volume_mounts {
        name       = "versioning-jwt"
        mount_path = "/etc/pipeline/versioning"
      }
      volume_mounts {
        name       = "api-jwks"
        mount_path = "/etc/pipeline/api-jwks"
      }
      env {
        name  = "STUDIO_ENV"
        value = "production"
      }
      env {
        name  = "STUDIO_PIPELINE_PORT"
        value = "8095"
      }
      env {
        name  = "STUDIO_PIPELINE_DB_POOL_MAX"
        value = "4"
      }
      env {
        name = "STUDIO_PIPELINE_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-pipeline-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_PIPELINE_ENGINE_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-pipeline-engine-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "STUDIO_PIPELINE_API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-pipeline-token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "STUDIO_PIPELINE_API_URL"
        value = local.run_url.api
      }
      env {
        name  = "STUDIO_PIPELINE_VERSIONING_URL"
        value = local.run_url.versioning
      }
      env {
        name  = "STUDIO_PIPELINE_VERSIONING_JWT_KID"
        value = "pipeline"
      }
      env {
        name  = "STUDIO_PIPELINE_VERSIONING_JWT_KEY_FILE"
        value = "/etc/pipeline/versioning/jwt.key"
      }
      env {
        name  = "STUDIO_PIPELINE_API_JWKS_FILE"
        value = "/etc/pipeline/api-jwks/jwks.json"
      }
      env {
        name  = "STUDIO_PIPELINE_RUN_DEADLINE"
        value = "24h"
      }
      env {
        name  = "STUDIO_PIPELINE_DRAIN_DEADLINE"
        value = "72h"
      }
      env {
        name  = "STUDIO_PIPELINE_ENGINE_RETENTION"
        value = "720h"
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

# ---- Worker: plugin code ----------------------------------------------------------------------
# The worker takes no requests: it claims jobs from the api. It would be a worker pool
# (google_cloud_run_v2_worker_pool), but that resource can't pick the execution environment in
# this provider version, and plugin code must run in Cloud Run's first-generation environment
# (gVisor, the counterpart of GKE Sandbox). So it is a service: a fixed instance count, CPU
# always allocated, ingress from the VPC only (its port answers only the health probes). Switch
# to a worker pool once it takes `execution_environment`.
#
# Egress goes through the VPC, where the firewall below admits only the Studio load balancer's
# address (the api's routes, worker token): no Google APIs, no internet, no Cloud SQL. Until the
# perimeter is enforced (todo10 A9) the stage holds synthetic data only.
resource "google_cloud_run_v2_service" "worker" {
  name                 = "worker"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true

  scaling {
    min_instance_count = var.run_scaling["worker"].min
  }

  template {
    service_account       = local.run_sa.worker
    execution_environment = "EXECUTION_ENVIRONMENT_GEN1"
    scaling {
      min_instance_count = var.run_scaling["worker"].min
      max_instance_count = var.run_scaling["worker"].max
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.studio.id
        subnetwork = google_compute_subnetwork.gke.id
        tags       = [local.run_vpc_tag.worker]
      }
    }
    containers {
      image = local.run_image.worker
      ports {
        container_port = 8081
      }
      resources {
        cpu_idle = false
        limits   = { cpu = "2", memory = var.worker_memory }
      }
      # The api's routes through the Studio host (the only address the firewall admits).
      env {
        name  = "STUDIO_API_URL"
        value = local.studio_url
      }
      env {
        name = "STUDIO_API_WORKER_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.run["run-worker-token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "STUDIO_WORKER_DATA_DIR"
        value = "/tmp/worker"
      }
      env {
        name  = "STUDIO_WORKER_ENVS_DIR"
        value = "/app/.plugin-envs"
      }
      env {
        name  = "STUDIO_WORKER_BUILD_ENVS"
        value = "0"
      }
      env {
        name  = "STUDIO_WORKER_SHUTDOWN_GRACE_S"
        value = "8"
      }
      env {
        name  = "STUDIO_WORKER_RESOURCE_CLASSES"
        value = "cpu,memory"
      }
      # Archive unpack limits (todo13 §7.1). /tmp is memory here: the scratch budget is half
      # the instance's memory at the 8 GiB default.
      env {
        name  = "STUDIO_WORKER_UNPACK_MAX_BYTES"
        value = "21474836480"
      }
      env {
        name  = "STUDIO_WORKER_UNPACK_MAX_FILES"
        value = "50000"
      }
      env {
        name  = "STUDIO_WORKER_UNPACK_MAX_RATIO"
        value = "100"
      }
      env {
        name  = "STUDIO_WORKER_UNPACK_MAX_DEPTH"
        value = "2"
      }
      env {
        name  = "STUDIO_WORKER_UNPACK_TMP_BYTES"
        value = "4294967296"
      }
      env {
        name  = "STUDIO_WORKER_HEALTH_PORT"
        value = "8081"
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

# The worker's VPC egress: the Studio load balancer's address on 443, nothing else (no Google
# APIs, no internet, no Cloud SQL).
resource "google_compute_firewall" "worker_egress_api" {
  name               = "run-worker-egress-api"
  network            = google_compute_network.studio.id
  direction          = "EGRESS"
  priority           = 900
  target_tags        = [local.run_vpc_tag.worker]
  destination_ranges = ["${google_compute_global_address.studio.address}/32"]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_firewall" "worker_egress_deny" {
  name               = "run-worker-egress-deny"
  network            = google_compute_network.studio.id
  direction          = "EGRESS"
  priority           = 1000
  target_tags        = [local.run_vpc_tag.worker]
  destination_ranges = ["0.0.0.0/0"]
  deny {
    protocol = "all"
  }
  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

# Internet egress for the services (the api calls api.workos.com; the worker reaches the load
# balancer). Addresses are Google-allocated: nothing allow-lists them.
resource "google_compute_router" "run" {
  count   = var.run_nat_enabled ? 1 : 0
  name    = "run-nat"
  network = google_compute_network.studio.id
  region  = var.region
}

resource "google_compute_router_nat" "run" {
  count                              = var.run_nat_enabled ? 1 : 0
  name                               = "run-nat"
  router                             = google_compute_router.run[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.gke.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# ---- HTTPS load balancer for the Studio host --------------------------------------------------
# Same routes as infra/k8s/base/ingress.yaml (longest path wins):
#   /api/auth/verify → web (answers 404: the api's verify endpoint is for web's nginx only)
#   /api/agent       → web (its nginx adds the agent token and proxies to the agent)
#   /api, /seed      → api            everything else → web
# The remote MCP server (/mcp) isn't on Cloud Run yet.

resource "google_compute_region_network_endpoint_group" "run" {
  for_each              = toset(["web", "api"])
  name                  = "run-${each.key}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = each.key == "web" ? google_cloud_run_v2_service.web.name : google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_backend_service" "run" {
  for_each              = google_compute_region_network_endpoint_group.run
  name                  = "run-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend {
    group = each.value.id
  }
  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_global_address" "studio" {
  name       = "studio"
  depends_on = [google_project_service.this]
}

resource "google_compute_managed_ssl_certificate" "studio" {
  name = "studio"
  managed {
    domains = [var.studio_host]
  }
}

resource "google_compute_url_map" "studio" {
  name            = "studio"
  default_service = google_compute_backend_service.run["web"].id

  host_rule {
    hosts        = [var.studio_host]
    path_matcher = "studio"
  }

  path_matcher {
    name            = "studio"
    default_service = google_compute_backend_service.run["web"].id
    path_rule {
      paths   = ["/api/auth/verify", "/api/agent", "/api/agent/*"]
      service = google_compute_backend_service.run["web"].id
    }
    path_rule {
      paths   = ["/api", "/api/*", "/seed", "/seed/*"]
      service = google_compute_backend_service.run["api"].id
    }
  }
}

resource "google_compute_target_https_proxy" "studio" {
  name             = "studio"
  url_map          = google_compute_url_map.studio.id
  ssl_certificates = [google_compute_managed_ssl_certificate.studio.id]
}

resource "google_compute_global_forwarding_rule" "studio_https" {
  name                  = "studio-https"
  target                = google_compute_target_https_proxy.studio.id
  ip_address            = google_compute_global_address.studio.address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Plain HTTP only redirects to HTTPS.
resource "google_compute_url_map" "studio_redirect" {
  name = "studio-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "studio_redirect" {
  name    = "studio-redirect"
  url_map = google_compute_url_map.studio_redirect.id
}

resource "google_compute_global_forwarding_rule" "studio_http" {
  name                  = "studio-http"
  target                = google_compute_target_http_proxy.studio_redirect.id
  ip_address            = google_compute_global_address.studio.address
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
