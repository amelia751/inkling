"""§14 #2: unapproved plugins can't invoke tools or read assets; grants are per version."""

from __future__ import annotations

from .conftest import run_worker_once, mask_result, worker_headers, ws
from .test_installer_flow import install


def test_not_installed_means_no_invocation(registry_client):
    c = registry_client()
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    assert r.status_code == 403


def test_awaiting_approval_means_no_invocation(registry_client):
    c = registry_client()
    plan = c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.seg"}, headers=ws("ws-a")).json()
    c.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws("ws-a"))
    r = c.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    assert r.status_code == 403


def test_installed_plugin_runs_through_a_worker_with_a_scoped_token(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png", "label": "x"}}, headers=ws("ws-a"))
    assert r.status_code == 202 and r.json()["job"]["state"] == "queued"
    claim, job = run_worker_once(c, mask_result())
    assert job["state"] == "succeeded" and len(job["result"]["annotationIds"]) == 1
    tok = {"Authorization": f"Bearer {claim['sessionToken']}"}
    # The plugin's token reads its own workspace's assets, nothing else, and can't invoke commands.
    assert c.get("/api/v1/assets", headers=tok).json()["assets"][0]["path"] == "img/a.png"
    assert c.get("/api/annotations/ws-b", headers=tok).status_code == 403
    assert c.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png"}}, headers=tok).status_code == 403
    assert claim["secretUseTokens"] == {}  # no secrets granted, none issued
    used = next(p for p in c.get("/api/v1/workspaces/ws-a/plugins", headers=ws("ws-a")).json()["plugins"] if p["pluginId"] == "test.seg")["permissions"]["used"]
    assert used == ["annotations.write", "assets.read"]


def test_disabled_plugin_can_not_invoke(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    c.post("/api/v1/workspaces/ws-a/plugins/disable", json={"pluginId": "test.seg"}, headers=ws("ws-a"))
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    assert r.status_code == 403


def test_worker_endpoints_need_the_worker_token(client):
    assert client.post("/api/v1/worker/claim", json={}).status_code == 401
    assert client.post("/api/v1/worker/claim", json={}, headers=worker_headers()).json() == {"job": None}
