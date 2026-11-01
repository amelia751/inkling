"""Job heartbeat (todo12 §4 M0 items 1-2, docs/pipeline.md §10.3).

While a job runs, a thread posts the job's progress to the kernel every `interval_s`
(sooner when the plugin reports new progress). Each post renews the job's lease. A 409 (or
404) means the lease is gone: the job was cancelled, or it expired and another worker took
it. The heartbeat then sets `lost` and calls `on_lost` once, which kills the job's process
group, and the worker reports nothing for that attempt: the kernel would refuse it anyway
(fencing by attempt number). Network errors are retried at the next beat; if they last
past the lease, the lease expires and the job runs again elsewhere.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable

import httpx

log = logging.getLogger("studio_worker")


class Heartbeat:
    def __init__(self, http: httpx.Client, job_id: str, worker_id: str, attempt: int | None, *, interval_s: float = 2.0, on_lost: Callable[[str], None] | None = None):
        self.http, self.job_id, self.worker_id, self.attempt = http, job_id, worker_id, attempt
        self.interval_s = interval_s
        self.on_lost = on_lost
        self.lost = threading.Event()
        self.reason = ""
        self._stop = threading.Event()
        self._nudge = threading.Event()
        self._progress: float = 0.0
        self._message: str | None = None
        self._thread: threading.Thread | None = None

    def report(self, progress: float, message: str | None) -> None:
        """New progress from the job: sent with the next beat, which comes at once."""
        self._progress, self._message = float(progress or 0.0), message
        self._nudge.set()

    def beat(self) -> bool:
        """One renewal. False once the lease is lost."""
        if self.lost.is_set():
            return False
        body = {"workerId": self.worker_id, "progress": self._progress, "message": self._message}
        if self.attempt is not None:
            body["attempt"] = self.attempt
        try:
            r = self.http.post(f"/api/v1/worker/jobs/{self.job_id}/progress", json=body)
        except httpx.HTTPError as e:
            log.warning("heartbeat failed; retrying", extra={"job_id": self.job_id, "error": type(e).__name__})
            return True
        if r.status_code in (404, 409):
            try:
                self.reason = str(r.json().get("detail") or r.status_code)
            except ValueError:
                self.reason = str(r.status_code)
            self.lost.set()
            log.warning("lease lost: stopping the job", extra={"job_id": self.job_id, "reason": self.reason})
            if self.on_lost is not None:
                self.on_lost(self.reason)
            return False
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self.beat():
                return
            self._nudge.wait(self.interval_s)
            self._nudge.clear()

    def __enter__(self) -> Heartbeat:
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{self.job_id}", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._nudge.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval_s + 35)
