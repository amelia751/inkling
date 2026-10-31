variable "org_id" {
  description = "Organization ID (gcloud organizations list)."
  type        = string
}

variable "phi_project" {
  description = "Project holding every customer upload; inside the perimeter."
  type        = string
  default     = "spurby-phi"
}

variable "data_project" {
  description = "Project for curated, public, synthetic and de-identified data."
  type        = string
  default     = "spurby-data"
}

variable "allowed_locations" {
  description = "Value group or locations for gcp.resourceLocations."
  type        = list(string)
  default     = ["in:us-locations"]
}

variable "perimeter_enforced" {
  description = "false: the perimeter runs in dry-run mode and only logs violations."
  type        = bool
  default     = false
}

variable "restricted_services" {
  description = "Google APIs the perimeter protects in the PHI project."
  type        = list(string)
  default = [
    "storage.googleapis.com",
    "sqladmin.googleapis.com",
    "cloudkms.googleapis.com",
    "healthcare.googleapis.com",
    "dlp.googleapis.com",
    "bigquery.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "container.googleapis.com",
    "pubsub.googleapis.com",
    "aiplatform.googleapis.com",
  ]
}
