# Cloud Run stage for the agent (run.tf, todo22 W6). Nothing here is a secret.

variable "studio_url" {
  description = "The Studio's public URL (infra/terraform/phi output studio_url). The agent calls the api there with its scoped token."
  type        = string
  default     = "https://studio.example.com"
}

variable "agent_image" {
  description = "The agent image. Empty: <region>-docker.pkg.dev/<project>/images/studio-agent:<agent_image_tag>."
  type        = string
  default     = ""
}

variable "agent_image_tag" {
  description = "Tag of the agent image (immutable tags: the git SHA CI pushed)."
  type        = string
  default     = "main"
}

variable "workos_client_id" {
  description = "WorkOS client id of the stage's environment (the api's STUDIO_API_WORKOS_CLIENT_ID). Not secret."
  type        = string
  default     = ""
}

variable "workos_issuer" {
  description = "Expected `iss` of WorkOS access tokens. Empty: not checked."
  type        = string
  default     = ""
}

variable "agent_model" {
  description = "Default model, provider:model (apps/agent/src/agent/providers). A muse: model reads its key from secret run-agent-muse-api-key."
  type        = string
  default     = "muse:muse-spark-1.3"
}

variable "agent_model_allowlist" {
  description = "Comma-separated models a person may pick."
  type        = string
  default     = "muse:muse-spark-1.3,muse:muse-wonder-1.0"
}

variable "display_name" {
  description = "Product name the assistant uses in this stage (STUDIO_DISPLAY_NAME). Empty: the naming config's."
  type        = string
  default     = ""
}

variable "agent_sandbox" {
  description = "Build sandbox provider: `daytona` (needs secret run-daytona-api-key) or `off`."
  type        = string
  default     = "daytona"
  validation {
    condition     = contains(["daytona", "off"], var.agent_sandbox)
    error_message = "daytona or off on Cloud Run (gke needs the cluster, fake and local are dev only)."
  }
}

variable "agent_min_instances" {
  description = "0 lets the agent scale to zero between chats (a cold start on the next one); 1 keeps it warm. Max is always 1 (D6: in-memory run-event bus)."
  type        = number
  default     = 0
}

variable "trace_sample_ratio" {
  description = "Share of traces kept (OTEL_TRACES_SAMPLER_ARG, parentbased_traceidratio; todo27 D5). 1.0 on staging; 0.1 in production."
  type        = number
  default     = 1.0
  validation {
    condition     = var.trace_sample_ratio >= 0 && var.trace_sample_ratio <= 1
    error_message = "trace_sample_ratio is between 0 and 1."
  }
}
