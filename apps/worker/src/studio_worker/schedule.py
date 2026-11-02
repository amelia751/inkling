"""Periodic kernel work the worker triggers (todo7 Phase 4): `files.empty_trash`, and
(todo13 D13) `files.screen_names`, the name-screening backfill, about once a minute.

Every worker asks the kernel at most once an hour; the kernel runs the job at most once a day
across every worker and replica (a `scheduled_runs` row per day), purging what has been in the
Trash for more than 30 days and keeping bytes something still references. The hour is only a
hint kept in memory: losing it (a restart, another replica) costs one extra no-op call.
"""

from __future__ import annotations

import logging
import time

import httpx

log = logging.getLogger("studio_worker.schedule")

JOBS = ("files.empty_trash", "files.screen_names", "blobs.retry")  # blobs.retry: todo18 D8, daily in the kernel
# Seconds between asks per job (default: the scheduler's interval).
INTERVALS = {"files.screen_names": 60.0}


class Scheduled:
    def __init__(self, http: httpx.Client, interval_s: float = 3600.0, clock=time.monotonic):
        self.http = http
        self.interval_s = interval_s
        self.clock = clock
        self._next: dict[str, float] = {}

    def tick(self) -> list[str]:
        """Ask for each job whose hour is up; returns the ones the kernel actually ran."""
        ran = []
        now = self.clock()
        for job in JOBS:
            if now < self._next.get(job, 0.0):
                continue
            self._next[job] = now + min(self.interval_s, INTERVALS.get(job, self.interval_s))
            r = self.http.post(f"/api/v1/worker/scheduled/{job}", json={})
            if r.status_code == 404:
                continue  # an older kernel without the job
            r.raise_for_status()
            out = r.json()
            if out.get("ran"):
                log.info("scheduled job ran", extra={"job": job, "result": out.get("result")})
                ran.append(job)
        return ran
