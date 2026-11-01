# spurby-phi: everything that touches customer data (docs/deployment-gcp.md). Inside the VPC
# Service Controls perimeter (infra/terraform/org/perimeter.tf). Plan/apply: README.md.
terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
  backend "gcs" {
    bucket = "spurby-phi-tfstate"
    prefix = "phi"
  }
}

provider "google" {
  project               = var.project
  region                = var.region
  billing_project       = var.project
  user_project_override = true
}

provider "google-beta" {
  project               = var.project
  region                = var.region
  billing_project       = var.project
  user_project_override = true
}

data "google_project" "this" {
  project_id = var.project
}

locals {
  number = data.google_project.this.number
  # Kubernetes namespace of the apps (infra/k8s/overlays/gke/phi).
  ns = "studio"
  # Workload Identity member for a Kubernetes service account in that namespace.
  wi = { for ksa in ["api", "versioning", "release", "external-secrets", "pipeline"] :
    ksa => "serviceAccount:${var.project}.svc.id.goog[${ksa == "external-secrets" ? "external-secrets" : local.ns}/${ksa}]"
  }
}

resource "google_project_service" "this" {
  for_each = toset(concat([
    "artifactregistry.googleapis.com",
    "binaryauthorization.googleapis.com",
    "cloudkms.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "dlp.googleapis.com",
    "dns.googleapis.com",
    "healthcare.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com", # GitHub OIDC token exchange (ci.tf)
    ],
    var.pipeline_connectors_enabled ? ["pubsub.googleapis.com"] : [],
    var.gpu_workers_enabled ? ["cloudquotas.googleapis.com"] : [],
  ))
  service            = each.key
  disable_on_destroy = false
}

# Google-managed service agents that use the CMEK keys. Created explicitly so the key grants in
# kms.tf don't race the first use of each API.
resource "google_project_service_identity" "agent" {
  provider = google-beta
  for_each = toset([
    "artifactregistry.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ])
  service    = each.key
  depends_on = [google_project_service.this]
}

data "google_storage_project_service_account" "gcs" {
  depends_on = [google_project_service.this]
}
