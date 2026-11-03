variable "project" {
  description = "Project holding every customer upload; inside the perimeter."
  type        = string
  default     = "spurby-phi"
}

variable "region" {
  description = "Region for every regional resource (must be allowed by gcp.resourceLocations)."
  type        = string
  default     = "us-central1"
}

variable "data_project" {
  description = "Project receiving de-identified releases (infra/terraform/data)."
  type        = string
  default     = "spurby-data"
}

variable "sql_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "sql_high_availability" {
  description = "REGIONAL (failover replica) instead of ZONAL."
  type        = bool
  default     = false
}

variable "redis_memory_gb" {
  description = "Memorystore for Redis size (job queue and event bus)."
  type        = number
  default     = 1
}

variable "redis_transit_encryption" {
  description = "SERVER_AUTHENTICATION (TLS; clients must trust the instance CA, output redis_ca) or DISABLED."
  type        = string
  default     = "SERVER_AUTHENTICATION"
}

variable "artifacts_retention_days" {
  description = "Retention on the plugin artifacts bucket: an object can't be deleted or replaced before this."
  type        = number
  default     = 3650
}

variable "artifacts_retention_locked" {
  description = "Lock the artifacts retention policy. IRREVERSIBLE: the bucket can't be deleted until every object ages out."
  type        = bool
  default     = false
}

variable "audit_retention_days" {
  description = "Retention on the audit log bucket."
  type        = number
  default     = 2190
}

variable "audit_retention_locked" {
  description = "Lock the audit bucket's retention policy. IRREVERSIBLE (as above)."
  type        = bool
  default     = false
}

variable "cdn_domain" {
  description = "Host name for Cloud CDN in front of the artifacts bucket (e.g. artifacts.example.com). Empty: no CDN. See cdn.tf before enabling."
  type        = string
  default     = ""
}

variable "network" {
  description = "Address ranges. psa is the private services range for Cloud SQL and Memorystore (the k8s overlay's DATA_SERVICES_CIDR)."
  type = object({
    nodes    = string
    pods     = string
    services = string
    psa      = string
  })
  default = {
    nodes    = "10.10.0.0/20"
    pods     = "10.12.0.0/14"
    services = "10.16.0.0/20"
    psa      = "10.30.0.0/16"
  }
}

variable "master_ipv4_cidr" {
  description = "/28 for the GKE control plane's private endpoint."
  type        = string
  default     = "172.16.0.0/28"
}

# ---- CI (ci.tf) ------------------------------------------------------------------------------

variable "github_repository" {
  description = "GitHub repository (owner/name) whose `main` branch may push images. Pass as -var; empty: no CI federation."
  type        = string
  default     = ""
}

variable "github_repository_id" {
  description = "Numeric ID of that repository (`gh api repos/<owner>/<name> --jq .id`). The condition matches IDs, which survive renames and can't be re-registered by someone else."
  type        = string
  default     = ""
}

variable "github_repository_owner_id" {
  description = "Numeric ID of the repository's owner (`gh api repos/<owner>/<name> --jq .owner.id`)."
  type        = string
  default     = ""
}

# ---- Pipeline milestones (todo12 A10). Off until their milestone ships. ----------------------

variable "pipeline_connectors_enabled" {
  description = "Milestone 3: pipeline Google identity, Pub/Sub topic + pull subscription, landing bucket notifications (pipeline-connectors.tf)."
  type        = bool
  default     = false
}

variable "pipeline_connector_buckets" {
  description = "Extra buckets in this project (names) whose object notifications feed the pipeline, besides the `landing` bucket. Milestone 3."
  type        = list(string)
  default     = []
}

variable "gpu_workers_enabled" {
  description = "Milestone 4: regional NVIDIA L4 quota preferences for the worker-gpu Deployment (gpu.tf). A person applies it; Google may grant less."
  type        = bool
  default     = false
}

variable "gpu_l4_quota" {
  description = "Regional NVIDIA L4 GPUs to request: on-demand and Spot (preemptible)."
  type        = object({ on_demand = number, spot = number })
  default     = { on_demand = 4, spot = 8 }
}

variable "quota_contact_email" {
  description = "Who Google contacts about the GPU quota request. Pass as -var (never commit an address)."
  type        = string
  default     = ""
}
