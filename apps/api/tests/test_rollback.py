"""§14 #9: version rollback restores commands/UI (the pinned version) without deleting annotations."""

from __future__ import annotations

from .test_installer_flow import install
from .conftest import ws


def test_upgrade_then_rollback_restores_the_previous_pin_and_keeps_annotations(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg", "1.0.0")
    doc = {"revision": 0, "annotations": [{"id": "keep", "itemId": "img/a.png", "label": "x", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}, "provenance": "ai-suggested", "author": "plugin:test.seg@1.0.0", "createdAt": "2026-10-01"}]}
    c.put("/api/annotations/ws-a", json=doc, headers=ws("ws-a"))
    install(c, "ws-a", "test.seg", "1.1.0")
    pin = lambda: {p["pluginId"]: p for p in c.get("/api/v1/workspaces/ws-a/state", headers=ws("ws-a")).json()["plugins"]}["test.seg"]  # noqa: E731
    assert pin()["version"] == "1.1.0"
    r = c.post("/api/v1/workspaces/ws-a/plugins/rollback", json={"pluginId": "test.seg"}, headers=ws("ws-a")).json()
    assert r["version"] == "1.0.0" and r["state"] == "ACTIVATED"
    assert pin()["version"] == "1.0.0"
    assert [a["id"] for a in c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]] == ["keep"]
    history = [h["state"] for h in c.get("/api/v1/workspaces/ws-a/plugins", headers=ws("ws-a")).json()["history"] if h["pluginId"] == "test.seg"]
    assert history[-2:] == ["ROLLED_BACK", "ACTIVATED"]


def test_rollback_of_a_config_change(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.seg", "config": {"budgetUsdPerJob": 0.25}}, headers=ws("ws-a"))
    r = c.post("/api/v1/workspaces/ws-a/plugins/rollback", json={"pluginId": "test.seg"}, headers=ws("ws-a")).json()
    assert r["configRevision"] == 0


def test_rollback_with_no_previous_pin_disables(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    r = c.post("/api/v1/workspaces/ws-a/plugins/rollback", json={"pluginId": "test.seg"}, headers=ws("ws-a")).json()
    assert r["state"] == "DISABLED"
    assert c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a")).status_code == 403
