"""§14 #7: re-running a job with the same idempotency key doesn't duplicate committed annotations.
§14 #5: invalid provider output becomes a recoverable job error, never malformed annotations."""

from __future__ import annotations

from .conftest import mask_result, run_worker_once, worker_headers, ws
from .test_installer_flow import install


def test_same_key_same_job_no_duplicates(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    h = ws("ws-a", **{"Idempotency-Key": "seg-1"})
    first = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=h).json()["job"]
    run_worker_once(c, mask_result())
    again = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=h)
    assert again.status_code == 200 and again.json()["replayed"] and again.json()["job"]["jobId"] == first["jobId"]
    assert c.post("/api/v1/worker/claim", json={"workerId": "w1"}, headers=worker_headers()).json() == {"job": None}
    assert len(c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]) == 1


def test_a_reported_result_commits_once_even_if_reported_twice(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    claim, _ = run_worker_once(c, mask_result())
    dup = c.post(f"/api/v1/worker/jobs/{claim['job']['jobId']}/complete", json={"workerId": "w1", "result": mask_result()}, headers=worker_headers())
    assert dup.status_code == 409
    assert len(c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]) == 1


def test_invalid_output_is_a_recoverable_error_and_commits_nothing(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    bad = mask_result()
    bad["instances"][0]["mask"]["counts"] = [5, 5]  # doesn't cover the image
    _, job = run_worker_once(c, bad)
    assert job["state"] == "failed" and job["recoverable"] and "invalid" in job["error"]
    assert c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"] == []
    # Garbage of the wrong shape too.
    c.post(f"/api/v1/jobs/{job['jobId']}/retry", headers=ws("ws-a"))
    _, job = run_worker_once(c, {"masks": "nope"})
    assert job["state"] == "failed" and c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"] == []


def test_cancelled_jobs_never_commit(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    j = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a")).json()["job"]
    claim = c.post("/api/v1/worker/claim", json={"workerId": "w1"}, headers=worker_headers()).json()
    c.post(f"/api/v1/jobs/{j['jobId']}/cancel", headers=ws("ws-a"))
    r = c.post(f"/api/v1/worker/jobs/{claim['job']['jobId']}/complete", json={"workerId": "w1", "result": mask_result()}, headers=worker_headers())
    assert r.status_code == 409
    assert c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"] == []
