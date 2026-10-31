# Cloud CDN in front of the artifacts bucket (bundles are immutable, so cached forever). Off
# until var.cdn_domain is set.
#
# Before enabling, check two things the dry-run perimeter will show:
# - CDN cache fill reads the bucket as the cdn-fill service agent from outside the perimeter; it
#   needs a perimeter ingress rule for that identity, or delivery moves to a bucket in spurby-data
#   (bundles are code, never customer data).
# - The bucket stays private (public access prevention): the fill agent gets objectViewer, and
#   the Studio fetches bundles through the api's signed URLs or the CDN's signed cookies.
locals {
  cdn = var.cdn_domain == "" ? toset([]) : toset(["artifacts"])
}

resource "google_compute_backend_bucket" "artifacts" {
  for_each    = local.cdn
  name        = "artifacts"
  bucket_name = google_storage_bucket.this["artifacts"].name
  enable_cdn  = true
  cdn_policy {
    cache_mode  = "CACHE_ALL_STATIC"
    default_ttl = 31536000
    max_ttl     = 31536000
  }
}

resource "google_storage_bucket_iam_member" "cdn_fill" {
  for_each = local.cdn
  bucket   = google_storage_bucket.this["artifacts"].name
  role     = "roles/storage.objectViewer"
  member   = "serviceAccount:service-${local.number}@cloud-cdn-fill.iam.gserviceaccount.com"
}

resource "google_compute_global_address" "cdn" {
  for_each = local.cdn
  name     = "artifacts-cdn"
}

resource "google_compute_managed_ssl_certificate" "cdn" {
  for_each = local.cdn
  name     = "artifacts-cdn"
  managed {
    domains = [var.cdn_domain]
  }
}

resource "google_compute_url_map" "cdn" {
  for_each        = local.cdn
  name            = "artifacts-cdn"
  default_service = google_compute_backend_bucket.artifacts[each.key].id
}

resource "google_compute_target_https_proxy" "cdn" {
  for_each         = local.cdn
  name             = "artifacts-cdn"
  url_map          = google_compute_url_map.cdn[each.key].id
  ssl_certificates = [google_compute_managed_ssl_certificate.cdn[each.key].id]
}

resource "google_compute_global_forwarding_rule" "cdn" {
  for_each              = local.cdn
  name                  = "artifacts-cdn"
  target                = google_compute_target_https_proxy.cdn[each.key].id
  ip_address            = google_compute_global_address.cdn[each.key].address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
