variable "project" {
  description = "Build project: the agent and its sandboxes. Never customer data."
  type        = string
  default     = "spurby-ai"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "gke_enabled" {
  description = "GKE cluster, Memorystore, Cloud NAT and the ingress address. Off: torn down 2026-11-03 to stop idle billing; the databases, registry and network stay."
  type        = bool
  default     = false
}

variable "sql_running" {
  description = "Cloud SQL runs (ALWAYS) or is stopped (NEVER: only storage and backups bill; data kept)."
  type        = bool
  default     = false
}

variable "sql_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "redis_transit_encryption" {
  description = "SERVER_AUTHENTICATION (TLS; clients trust output redis_ca) or DISABLED."
  type        = string
  default     = "SERVER_AUTHENTICATION"
}

variable "network" {
  type = object({
    nodes    = string
    pods     = string
    services = string
    psa      = string
  })
  default = {
    nodes    = "10.40.0.0/20"
    pods     = "10.44.0.0/14"
    services = "10.48.0.0/20"
    psa      = "10.60.0.0/16"
  }
}

variable "master_ipv4_cidr" {
  type    = string
  default = "172.16.1.0/28"
}
