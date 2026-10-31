# spurby-ai: the agent (apps/agent), its model calls (Vertex AI) and its build sandboxes
# (GKE Sandbox + kubernetes-sigs/agent-sandbox, todo10 D9). Never holds customer data; reaches
# spurby-phi only over HTTPS through the api's agent routes (docs/deployment-gcp.md). Outside the
# organization by choice, so none of the org policies apply: this stack sets the same defaults
# itself (private nodes, no keys, Workload Identity).
#
# The deploy identity needs a role on this project first (README.md).
terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  backend "gcs" {
    bucket = "spurby-phi-tfstate"
    prefix = "ai"
  }
}

provider "google" {
  project               = var.project
  region                = var.region
  billing_project       = var.project
  user_project_override = true
}

locals {
  wi = {
    agent            = "serviceAccount:${var.project}.svc.id.goog[studio/agent]"
    external-secrets = "serviceAccount:${var.project}.svc.id.goog[external-secrets/external-secrets]"
  }
}

resource "google_project_service" "this" {
  for_each = toset([
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}
