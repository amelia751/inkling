# Cloud Healthcare API for DICOM de-identification during fingerprinting (todo10 §6.1 step 1,
# Phase 9 item 4). The api brokers the calls (the worker has no Google identity); Sensitive Data
# Protection needs only the API and roles/dlp.user (iam.tf).
resource "google_healthcare_dataset" "studio" {
  name     = "studio"
  location = var.region
  encryption_spec {
    kms_key_name = google_kms_crypto_key.cmek["healthcare"].id
  }
  depends_on = [google_project_service.this, google_kms_crypto_key_iam_member.cmek]
}

# Instances are imported here, de-identified into `fingerprint-deid`, read back, then deleted.
resource "google_healthcare_dicom_store" "this" {
  for_each = toset(["fingerprint", "fingerprint-deid"])
  name     = each.key
  dataset  = google_healthcare_dataset.studio.id
}

resource "google_healthcare_dataset_iam_member" "api" {
  dataset_id = google_healthcare_dataset.studio.id
  role       = "roles/healthcare.dicomEditor"
  member     = "serviceAccount:${google_service_account.app["api"].email}"
}

# Starting a de-identify operation (healthcare.dicomStores.deidentify) needs the store admin role.
resource "google_healthcare_dataset_iam_member" "api_deid" {
  dataset_id = google_healthcare_dataset.studio.id
  role       = "roles/healthcare.dicomStoreAdmin"
  member     = "serviceAccount:${google_service_account.app["api"].email}"
}
