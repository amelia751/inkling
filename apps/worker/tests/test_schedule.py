"""todo7 Phase 4: the worker asks the kernel for `files.empty_trash` at most once an hour."""

from __future__ import annotations

import httpx

from studio_worker.schedule import Scheduled


def test_asks_once_per_interval_and_reports_what_ran():
    calls: list[str] = []
    answers = iter([{"ran": True, "result": {"purged": 3}}, {"ran": False}])

    def handler(request: httpx.Request) -> httpx.Response:
        if not request.url.path.endswith("files.empty_trash"):
            return httpx.Response(200, json={"ran": False})
        calls.append(request.url.path)
        return httpx.Response(200, json=next(answers))

    now = [0.0]
    s = Scheduled(httpx.Client(transport=httpx.MockTransport(handler), base_url="http://kernel"), interval_s=3600, clock=lambda: now[0])
    assert s.tick() == ["files.empty_trash"]
    assert s.tick() == []  # within the hour: no call
    now[0] = 3601
    assert s.tick() == []  # the kernel already ran it today
    assert calls == ["/api/v1/worker/scheduled/files.empty_trash"] * 2


def test_an_older_kernel_without_the_route_is_ignored():
    s = Scheduled(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404)), base_url="http://kernel"))
    assert s.tick() == []


def test_name_screening_backfill_is_asked_every_minute():
    """todo13 D13: `files.screen_names` runs a slice of the backfill about once a minute."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, json={"ran": request.url.path.endswith("files.screen_names")})

    now = [0.0]
    s = Scheduled(httpx.Client(transport=httpx.MockTransport(handler), base_url="http://kernel"), interval_s=3600, clock=lambda: now[0])
    assert s.tick() == ["files.screen_names"]
    now[0] = 61
    assert s.tick() == ["files.screen_names"]
    assert calls == ["files.empty_trash", "files.screen_names", "blobs.retry", "files.screen_names"]


def test_blobs_retry_is_asked_with_the_daily_jobs():
    """todo18 D8: the failed after-commit deletes are retried daily (the kernel dedupes the day)."""
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return httpx.Response(200, json={"ran": request.url.path.endswith("blobs.retry")})

    s = Scheduled(httpx.Client(transport=httpx.MockTransport(handler), base_url="http://kernel"), interval_s=3600, clock=lambda: 0.0)
    assert s.tick() == ["blobs.retry"]
    assert "/api/v1/worker/scheduled/blobs.retry" in paths
