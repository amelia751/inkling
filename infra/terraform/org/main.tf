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
    prefix = "org"
  }
}

provider "google" {
  billing_project       = var.phi_project
  user_project_override = true
}

data "google_project" "phi" {
  project_id = var.phi_project
}

data "google_project" "data" {
  project_id = var.data_project
}

resource "google_folder" "this" {
  for_each     = toset(["shared", "nonprod", "prod"])
  display_name = each.key
  parent       = "organizations/${var.org_id}"
}
