# todo13 §7.3: drops, the minute budget and name screening, watched through Cloud Logging
# log-based metrics on the api's JSON log lines (no metrics library, no new dependency) and
# Cloud Monitoring alerts on them. Written by the integrator; a person runs `terraform plan`
# and `apply` (README.md). Nothing here reads a name: the lines carry ids, states, steps,
# durations and counts by kind only (apps/api `kernel/drops.py`, `kernel/drops_plan.py`,
# `routes/features.py`, `kernel/name_screen.py`).
#
# The lines (jsonPayload.msg):
#   drop.received | drop.session | drop.uploaded | drop.inspected | drop.classified |
#   drop.planned | drop.applied | drop.undone | drop.failed {step, errorClass} | drop.stuck
#   drop.timeline {origin, outcome, elapsed_ms = first interactive item, steps_ms}  (the browser's)
#   name_screen.batch {names, flagged} | name_screen.error {error, names}
#   workos_sync.batch {events, seen, failures, lag_ms, events_per_s} | workos_sync.failed
#   {eventId, eventType, errorClass} | workos_sync.lagging {lag_ms} | workos_sync.reconciled
#   (todo9 Phase 7, apps/api `auth/sync.py`: the WorkOS Events API sync, ids only)

variable "alert_notification_channels" {
  description = "Cloud Monitoring notification channel ids (projects/…/notificationChannels/…) for the todo13 drop alerts. Empty: the alerts open incidents without notifying anyone."
  type        = list(string)
  default     = []
}

locals {
  # The api's containers in the apps' namespace (infra/k8s/overlays/gke/phi).
  api_logs = "resource.type=\"k8s_container\" AND resource.labels.namespace_name=\"${local.ns}\" AND resource.labels.container_name=\"api\""
  # Prometheus names of the log-based metrics below (Managed Service for Prometheus naming).
  prom = "logging_googleapis_com:user_"
}

# ---- Log-based metrics ------------------------------------------------------------------------

# Drop (or send) to the first item interactive in a Studio, from the browser's timeline post
# (POST /api/v1/telemetry/timeline). The J1 budget: < 15 s on the fast path (§6).
resource "google_logging_metric" "drop_first_interactive" {
  name        = "drop_first_interactive_ms"
  description = "todo13 §6: ms from the first drop or send to the first item interactive in a Studio (browser timeline)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"drop.timeline\" AND jsonPayload.outcome=\"interactive\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
    labels {
      key         = "origin"
      value_type  = "STRING"
      description = "Where the gesture happened: home, chat, canvas, files…"
    }
  }
  value_extractor = "EXTRACT(jsonPayload.elapsed_ms)"
  label_extractors = {
    origin = "EXTRACT(jsonPayload.origin)"
  }
  # 100 ms × 1.2^n: up to ~15 min in 50 buckets.
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 50
      growth_factor      = 1.2
      scale              = 100
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "drop_failures" {
  name        = "drop_failures"
  description = "todo13 §7.3: drops that failed, by step (upload, classify, apply, unpack) and error class."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"drop.failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "step"
      value_type = "STRING"
    }
    labels {
      key        = "error_class"
      value_type = "STRING"
    }
  }
  label_extractors = {
    step        = "EXTRACT(jsonPayload.step)"
    error_class = "EXTRACT(jsonPayload.errorClass)"
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "unpack_refusals" {
  name        = "drop_unpack_refusals"
  description = "todo13 §7.3: archives the worker refused to unpack, by reason (ratio, depth, traversal, encrypted, too_large…)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"drop.failed\" AND jsonPayload.step=\"unpack\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "reason"
      value_type = "STRING"
    }
  }
  label_extractors = {
    reason = "EXTRACT(jsonPayload.errorClass)"
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "drops_stuck" {
  name        = "drops_stuck_inspecting"
  description = "todo13 §7.3: a drop still inspecting 10 minutes after its last change (logged about once a minute per api replica while it lasts)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"drop.stuck\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.this]
}

# Name screening (D3, D13): calls that failed (the batch is flagged, fail closed) and calls
# that answered. The error rate is errors / (errors + batches).
resource "google_logging_metric" "name_screen_errors" {
  name        = "name_screen_errors"
  description = "todo13 §7.3: Sensitive Data Protection screening calls that failed (names flagged, fail closed)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"name_screen.error\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "name_screen_batches" {
  name        = "name_screen_batches"
  description = "todo13 §7.3: Sensitive Data Protection screening calls that answered."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"name_screen.batch\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.this]
}

# Auto-apply (D6): plans applied on their own, and how many of those the person undid. The
# undo rate is undone / applied; a high one means the classifier's defaults are wrong.
resource "google_logging_metric" "drop_auto_applied" {
  name        = "drop_auto_applied"
  description = "todo13 §7.3: drop plans applied automatically (auto-apply or the fast path)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"drop.applied\" AND jsonPayload.auto=true"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "drop_auto_undone" {
  name        = "drop_auto_undone"
  description = "todo13 §7.3: automatically applied drop plans the person undid."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"drop.undone\" AND jsonPayload.auto=true"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.this]
}

# The WorkOS event sync (todo9 Phase 7): events applied per poll (events/s on a chart),
# failures, and the once-a-minute line while it's over 5 minutes behind.
resource "google_logging_metric" "workos_sync_events" {
  name        = "workos_sync_events"
  description = "todo9 Phase 7: WorkOS events applied per sync poll (workos_sync.batch)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"workos_sync.batch\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
  }
  value_extractor = "EXTRACT(jsonPayload.events)"
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 20
      growth_factor      = 2
      scale              = 1
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "workos_sync_failures" {
  name        = "workos_sync_failures"
  description = "todo9 Phase 7: a WorkOS event that failed to apply (retried, skipped after 5 attempts)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"workos_sync.failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "workos_sync_lagging" {
  name        = "workos_sync_lagging"
  description = "todo9 Phase 7: the WorkOS event sync is over 5 minutes behind (logged once a minute while it lasts)."
  filter      = "${local.api_logs} AND jsonPayload.msg=\"workos_sync.lagging\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.this]
}

# ---- Alerts -----------------------------------------------------------------------------------

# Monitoring refuses an alert on a log-based metric until the metric has propagated (up to 10
# minutes after it's created). On a first apply this runs alongside the cluster's creation.
resource "time_sleep" "metrics_visible" {
  create_duration = "600s"
  depends_on = [
    google_logging_metric.drop_first_interactive,
    google_logging_metric.name_screen_errors,
    google_logging_metric.name_screen_batches,
    google_logging_metric.drops_stuck,
    google_logging_metric.workos_sync_lagging,
  ]
}

resource "google_monitoring_alert_policy" "drop_first_interactive_p95" {
  depends_on            = [time_sleep.metrics_visible]
  display_name          = "Drops: p95 drop to first interactive item over 30 s"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels
  severity              = "WARNING"

  conditions {
    display_name = "p95 drop_first_interactive_ms > 30000 for 15 min"
    condition_threshold {
      filter          = "resource.type=\"k8s_container\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.drop_first_interactive.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 30000
      duration        = "900s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The minute budget (todo13 §6) is slipping: the browser's timeline (`drop.timeline` lines) puts p95 drop-to-first-interactive over 30 s. Open a slow drop's lines by `jsonPayload.dropId` (`drop.received` … `drop.applied`, and `steps_ms` on its `drop.timeline`) to see which step grew: upload, inspection queue wait, or the Studio's first frame. .agents/skills/data-boundary/deployment-gcp.md, \"Rolling out drops\"."
  }
}

resource "google_monitoring_alert_policy" "name_screen_error_rate" {
  depends_on            = [time_sleep.metrics_visible]
  display_name          = "Drops: name screening error rate over 5 %"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels
  severity              = "WARNING"

  conditions {
    display_name = "name_screen errors / calls > 0.05 over 15 min"
    condition_prometheus_query_language {
      query               = "sum(rate(${local.prom}${google_logging_metric.name_screen_errors.name}[15m])) / (sum(rate(${local.prom}${google_logging_metric.name_screen_errors.name}[15m])) + sum(rate(${local.prom}${google_logging_metric.name_screen_batches.name}[15m]))) > 0.05"
      duration            = "300s"
      evaluation_interval = "60s"
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Sensitive Data Protection calls from the api are failing (`name_screen.error`). Screening fails closed: affected names reach the agent as `<kind>-NNNN.<ext>`, so nothing leaks, but the agent sees fewer real names. Check the api's `roles/dlp.user`, the DLP quota in spurby-phi and the perimeter (.agents/skills/data-boundary/deployment-gcp.md)."
  }
}

resource "google_monitoring_alert_policy" "drop_stuck_inspecting" {
  depends_on            = [time_sleep.metrics_visible]
  display_name          = "Drops: a drop stuck inspecting over 10 min"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels
  severity              = "WARNING"

  conditions {
    display_name = "any drop.stuck line in 5 min"
    condition_threshold {
      filter          = "resource.type=\"k8s_container\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.drops_stuck.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "A drop has been `inspecting` for over 10 minutes (`drop.stuck`, with its `dropId`). Usually the worker isn't claiming inspection jobs: check the worker Deployment and KEDA, the kernel job queue in Redis, then the drop's `drop.*` lines."
  }
}

resource "google_monitoring_alert_policy" "workos_sync_lagging" {
  depends_on            = [time_sleep.metrics_visible]
  display_name          = "Accounts: WorkOS event sync over 5 min behind"
  combiner              = "OR"
  notification_channels = var.alert_notification_channels
  severity              = "WARNING"

  conditions {
    display_name = "any workos_sync.lagging line in 5 min"
    condition_threshold {
      filter          = "resource.type=\"k8s_container\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.workos_sync_lagging.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The api's WorkOS Events API sync (todo9 Phase 7) hasn't caught up for over 5 minutes, so name, role and membership changes made in WorkOS aren't reaching the product. Look at `workos_sync.poll_failed` (WorkOS unreachable, egress, key) and `workos_sync.failed` lines (one event failing, with `eventId`; it's skipped after 5 attempts). `uv run python -m studio_api.auth.sync status` in an api pod shows the cursor. infra/k8s/README.md, \"WorkOS outage\"."
  }
}
