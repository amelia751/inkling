# spurby-data: data we curate (public datasets, seed data, synthetic e2e fixtures, demos) and
# de-identified releases from spurby-phi (docs/deployment-gcp.md). No customer data except what
# arrives through the release path. Normal controls; no CMEK requirement.
terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  backend "gcs" {
    bucket = "spurby-phi-tfstate"
    prefix = "data"
  }
}

provider "google" {
  project               = var.project
  region                = var.region
  billing_project       = var.project
  user_project_override = true
}

variable "project" {
  type    = string
  default = "spurby-data"
}

variable "phi_project" {
  type    = string
  default = "spurby-phi"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "public_read" {
  description = "Grant allUsers read on the public bucket. Needs an iam.allowedPolicyMemberDomains exception for this project first."
  type        = bool
  default     = false
}

locals {
  # Created by infra/terraform/phi (iam.tf).
  release_sa = "serviceAccount:studio-release@${var.phi_project}.iam.gserviceaccount.com"
  buckets = {
    public   = "Public and registered datasets, seed data, demos"
    fixtures = "Synthetic fixtures for e2e tests and staging"
    releases = "De-identified releases copied from spurby-phi (one-way)"
  }
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_storage_bucket" "this" {
  for_each                    = local.buckets
  name                        = "${var.project}-${each.key}"
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = each.key == "public" && var.public_read ? "inherited" : "enforced"
  labels                      = { purpose = each.key }
  versioning {
    enabled = true
  }
  depends_on = [google_project_service.storage]
}

resource "google_storage_bucket_iam_member" "public" {
  count  = var.public_read ? 1 : 0
  bucket = google_storage_bucket.this["public"].name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# The release job writes; it can't read or delete what's there.
resource "google_storage_bucket_iam_member" "release" {
  bucket = google_storage_bucket.this["releases"].name
  role   = "roles/storage.objectCreator"
  member = local.release_sa
}

output "buckets" {
  value = { for k, b in google_storage_bucket.this : k => b.name }
}
