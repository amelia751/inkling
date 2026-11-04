# Cloud Run stage (run.tf, todo22 W6). Pass the stage's host and image tag as -var; nothing here
# is a secret (secret values go into Secret Manager by hand, run-secrets.tf).

variable "studio_host" {
  description = "The Studio's public host name (e.g. studio.example.com): the HTTPS load balancer's managed certificate, the WorkOS redirect URI and the URL the agent and worker call the api on."
  type        = string
  default     = "studio.example.com"
}

variable "site_host" {
  description = "Host of the public site (apps/site, e.g. example.com) on the same load balancer; www.<site_host> redirects to it. Empty: no site."
  type        = string
  default     = ""
}

variable "display_name" {
  description = "Product name the Studio and the site show in this stage (STUDIO_DISPLAY_NAME: web's /config.json, the site's pages). Empty: the naming config's."
  type        = string
  default     = ""
}

variable "features" {
  description = "todo13 feature flags the api turns on or off in this stage (chat_drops, auto_apply, fast_path, datasets_tab → STUDIO_API_FEATURE_<FLAG>). Unset flags keep the api's default (off in production). Staging sets { chat_drops = true, auto_apply = true, fast_path = true } (todo24 D1)."
  type        = map(bool)
  default     = {}
  validation {
    condition     = alltrue([for k in keys(var.features) : contains(["chat_drops", "auto_apply", "fast_path", "datasets_tab"], k)])
    error_message = "features keys are chat_drops, auto_apply, fast_path, datasets_tab."
  }
}

variable "image_tag" {
  description = "Tag of every Studio image in the `images` registry (immutable tags: the git SHA CI pushed)."
  type        = string
  default     = "main"
}

variable "images" {
  description = "Per-service image overrides (web, api, versioning, pipeline, worker): a full image reference. Unset: <registry>/studio-<name>:<image_tag>."
  type        = map(string)
  default     = {}
}

variable "agent_url" {
  description = "The agent's Cloud Run URL (infra/terraform/ai output agent_url). web's nginx proxies /api/agent/* there with the agent token."
  type        = string
  default     = "https://agent.invalid"
}

variable "workos_client_id" {
  description = "WorkOS client id (`client_…`) of the stage's WorkOS environment (staging for staging). Not secret."
  type        = string
  default     = ""
}

variable "workos_issuer" {
  description = "Expected `iss` of WorkOS access tokens. Empty: not checked."
  type        = string
  default     = ""
}

variable "run_nat_enabled" {
  description = "Cloud NAT for the Cloud Run services' internet egress (the api calls api.workos.com). Turn off while network.tf's GKE NAT still exists: both would cover the same subnet."
  type        = bool
  default     = true
}

variable "run_scaling" {
  description = "Instances per service: min and max (the worker: keep min = max, it claims jobs and takes no requests)."
  type        = map(object({ min = number, max = number }))
  default = {
    web        = { min = 0, max = 4 }
    api        = { min = 1, max = 4 }
    versioning = { min = 0, max = 2 }
    # max × STUDIO_PIPELINE_DB_POOL_MAX stays under pipeline_app's CONNECTION LIMIT (20).
    pipeline = { min = 1, max = 4 }
    worker   = { min = 1, max = 1 }
  }
}

variable "worker_memory" {
  description = "Memory of a worker instance. /tmp is in memory on Cloud Run, so archive unpack scratch counts against it (STUDIO_WORKER_UNPACK_TMP_BYTES)."
  type        = string
  default     = "8Gi"
}
