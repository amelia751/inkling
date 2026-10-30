"""§14 #11: dependency conflicts are surfaced rather than silently rewriting another plugin."""

from __future__ import annotations

from .test_installer_flow import install
from .conftest import ws


def test_conflict_with_an_active_dependency_is_surfaced(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")  # activates test.viewer 1.0.0
    plan = c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.needs2"}, headers=ws("ws-a")).json()
    assert plan["state"] == "REJECTED"
    conflict = plan["plan"]["conflicts"][0]
    assert conflict["plugin"] == "test.viewer" and conflict["active"] == "1.0.0" and conflict["required"] == "^2"
    # Nothing was rewritten: test.viewer is still 1.0.0 and active.
    pinned = {p["pluginId"]: p for p in c.get("/api/v1/workspaces/ws-a/state", headers=ws("ws-a")).json()["plugins"]}
    assert pinned["test.viewer"]["version"] == "1.0.0" and pinned["test.viewer"]["state"] == "ACTIVATED"


def test_without_the_conflict_the_newer_dependency_is_chosen(registry_client):
    c = registry_client()
    plan = c.post("/api/v1/workspaces/ws-b/plugins/plan", json={"pluginId": "test.needs2"}, headers=ws("ws-b")).json()
    assert plan["state"] == "RESOLVED"
    assert {(i["id"], i["version"]) for i in plan["plan"]["install"]} == {("test.needs2", "1.0.0"), ("test.viewer", "2.0.0")}


def test_unknown_plugins_and_versions(registry_client):
    c = registry_client()
    assert c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.nope"}, headers=ws("ws-a")).json()["state"] == "REJECTED"
    p = c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.seg", "version": "^9"}, headers=ws("ws-a")).json()
    assert p["state"] == "REJECTED" and p["plan"]["errors"][0]["code"] == "no-version"
