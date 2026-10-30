"""§14 #1: installing a plugin in workspace A doesn't expose it in workspace B."""

from __future__ import annotations

from .test_installer_flow import install
from .conftest import ws


def test_install_is_per_workspace(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    a = {p["pluginId"] for p in c.get("/api/v1/workspaces/ws-a/state", headers=ws("ws-a")).json()["plugins"] if p["state"] == "ACTIVATED"}
    b = {p["pluginId"] for p in c.get("/api/v1/workspaces/ws-b/state", headers=ws("ws-b")).json()["plugins"] if p["state"] == "ACTIVATED"}
    assert "test.seg" in a and "test.seg" not in b
    # B can't invoke it either.
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/b.png"}}, headers=ws("ws-b"))
    assert r.status_code == 403


def test_session_tokens_are_bound_to_their_workspace(client):
    tok = client.post("/api/v1/sessions", json={"scopes": ["assets.read"]}, headers=ws("ws-a")).json()["token"]
    auth = {"Authorization": f"Bearer {tok}"}
    assert client.get("/api/v1/assets", headers=auth).json()["assets"][0]["path"] == "img/a.png"
    assert client.get("/api/v1/assets", headers={**auth, "X-Workspace-Id": "ws-b"}).status_code == 403
    assert client.get("/api/annotations/ws-b", headers=auth).status_code == 403
    # Scopes only shrink: this token can't invoke commands or mint tokens.
    assert client.post("/api/v1/commands", json={"capability": "image.segment", "input": {}}, headers=auth).status_code == 403
    assert client.post("/api/v1/sessions", json={"scopes": ["*"]}, headers=auth).status_code == 403


def test_assets_and_annotations_are_scoped(client):
    client.put("/api/annotations/ws-a", json={"revision": 0, "annotations": []}, headers=ws("ws-a"))
    assert [a["path"] for a in client.get("/api/v1/assets", headers=ws("ws-b")).json()["assets"]] == ["img/b.png"]
