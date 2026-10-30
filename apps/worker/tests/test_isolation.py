"""§14 #6: a plugin timeout, crash or bad output fails its own job; the kernel keeps serving."""

from __future__ import annotations

import threading

import httpx

from studio_worker.main import Worker

from .conftest import install


def run(stack, tmp_path, tool, wid):
    url, h = stack["url"], {"X-Workspace-Id": "iso"}
    r = httpx.post(f"{url}/api/v1/commands", json={"tool": f"test.bad.{tool}", "input": {"asset_id": "img/a.png"}}, headers=h)
    assert r.status_code == 202, r.text
    Worker(url, stack["token"], tmp_path, wid, plugins=["test.bad"]).tick()
    return httpx.get(f"{url}/api/v1/jobs/{r.json()['job']['jobId']}", headers=h).json()


def test_timeout_crash_and_garbage_fail_only_their_jobs(stack, tmp_path):
    install(stack["url"], "iso", "test.bad")
    health: list[int] = []
    stop = threading.Event()

    def ping():
        while not stop.is_set():
            health.append(httpx.get(f"{stack['url']}/api/v1/health", timeout=5).status_code)
            stop.wait(0.2)

    t = threading.Thread(target=ping)
    t.start()
    try:
        hung = run(stack, tmp_path, "hang", "w-hang")
        crashed = run(stack, tmp_path, "crash", "w-crash")
        garbage = run(stack, tmp_path, "garbage", "w-garbage")
    finally:
        stop.set()
        t.join()
    assert hung["state"] == "failed" and "timed out" in hung["error"] and hung["recoverable"]
    assert crashed["state"] == "failed" and "exited with 3" in crashed["error"]
    assert garbage["state"] == "failed" and "invalid" in garbage["error"] and garbage["recoverable"]
    assert health and set(health) == {200}
    assert httpx.get(f"{stack['url']}/api/annotations/iso", headers={"X-Workspace-Id": "iso"}).json()["annotations"] == []
