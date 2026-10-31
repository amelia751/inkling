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

variable "admin_identities" {
  description = "Identities admitted through the perimeter from anywhere (operators, Terraform). Add people as -var, never in a committed file."
  type        = list(string)
  default     = ["serviceAccount:terraform@spurby-phi.iam.gserviceaccount.com"]
}

variable "release_egress" {
  description = "Allow the release identity to create objects in spurby-data. Turn on after infra/terraform/phi has created it."
  type        = bool
  default     = false
}

variable "release_service_account" {
  description = "account_id of the release service account in the PHI project (infra/terraform/phi/iam.tf)."
  type        = string
  default     = "studio-release"
}
