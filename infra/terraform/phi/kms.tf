# One key ring; one CMEK key per service (rotated every 90 days) plus the platform signing key.
# Keys can't be deleted in Cloud KMS (only their versions destroyed), hence prevent_destroy.
resource "google_kms_key_ring" "studio" {
  name       = "studio"
  location   = var.region
  depends_on = [google_project_service.this]
}

locals {
  cmek = toset(["storage", "sql", "redis", "gke", "secrets", "registry", "healthcare"])
}

resource "google_kms_crypto_key" "cmek" {
  for_each        = local.cmek
  name            = each.key
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

# Platform key for generated plugins (todo10 §3.1, D5). HSM-backed, never exportable. The
# Signer's gcpkms implementation (todo10-artifacts) signs with version 1:
#   projects/<project>/locations/<region>/keyRings/studio/cryptoKeys/plugin-signing/cryptoKeyVersions/1
# cosign: gcpkms://projects/<project>/locations/<region>/keyRings/studio/cryptoKeys/plugin-signing/versions/1
resource "google_kms_crypto_key" "plugin_signing" {
  name     = "plugin-signing"
  key_ring = google_kms_key_ring.studio.id
  purpose  = "ASYMMETRIC_SIGN"
  version_template {
    algorithm        = "EC_SIGN_P256_SHA256"
    protection_level = "HSM"
  }
  lifecycle {
    prevent_destroy = true
  }
}

# Who may use each CMEK key: the Google service agent of the service that encrypts with it.
locals {
  cmek_users = {
    storage    = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
    sql        = "serviceAccount:${google_project_service_identity.agent["sqladmin.googleapis.com"].email}"
    redis      = "serviceAccount:${google_project_service_identity.agent["redis.googleapis.com"].email}"
    gke        = "serviceAccount:service-${local.number}@container-engine-robot.iam.gserviceaccount.com"
    secrets    = "serviceAccount:${google_project_service_identity.agent["secretmanager.googleapis.com"].email}"
    registry   = "serviceAccount:${google_project_service_identity.agent["artifactregistry.googleapis.com"].email}"
    healthcare = "serviceAccount:${google_project_service_identity.agent["healthcare.googleapis.com"].email}"
  }
}

resource "google_kms_crypto_key_iam_member" "cmek" {
  for_each      = local.cmek
  crypto_key_id = google_kms_crypto_key.cmek[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.cmek_users[each.key]
}

# The api brokers signing for build_plugin (the worker has no Google identity and no egress).
resource "google_kms_crypto_key_iam_member" "signing_api" {
  for_each      = toset(["roles/cloudkms.signerVerifier", "roles/cloudkms.publicKeyViewer"])
  crypto_key_id = google_kms_crypto_key.plugin_signing.id
  role          = each.key
  member        = "serviceAccount:${google_service_account.app["api"].email}"
}
