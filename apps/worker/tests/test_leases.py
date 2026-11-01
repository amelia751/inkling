"""todo12 §4 M0 items 1-3 for the worker: it heartbeats a running job, a cancel kills the job's
whole process group within 5 s, a worker that loses its lease mid-job kills its processes and
reports nothing, and it claims only its configured resource classes."""

from __future__ import annotations

import os
import threading
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from studio_worker import config
from studio_worker.main import Worker

from .conftest import install

P = config.naming()["envPrefix"]
H = {"X-Workspace-Id": "slow"}


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:  # a zombie (exited, not yet reaped) counts as gone
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split()[2] != "Z"
    except OSError:
        import subprocess

        out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(out) and not out.startswith("Z")


@pytest.fixture(scope="module")
def slow(stack):
    install(stack["url"], "slow", "test.slow")
    return stack


def start_spawn_job(url: str) -> str:
    r = httpx.post(f"{url}/api/v1/commands", json={"tool": "test.slow.spawn", "input": {}}, headers=H)
    assert r.status_code == 202, r.text
    return r.json()["job"]["jobId"]


def run_in_thread(w: Worker) -> threading.Thread:
    t = threading.Thread(target=w.tick, daemon=True)
    t.start()
    return t


def wait_for_pids(url: str, job_id: str, timeout: float = 120) -> list[int]:
    """The plugin reports its own pid and its grandchild's through progress (the heartbeat)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        j = httpx.get(f"{url}/api/v1/jobs/{job_id}", headers=H).json()
        if (j.get("message") or "").startswith("pids:"):
            return [int(x) for x in j["message"][5:].split(",")]
        assert j["state"] in ("queued", "running"), j.get("error")
        time.sleep(0.1)
    raise AssertionError("the job never reported its pids")


def gone_within(pids: list[int], seconds: float) -> float:
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        if not any(alive(p) for p in pids):
            return time.monotonic() - t0
        time.sleep(0.05)
    raise AssertionError(f"still alive after {seconds}s: {[p for p in pids if alive(p)]}")


def test_cancel_kills_the_job_process_group_within_5_s(slow, tmp_path):
    url = slow["url"]
    job_id = start_spawn_job(url)
    w = Worker(url, slow["token"], tmp_path, "w-cancel", plugins=["test.slow"], heartbeat_s=1.0)
    t = run_in_thread(w)
    pids = wait_for_pids(url, job_id)
    assert all(alive(p) for p in pids)
    t0 = time.monotonic()
    assert httpx.post(f"{url}/api/v1/jobs/{job_id}/cancel", headers=H).json()["state"] == "cancelled"
    gone_within(pids, 5.0)
    t.join(timeout=10)
    assert not t.is_alive() and time.monotonic() - t0 < 5.0 + 5.0
    j = httpx.get(f"{url}/api/v1/jobs/{job_id}", headers=H).json()
    assert j["state"] == "cancelled" and j["errorClass"] == "cancelled"  # the worker reported nothing over it


def test_a_worker_that_loses_its_lease_mid_job_kills_it_and_cannot_report(slow, tmp_path):
    """A's lease expires (a long GC pause, a network partition) and B takes the job: A's next
    heartbeat is a 409, A kills its processes and reports nothing; B's result stands."""
    from sqlalchemy import update

    from studio_api import db as dbm
    from studio_api.models import PluginJob

    url = slow["url"]
    job_id = start_spawn_job(url)
    a = Worker(url, slow["token"], tmp_path / "a", "w-a", plugins=["test.slow"], heartbeat_s=1.0)
    t = run_in_thread(a)
    pids = wait_for_pids(url, job_id)
    with dbm.session_scope() as s:
        s.execute(update(PluginJob).where(PluginJob.job_id == job_id).values(lease_until=datetime.now(UTC) - timedelta(seconds=1)))
    wh = {"X-Worker-Token": slow["token"]}
    b = httpx.post(f"{url}/api/v1/worker/claim", json={"workerId": "w-b", "plugins": ["test.slow"], "heartbeat": True}, headers=wh).json()["job"]
    assert b["jobId"] == job_id and b["attempts"] == 2
    gone_within(pids, 5.0)
    t.join(timeout=10)
    assert not t.is_alive()
    j = httpx.get(f"{url}/api/v1/jobs/{job_id}", headers=H).json()
    assert j["state"] == "running" and j["attempts"] == 2  # A neither failed nor completed it
    with dbm.session_scope() as s:
        assert s.get(PluginJob, job_id).worker_id == "w-b"
    # A late report from A, should it try, is fenced.
    late = httpx.post(f"{url}/api/v1/worker/jobs/{job_id}/complete", json={"workerId": "w-a", "attempt": 1, "result": {}}, headers=wh)
    assert late.status_code == 409
    done = httpx.post(f"{url}/api/v1/worker/jobs/{job_id}/fail", json={"workerId": "w-b", "attempt": 2, "error": "done with the test", "recoverable": False}, headers=wh)
    assert done.status_code == 200


def test_heartbeats_keep_a_short_lease_alive(slow, tmp_path):
    from studio_api import db as dbm
    from studio_api.models import PluginJob

    url = slow["url"]
    job_id = start_spawn_job(url)
    w = Worker(url, slow["token"], tmp_path, "w-hb", plugins=["test.slow"], heartbeat_s=0.5)
    t = run_in_thread(w)
    pids = wait_for_pids(url, job_id)

    def lease() -> datetime:
        with dbm.session_scope() as s:
            v = s.get(PluginJob, job_id).lease_until
            return v if v.tzinfo else v.replace(tzinfo=UTC)

    first = lease()
    assert first - datetime.now(UTC) <= timedelta(seconds=61)  # the heartbeat lease, not timeout + 30
    time.sleep(1.5)
    assert lease() > first  # renewed
    httpx.post(f"{url}/api/v1/jobs/{job_id}/cancel", headers=H)
    gone_within(pids, 5.0)
    t.join(timeout=10)


def test_a_cancelled_kernel_service_job_stops_at_once(slow, tmp_path):
    url = slow["url"]
    tok = {"Authorization": "Bearer dev-only-pipeline-token"}
    r = httpx.post(f"{url}/api/v1/service/jobs", json={"workspace_id": "slow", "kind": "noop", "input_ref": "sleep:60", "resource_class": "cpu", "idempotency_key": "svc-sleep"}, headers=tok)
    assert r.status_code == 201, r.text
    job_id = r.json()["job_id"]
    w = Worker(url, slow["token"], tmp_path, "w-svc", plugins=None, heartbeat_s=0.5)
    t = run_in_thread(w)
    deadline = time.monotonic() + 30
    while httpx.get(f"{url}/api/v1/service/jobs/{job_id}", headers=tok).json()["state"] != "running":
        assert time.monotonic() < deadline
        time.sleep(0.05)
    httpx.post(f"{url}/api/v1/jobs/{job_id}/cancel", headers=H)
    t.join(timeout=5)
    assert not t.is_alive()
    assert httpx.get(f"{url}/api/v1/service/jobs/{job_id}", headers=tok).json()["state"] == "cancelled"
    # And a short one completes with its ref.
    r = httpx.post(f"{url}/api/v1/service/jobs", json={"workspace_id": "slow", "kind": "noop", "input_ref": "blob:in", "resource_class": "cpu", "idempotency_key": "svc-quick"}, headers=tok)
    Worker(url, slow["token"], tmp_path, "w-svc2", heartbeat_s=0.5).tick()
    assert httpx.get(f"{url}/api/v1/service/jobs/{r.json()['job_id']}", headers=tok).json() == {"state": "succeeded", "attempts": 1, "result_ref": "blob:in"}


def test_a_worker_claims_only_its_resource_classes(slow, tmp_path):
    url = slow["url"]
    tok = {"Authorization": "Bearer dev-only-pipeline-token"}
    r = httpx.post(f"{url}/api/v1/service/jobs", json={"workspace_id": "slow", "kind": "noop", "input_ref": "blob:g", "resource_class": "gpu", "idempotency_key": "svc-gpu"}, headers=tok)
    job_id = r.json()["job_id"]
    assert not Worker(url, slow["token"], tmp_path, "w-cpu", heartbeat_s=0.5).tick()  # cpu,memory by default
    assert Worker(url, slow["token"], tmp_path, "w-gpu", resource_classes=["gpu"], heartbeat_s=0.5).tick()
    assert httpx.get(f"{url}/api/v1/service/jobs/{job_id}", headers=tok).json()["state"] == "succeeded"


def test_resource_classes_come_from_the_environment(monkeypatch):
    monkeypatch.setenv(P + "API_WORKER_TOKEN", "t")
    monkeypatch.delenv(P + "WORKER_HEALTH_PORT", raising=False)
    monkeypatch.delenv(P + "WORKER_RESOURCE_CLASSES", raising=False)
    assert config.load_settings().resource_classes == ["cpu", "memory"]
    monkeypatch.setenv(P + "WORKER_RESOURCE_CLASSES", "gpu")
    assert config.load_settings().resource_classes == ["gpu"]
    monkeypatch.setenv(P + "WORKER_RESOURCE_CLASSES", "cpu,tpu")
    with pytest.raises(config.SettingsError) as e:
        config.load_settings()
    assert e.value.invalid == [P + "WORKER_RESOURCE_CLASSES"]
