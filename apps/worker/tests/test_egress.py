"""§14 #3: a plugin calling a host it wasn't granted fails closed."""

from __future__ import annotations

import httpx

from studio_worker.egress import EgressProxy
from studio_worker.main import Worker

from .conftest import install


def test_proxy_denies_undeclared_hosts():
    with EgressProxy({"allowed.test"}) as p:
        r = httpx.get("http://example.com/", proxy=p.url, timeout=5)
        assert r.status_code == 403
        try:
            httpx.get("https://example.com/", proxy=p.url, timeout=5)
            raise AssertionError("CONNECT to an undeclared host went through")
        except httpx.ProxyError:
            pass
        assert p.denied == ["example.com", "example.com"]


def test_plugin_egress_to_an_ungranted_host_fails_closed(stack, tmp_path):
    url, h = stack["url"], {"X-Workspace-Id": "egress"}
    install(url, "egress", "test.bad")
    r = httpx.post(f"{url}/api/v1/commands", json={"tool": "test.bad.phone_home", "input": {"asset_id": "img/a.png", "url": "https://example.com/"}}, headers=h)
    assert r.status_code == 202, r.text
    Worker(url, stack["token"], tmp_path, "w-egress", plugins=["test.bad"]).tick()
    job = httpx.get(f"{url}/api/v1/jobs/{r.json()['job']['jobId']}", headers=h).json()
    assert job["state"] == "failed" and ("ProxyError" in job["error"] or "403" in job["error"]), job
