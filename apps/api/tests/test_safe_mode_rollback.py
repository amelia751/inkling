"""todo10 Phase 4: last-known-good (moved by a person or by passing checks), one-transaction
rollback of environment and plugin pins, and the hash-chained audit. No model, no versioning."""

from __future__ import annotations

from studio_api.kernel.canonical import content_hash

from .conftest import ws, at_rev
from .test_installer_flow import install

ENV1 = {"extends": "preset:image-2d", "task": "classification", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "cat"}]}]}
BROKEN = {**ENV1, "viewports": [{"name": "main", "renderer": "test.viewer.does-not-exist"}]}
H = ws("ws-a")


def lock(c):
    return c.get("/api/environments/ws-a/lockfile", headers=H).json()


def agent(c, run="run_9"):
    tok = c.post("/api/v1/sessions", json={"agent": "builder", "scopes": ["assets.read"]}, headers=H).json()["token"]
    return {"Authorization": f"Bearer {tok}", "X-Agent-Run": run}


def test_known_good_moves_by_a_person_or_by_passing_checks_never_by_the_agent(registry_client):
    c = registry_client()
    assert c.get("/api/environments/ws-a/last-known-good", headers=H).status_code == 404
    r1 = c.put("/api/environments/ws-a", json={**at_rev(c, "ws-a", H), "environment": ENV1}, headers=H).json()
    # A clean boot of a person's revision moves it.
    ok = c.post("/api/environments/ws-a/checks", json={"revision": 1, "contentHash": r1["contentHash"], "ok": True}, headers=H).json()
    assert ok["moved"] and ok["knownGood"]["movedBecause"] == "checks" and ok["knownGood"]["contentHash"] == content_hash(ENV1)
    assert ok["knownGood"]["lockfileHash"] == lock(c)["contentHash"]
    # An agent's change: booting it doesn't make it known good; the agent can't either.
    a = agent(c)
    r2 = c.patch("/api/environments/ws-a", json={**at_rev(c, "ws-a", a), "patch": [{"op": "replace", "path": "/task", "value": "detection"}]}, headers=a)
    assert r2.status_code == 200 and r2.json()["authorKind"] == "agent"
    no = c.post("/api/environments/ws-a/checks", json={"revision": 2, "contentHash": r2.json()["contentHash"], "ok": True}, headers=H).json()
    assert no["moved"] is False and "agent" in no["reason"]
    assert c.put("/api/environments/ws-a/last-known-good", json={"revision": 2}, headers=a).status_code == 403
    assert c.post("/api/environments/ws-a/checks", json={"revision": 2, "ok": True}, headers=a).status_code == 403
    assert c.post("/api/environments/ws-a/rollback", headers=a).status_code == 403
    assert c.get("/api/environments/ws-a/last-known-good", headers=H).json()["revision"] == 1
    # A person approves it.
    yes = c.put("/api/environments/ws-a/last-known-good", json={"revision": 2}, headers=H).json()
    assert yes["moved"] and yes["knownGood"]["movedBecause"] == "person" and yes["authorKind"] == "agent"
    # Only the current setup can be marked; a stale boot report is ignored.
    assert c.put("/api/environments/ws-a/last-known-good", json={"revision": 1}, headers=H).status_code == 409
    assert c.post("/api/environments/ws-a/checks", json={"revision": 2, "contentHash": "sha256:" + "0" * 64, "ok": True}, headers=H).json()["moved"] is False


def test_checks_never_bless_a_plugin_that_widens_permissions(registry_client):
    c = registry_client()
    c.put("/api/environments/ws-a", json={**at_rev(c, "ws-a", H), "environment": ENV1}, headers=H)
    assert c.put("/api/environments/ws-a/last-known-good", json={}, headers=H).json()["moved"]
    install(c, "ws-a", "test.seg", "1.0.0")
    r = c.post("/api/environments/ws-a/checks", json={"revision": 1, "ok": True}, headers=H).json()
    assert r["moved"] is False and "new plugin test.seg" in r["reason"]
    assert c.get("/api/environments/ws-a/last-known-good", headers=H).json()["lockfileHash"] != lock(c)["contentHash"]


def test_rollback_restores_environment_and_pins_in_one_transaction_with_a_chained_audit(registry_client):
    c = registry_client()
    good = c.put("/api/environments/ws-a", json={**at_rev(c, "ws-a", H), "environment": ENV1}, headers=H).json()
    kg = c.put("/api/environments/ws-a/last-known-good", json={}, headers=H).json()["knownGood"]
    # A plugin is installed and the environment changed to use something that doesn't load.
    install(c, "ws-a", "test.seg", "1.0.0")
    c.put("/api/environments/ws-a", json={**at_rev(c, "ws-a", H), "environment": BROKEN}, headers=H)
    assert "test.seg" in [p["id"] for p in lock(c)["lockfile"]["plugins"]]
    r = c.post("/api/environments/ws-a/rollback", headers=H)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["contentHash"] == good["contentHash"] and out["revision"] == 3
    assert set(out["plugins"]["disabled"]) == {"test.seg", "test.viewer"} and out["lockfileHash"] == kg["lockfileHash"]
    cur = c.get("/api/environments/ws-a", headers=H).json()
    assert cur["environment"] == ENV1 and cur["contentHash"] == kg["contentHash"]
    assert lock(c)["contentHash"] == kg["lockfileHash"]
    # The rollback is a new revision with a parent (nothing is rewritten) and is in the audit chain.
    hist = c.get("/api/environments/ws-a/history", headers=H).json()
    assert [h["revision"] for h in hist] == [1, 2, 3] and hist[-1]["parentHash"] == content_hash(BROKEN)
    chain = c.get("/api/environments/ws-a/audit", headers=H).json()
    assert chain["ok"] and chain["head"] == out["audit"]["hash"] and chain["entries"][0]["action"] == "studio.rollback"
    # Rolling back again changes nothing but is still recorded.
    again = c.post("/api/environments/ws-a/rollback", headers=H).json()
    assert again["revision"] is None and again["plugins"]["disabled"] == [] and again["audit"]["prev"] == out["audit"]["hash"]


def test_a_tampered_audit_entry_breaks_the_chain(registry_client):
    c = registry_client()
    c.put("/api/environments/ws-a", json={**at_rev(c, "ws-a", H), "environment": ENV1}, headers=H)
    c.put("/api/environments/ws-a/last-known-good", json={}, headers=H)
    c.post("/api/environments/ws-a/rollback", headers=H)
    assert c.get("/api/environments/ws-a/audit", headers=H).json()["ok"]
    from sqlalchemy import select, update

    from studio_api import db as kdb
    from studio_api.models import PluginAudit

    with kdb.session_scope() as s:
        first = s.scalars(select(PluginAudit).where(PluginAudit.workspace_id == "ws-a", PluginAudit.entry_hash.is_not(None)).order_by(PluginAudit.id)).first()
        s.execute(update(PluginAudit).where(PluginAudit.id == first.id).values(action="plugins.nothing-to-see"))
    bad = c.get("/api/environments/ws-a/audit", headers=H).json()
    assert bad["ok"] is False and bad["brokenAt"] == first.id


def test_rollback_needs_a_known_good_setup(registry_client):
    c = registry_client()
    assert c.post("/api/environments/ws-a/rollback", headers=H).status_code == 404
