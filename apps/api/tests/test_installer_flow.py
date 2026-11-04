"""§7.2 install state machine: plan → stage → validate → approve → ACTIVATED, then configure, disable."""

from __future__ import annotations

from .conftest import ws


def install(c, workspace, plugin, version=None, grant=None):
    plan = c.post(f"/api/v1/workspaces/{workspace}/plugins/plan", json={"pluginId": plugin, **({"version": version} if version else {})}, headers=ws(workspace)).json()
    assert plan["state"] == "RESOLVED", plan
    staged = c.post(f"/api/v1/workspaces/{workspace}/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws(workspace)).json()
    assert staged["state"] == "AWAITING_APPROVAL", staged
    return c.post(f"/api/v1/workspaces/{workspace}/plugins/approve", json={"requestId": plan["requestId"], "grantOptional": grant or []}, headers=ws(workspace)).json()


def test_plan_shows_the_diff_and_approval_activates(registry_client):
    c = registry_client()
    plan = c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.seg"}, headers=ws("ws-a")).json()
    items = {i["id"]: i for i in plan["plan"]["install"]}
    assert set(items) == {"test.seg", "test.viewer"} and plan["plan"]["risk"] == "high"
    seg = items["test.seg"]
    assert seg["version"] == "1.1.0"  # highest satisfying
    assert seg["permissions"]["required"] == ["assets.read", "annotations.write"]
    assert seg["egress"] == ["api.segment.test"] and seg["secrets"] == ["SEG_API_KEY"]
    assert seg["uiSurfaces"] == ["image.viewer.toolbar"] and seg["newCode"] is True
    assert {p["id"] for p in seg["providers"]} == {"mock", "hosted.sam"}
    out = install(c, "ws-a", "test.seg")
    assert out["state"] == "ACTIVATED"
    state = c.get("/api/v1/workspaces/ws-a/state", headers=ws("ws-a")).json()
    pinned = {p["pluginId"]: p for p in state["plugins"]}
    assert pinned["test.seg"]["state"] == "ACTIVATED" and pinned["test.seg"]["version"] == "1.1.0" and pinned["test.seg"]["artifactDigest"].startswith("sha256:")
    assert pinned["test.viewer"]["state"] == "ACTIVATED"


def test_tampered_package_is_rejected_at_stage(registry_client, tmp_path):
    c = registry_client()
    (tmp_path / "repo" / "plugins" / "seg11" / "evil.py").write_text("import os")
    plan = c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.seg"}, headers=ws("ws-a")).json()
    staged = c.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws("ws-a")).json()
    assert staged["state"] == "REJECTED" and "digest mismatch" in str(staged["checks"])


def test_streamlined_activation_needs_low_risk(registry_client):
    c = registry_client()
    plan = c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.seg"}, headers=ws("ws-a")).json()
    c.post("/api/v1/workspaces/ws-a/plugins/stage", json={"requestId": plan["requestId"]}, headers=ws("ws-a"))
    r = c.post("/api/v1/workspaces/ws-a/plugins/activate", json={"requestId": plan["requestId"]}, headers=ws("ws-a"))
    assert r.status_code == 409  # new code and permissions: needs approval


def test_provider_switch_needs_its_permissions(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    r = c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.seg", "config": {"provider": "hosted.sam"}}, headers=ws("ws-a"))
    assert r.status_code == 409 and "network.egress:api.segment.test" in str(r.json())
    g = c.post("/api/v1/workspaces/ws-a/plugins/grant", json={"pluginId": "test.seg", "permissions": ["network.egress:api.segment.test", "secrets.use:SEG_API_KEY"]}, headers=ws("ws-a"))
    assert g.status_code == 200
    ok = c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.seg", "config": {"provider": "hosted.sam"}}, headers=ws("ws-a")).json()
    assert ok["config"]["provider"] == "hosted.sam" and ok["configRevision"] == 1
    bad = c.post("/api/v1/workspaces/ws-a/plugins/grant", json={"pluginId": "test.seg", "permissions": ["network.egress:evil.test"]}, headers=ws("ws-a"))
    assert bad.status_code == 422  # only requested permissions can be granted


def test_installed_listing_keeps_requested_granted_used_apart(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    p = next(x for x in c.get("/api/v1/workspaces/ws-a/plugins", headers=ws("ws-a")).json()["plugins"] if x["pluginId"] == "test.seg")
    assert p["permissions"]["requested"]["optional"] == ["network.egress:api.segment.test", "secrets.use:SEG_API_KEY"]
    assert p["permissions"]["granted"] == ["annotations.write", "assets.read"] and p["permissions"]["used"] == []


def test_disable_refuses_while_a_dependent_is_active(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    r = c.post("/api/v1/workspaces/ws-a/plugins/disable", json={"pluginId": "test.viewer"}, headers=ws("ws-a"))
    assert r.status_code == 409 and "test.seg" in str(r.json())


def test_catalog_search(registry_client):
    c = registry_client()
    hits = c.get("/api/v1/plugins", params={"capability": "image.segment"}).json()["plugins"]
    assert [h["id"] for h in hits] == ["test.seg"] and hits[0]["version"] == "1.1.0"
    assert c.get("/api/v1/plugins/test.seg").json()["versions"] == ["1.0.0", "1.1.0"]


def _research_registry(tmp_path):
    from .conftest import manifest, write_registry

    research = manifest(
        "test.research",
        capabilities=[{"id": "image.segment", "tool": "segment_objects", "mediaTypes": ["image/png"]}],
        runtime={"kind": "python-worker", "entrypoint": "fake_plugin.tools:register", "maxExecutionSeconds": 30, "concurrency": 1},
        providers=[
            {"id": "mock", "implements": ["image.segment"], "hosting": "mock"},
            {"id": "local.medsam2", "implements": ["image.segment"], "hosting": "self-hosted", "egress": ["medsam.test"], "modelLicense": "MedSAM2: research and education use only", "quality": {"metric": "dice", "mean": 0.91, "images": 4, "fixtures": "montgomery", "evaluatedAt": "2026-11-04"}},
        ],
        permissions={"required": ["assets.read"], "optional": ["network.egress:medsam.test"]},
    )
    return write_registry(tmp_path / "rr", [("research", research, {"uv.lock": "# locked\n"})])


def test_research_only_weights_need_a_research_org(make_client, tmp_path):
    """todo25 W7: a provider whose weights are research-only is selectable only in a research org."""
    from studio_api import db
    from studio_api.models import Organization, ProjectRow

    c = make_client(registry_dir=_research_registry(tmp_path))
    plan = c.post("/api/v1/workspaces/ws-a/plugins/plan", json={"pluginId": "test.research"}, headers=ws("ws-a")).json()
    (item,) = plan["plan"]["install"]
    prov = {p["id"]: p for p in item["providers"]}
    assert prov["local.medsam2"]["researchOnly"] is True and prov["mock"]["researchOnly"] is False
    assert prov["local.medsam2"]["quality"]["mean"] == 0.91  # the try-before-keep score, shown in the review
    assert install(c, "ws-a", "test.research", grant=["network.egress:medsam.test"])["state"] == "ACTIVATED"
    r = c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.research", "config": {"provider": "local.medsam2"}}, headers=ws("ws-a"))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "provider_licence_research_only"
    with db.session_scope() as s:
        org = s.get(Organization, s.get(ProjectRow, "ws-a").org_id)
        org.research = True
    ok = c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.research", "config": {"provider": "local.medsam2"}}, headers=ws("ws-a"))
    assert ok.status_code == 200 and ok.json()["config"]["provider"] == "local.medsam2"


def test_licence_classification():
    from studio_api.plugins.policy import licence_restricted

    for text in ("CC-BY-NC-SA 4.0", "cc by-nc 4.0", "research and development only", "MedSAM2: research and education use only", "Non-commercial use"):
        assert licence_restricted(text), text
    for text in (None, "", "Apache-2.0", "SAM License (Meta; not an OSI licence)", "AGPL-3.0", "CC-BY-4.0"):
        assert not licence_restricted(text), text
