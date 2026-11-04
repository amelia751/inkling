# The public site (apps/site) on the Studio's load balancer: <site_host> serves it and
# www.<site_host> redirects there. It has its own managed certificate, so adding or changing the
# site never reissues the Studio's. Static pages only: no secrets, no VPC, no Google API access.
# Off while site_host is empty.

locals {
  site = var.site_host != ""
}

resource "google_cloud_run_v2_service" "site" {
  count                = local.site ? 1 : 0
  name                 = "site"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true

  template {
    service_account = local.run_sa.site
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = local.run_image.site
      ports {
        container_port = 8080
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      dynamic "env" {
        for_each = var.display_name == "" ? [] : [var.display_name]
        content {
          name  = "STUDIO_DISPLAY_NAME"
          value = env.value
        }
      }
      env {
        name  = "STUDIO_SITE_APP_URL"
        value = local.studio_url
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

  depends_on = [google_project_service.run]
}

resource "google_compute_region_network_endpoint_group" "site" {
  count                 = local.site ? 1 : 0
  name                  = "run-site"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.site[0].name
  }
}

resource "google_compute_backend_service" "site" {
  count                 = local.site ? 1 : 0
  name                  = "run-site"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend {
    group = google_compute_region_network_endpoint_group.site[0].id
  }
  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_managed_ssl_certificate" "site" {
  count = local.site ? 1 : 0
  name  = "site"
  managed {
    domains = [var.site_host, "www.${var.site_host}"]
  }
}
