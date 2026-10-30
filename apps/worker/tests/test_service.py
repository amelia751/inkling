"""todo/todo3.md E.2/E.4 for the worker: env config, probes, prebuilt envs, graceful SIGTERM."""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import httpx
import pytest

from studio_worker import config, health
from studio_worker.main import Worker, bundled_python_plugins, env_name

from .conftest import REPO, install

P = config.naming()["envPrefix"]


def test_settings_fail_fast_with_key_names(monkeypatch):
    monkeypatch.delenv(P + "API_WORKER_TOKEN", raising=False)
    monkeypatch.setenv(P + "WORKER_HEALTH_PORT", "not-a-port")
    with pytest.raises(config.SettingsError) as e:
        config.load_settings()
    assert e.value.missing == [P + "API_WORKER_TOKEN"] and e.value.invalid == [P + "WORKER_HEALTH_PORT"]
    assert "not-a-port" not in str(e.value)


def test_settings_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv(P + "API_WORKER_TOKEN", "t")
    monkeypatch.setenv(P + "KERNEL_URL", "http://api:8000/")
    monkeypatch.setenv(P + "WORKER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv(P + "WORKER_ENVS_DIR", "/opt/envs")
    monkeypatch.setenv(P + "WORKER_BUILD_ENVS", "0")
    monkeypatch.setenv(P + "WORKER_PLUGINS", "a.b, c.d")
    s = config.load_settings()
    assert (s.kernel_url, s.token, s.data_dir, s.envs_dir, s.build_envs, s.plugins, s.health_port) == ("http://api:8000", "t", tmp_path, Path("/opt/envs"), False, ["a.b", "c.d"], 8081)
    assert config.load_settings(worker_id=None, plugins=None).plugins == ["a.b", "c.d"]  # unset CLI flags don't override env


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def test_probe_server():
    state = {"ready": True}
    port = free_port()
    srv = health.serve(port, host="127.0.0.1", version={"service": "worker", "version": "0.1.0", "gitSha": "abc"}, ready=lambda: (state["ready"], {"kernel": "ok"}))
    try:
        base = f"http://127.0.0.1:{port}"
        assert httpx.get(base + "/healthz").json() == {"status": "ok"}
        assert httpx.get(base + "/readyz").status_code == 200
        state["ready"] = False
        assert httpx.get(base + "/readyz").status_code == 503
        assert httpx.get(base + "/version").json()["gitSha"] == "abc"
    finally:
        srv.shutdown()


def test_kernel_probe(stack):
    assert health.KernelProbe(stack["url"])()
    assert not health.KernelProbe("http://127.0.0.1:9")()


def test_bundled_plugins_and_prebuilt_envs(tmp_path):
    found = bundled_python_plugins(REPO)
    assert any(d.name == "segmentation" for _, _, d in found)
    pid, version, d = next(p for p in found if p[2].name == "segmentation")
    assert bundled_python_plugins(REPO, ["segmentation"]) == bundled_python_plugins(REPO, [pid]) == [(pid, version, d)]
    name = env_name(pid, version, d)
    assert name == env_name(pid, version, d) and name.startswith(f"{pid}@{version}-")
    w = Worker("http://127.0.0.1:9", "t", tmp_path / "data", "w", envs_dir=tmp_path / "ro-envs", build_envs=False)
    with pytest.raises(RuntimeError, match="prepare-envs"):
        w.ensure_env(d, pid, version)
    py = tmp_path / "ro-envs" / name / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text("")
    assert w.ensure_env(d, pid, version) == py


def test_no_claims_after_sigterm(tmp_path):
    w = Worker("http://127.0.0.1:9", "t", tmp_path, "w")
    w.request_stop()
    assert w.tick() is False  # returns before any kernel call
    assert w.run_forever(poll_s=0.01) == 0


def test_a_job_outliving_the_grace_period_is_handed_back(stack, tmp_path):
    url, h = stack["url"], {"X-Workspace-Id": "iso"}
    install(url, "iso", "test.bad")
    job_id = httpx.post(f"{url}/api/v1/commands", json={"tool": "test.bad.hang", "input": {"asset_id": "img/a.png"}}, headers=h).json()["job"]["jobId"]
    w = Worker(url, stack["token"], tmp_path, "w-grace", plugins=["test.bad"], shutdown_grace_s=0.2)
    t = threading.Thread(target=w.tick)
    t.start()
    try:
        for _ in range(200):
            if w.busy and httpx.get(f"{url}/api/v1/jobs/{job_id}", headers=h).json()["state"] == "running":
                break
            time.sleep(0.05)
        w.request_stop()
        t.join(timeout=20)
        job = httpx.get(f"{url}/api/v1/jobs/{job_id}", headers=h).json()
        assert job["state"] == "queued" and job["attempts"] == 0, job
    finally:
        httpx.post(f"{url}/api/v1/jobs/{job_id}/cancel", headers=h)  # keep the shared stack clean
