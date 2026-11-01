# Every bucket: CMEK, uniform access, public access prevented, object versioning on.
locals {
  buckets = merge({
    # apps/api BlobStore: seed and uploaded assets at the root, kernel-written data under .data/
    # (INKLING_GCS_BUCKET).
    objects = { retention_days = 0, locked = false }
    # Plugin bundles, content-addressed (artifacts/sha256/<digest>, todo10 Phase 3): objects
    # can't be changed or deleted while retained.
    artifacts = { retention_days = var.artifacts_retention_days, locked = var.artifacts_retention_locked }
    # apps/versioning: raw objects and manifests.
    versioning-objects   = { retention_days = 0, locked = false }
    versioning-manifests = { retention_days = 0, locked = false }
    # Audit log sink (audit.tf).
    audit-logs = { retention_days = var.audit_retention_days, locked = var.audit_retention_locked }
    }, var.pipeline_connectors_enabled ? {
    # Milestone 3: where connector sources land; its notifications feed the pipeline
    # (pipeline-connectors.tf).
    landing = { retention_days = 0, locked = false }
  } : {})
}

resource "google_storage_bucket" "this" {
  for_each                    = local.buckets
  name                        = "${var.project}-${each.key}"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = each.value.retention_days == 0
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.cmek["storage"].id
  }

  dynamic "retention_policy" {
    for_each = each.value.retention_days > 0 ? [1] : []
    content {
      retention_period = each.value.retention_days * 86400
      is_locked        = each.value.locked
    }
  }

  # Old object versions (overwritten or deleted) go after 30 days.
  dynamic "lifecycle_rule" {
    for_each = each.value.retention_days == 0 ? [1] : []
    content {
      condition {
        days_since_noncurrent_time = 30
      }
      action {
        type = "Delete"
      }
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.cmek]
}

# The api reads and writes assets and derived data; it may add bundles, never change them.
resource "google_storage_bucket_iam_member" "api_objects" {
  bucket = google_storage_bucket.this["objects"].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.app["api"].email}"
}

resource "google_storage_bucket_iam_member" "api_artifacts" {
  for_each = toset(["roles/storage.objectCreator", "roles/storage.objectViewer"])
  bucket   = google_storage_bucket.this["artifacts"].name
  role     = each.key
  member   = "serviceAccount:${google_service_account.app["api"].email}"
}

resource "google_storage_bucket_iam_member" "versioning" {
  for_each = toset(["versioning-objects", "versioning-manifests"])
  bucket   = google_storage_bucket.this[each.key].name
  role     = "roles/storage.objectUser"
  member   = "serviceAccount:${google_service_account.app["versioning"].email}"
}

# The release job reads de-identified output from the objects bucket; writing to spurby-data is
# granted in infra/terraform/data and allowed by the perimeter's egress rule (org).
resource "google_storage_bucket_iam_member" "release_read" {
  bucket = google_storage_bucket.this["objects"].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.app["release"].email}"
}
