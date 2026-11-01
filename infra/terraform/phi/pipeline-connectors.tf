# Milestone 3 (todo12 A10, docs/pipeline.md §14): continuous pipelines from Cloud Storage.
# Off until pipeline_connectors_enabled=true; nothing here exists before then.
#
#   landing bucket (+ pipeline_connector_buckets) ─ object notifications ─▶ Pub/Sub topic
#   ─▶ pull subscription ─▶ apps/pipeline (Workload Identity as studio-pipeline)
#
# Pull, not push: push subscriptions are restricted inside a VPC Service Controls perimeter.
# Delivery is at-least-once and unordered and can miss events, so the pipeline dedupes on
# bucket/object#generation and reconciles by listing prefixes (hence objectViewer, which
# includes list). The pipeline never writes to Storage and never touches KMS or Healthcare.
locals {
  connector_buckets = var.pipeline_connectors_enabled ? toset(concat([google_storage_bucket.this["landing"].name], var.pipeline_connector_buckets)) : toset([])
}

resource "google_project_service_identity" "pubsub" {
  provider   = google-beta
  count      = var.pipeline_connectors_enabled ? 1 : 0
  service    = "pubsub.googleapis.com"
  depends_on = [google_project_service.this]
}

# Its own CMEK key, like every other service here (kms.tf); separate so it doesn't exist (and
# can't be deleted, prevent_destroy) before the milestone.
resource "google_kms_crypto_key" "pubsub" {
  count           = var.pipeline_connectors_enabled ? 1 : 0
  name            = "pubsub"
  key_ring        = google_kms_key_ring.studio.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"
  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "pubsub" {
  count         = var.pipeline_connectors_enabled ? 1 : 0
  crypto_key_id = google_kms_crypto_key.pubsub[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

resource "google_pubsub_topic" "connector_objects" {
  count        = var.pipeline_connectors_enabled ? 1 : 0
  name         = "pipeline-connector-objects"
  kms_key_name = google_kms_crypto_key.pubsub[0].id
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_kms_crypto_key_iam_member.pubsub]
}

# Messages the pipeline couldn't handle after max_delivery_attempts, kept for a person to look at.
resource "google_pubsub_topic" "connector_objects_dead" {
  count        = var.pipeline_connectors_enabled ? 1 : 0
  name         = "pipeline-connector-objects-dead"
  kms_key_name = google_kms_crypto_key.pubsub[0].id
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_kms_crypto_key_iam_member.pubsub]
}

resource "google_pubsub_subscription" "connector_objects" {
  count                      = var.pipeline_connectors_enabled ? 1 : 0
  name                       = "pipeline-connector-objects"
  topic                      = google_pubsub_topic.connector_objects[0].id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false
  enable_message_ordering    = false
  expiration_policy {
    ttl = "" # never expires
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.connector_objects_dead[0].id
    max_delivery_attempts = 10
  }
}

resource "google_pubsub_subscription" "connector_objects_dead" {
  count                      = var.pipeline_connectors_enabled ? 1 : 0
  name                       = "pipeline-connector-objects-dead"
  topic                      = google_pubsub_topic.connector_objects_dead[0].id
  message_retention_duration = "604800s"
  expiration_policy {
    ttl = ""
  }
}

# Pub/Sub's service agent forwards undeliverable messages to the dead-letter topic.
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  count  = var.pipeline_connectors_enabled ? 1 : 0
  topic  = google_pubsub_topic.connector_objects_dead[0].id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  count        = var.pipeline_connectors_enabled ? 1 : 0
  subscription = google_pubsub_subscription.connector_objects[0].id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

# The pipeline: subscriber on its subscription only, and read/list on the connector buckets.
resource "google_pubsub_subscription_iam_member" "pipeline" {
  count        = var.pipeline_connectors_enabled ? 1 : 0
  subscription = google_pubsub_subscription.connector_objects[0].id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.app["pipeline"].email}"
}

resource "google_storage_bucket_iam_member" "pipeline_connector_read" {
  for_each = local.connector_buckets
  bucket   = each.key
  role     = "roles/storage.objectViewer"
  member   = "serviceAccount:${google_service_account.app["pipeline"].email}"
}

# Uploads to the landing bucket go through the api (it brokers every Google call).
resource "google_storage_bucket_iam_member" "api_landing" {
  count  = var.pipeline_connectors_enabled ? 1 : 0
  bucket = google_storage_bucket.this["landing"].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.app["api"].email}"
}

# Cloud Storage's service agent publishes the notifications.
resource "google_pubsub_topic_iam_member" "gcs_publisher" {
  count  = var.pipeline_connectors_enabled ? 1 : 0
  topic  = google_pubsub_topic.connector_objects[0].id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_storage_notification" "connector" {
  for_each       = local.connector_buckets
  bucket         = each.key
  topic          = google_pubsub_topic.connector_objects[0].id
  payload_format = "JSON_API_V1"
  # New objects and overwrites (finalize), deletions and archived versions (retractions; they
  # become candidate changes, never immediate deletes).
  event_types = ["OBJECT_FINALIZE", "OBJECT_DELETE", "OBJECT_ARCHIVE"]
  custom_attributes = {
    source = "connector"
  }
  depends_on = [google_pubsub_topic_iam_member.gcs_publisher]
}
