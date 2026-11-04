"""todo25 D3/D4: preinstalled segmentation (meta.sam + grants), its backfill, and the
Studio-managed provider key in the secrets broker."""

from __future__ import annotations

import httpx
import pytest

from .conftest import SEGMENTATION, ws

META = "META_MODEL_API_KEY"
DEFAULTS = f"{SEGMENTATION}:provider=meta.sam"
GRANTS = ["network.egress:api.meta.ai", f"secrets.use:{META}"]


def _installed(c, project_id):
    return {p["pluginId"]: p for p in c.get(f"/api/v1/workspaces/{project_id}/plugins/installed", headers=ws(project_id)).json()["plugins"]}


def _state(project_id):
    from studio_api.db import session_scope
    from studio_api.plugins import installer, policy

    with session_scope() as db:
        row = installer.active(db, project_id).get(SEGMENTATION)
        if row is None:
            return None
        return {"version": row.version, "config": installer.current_config(db, project_id, SEGMENTATION), "grants": sorted(policy.granted(db, project_id, SEGMENTATION, row.version))}


def test_parse_json_and_compact():
    from studio_api.plugins import defaults

    assert [(d.plugin_id, d.config, d.grants) for d in defaults.parse(f"{SEGMENTATION}:provider=meta.sam;budgetUsdPerJob=2, x.y")] == [(SEGMENTATION, {"provider": "meta.sam", "budgetUsdPerJob": "2"}, None), ("x.y", {}, None)]
    js = defaults.parse(f'[{{"pluginId": "{SEGMENTATION}", "config": {{"provider": "mock"}}, "grants": []}}]')
    assert js[0].config == {"provider": "mock"} and js[0].grants == []
    assert defaults.parse("") == []


def test_new_project_has_segmentation_with_meta_sam_and_its_grants(make_client):
    client = make_client(default_plugins=DEFAULTS)
    p = client.post("/api/v1/projects", json={"title": "Chest"}).json()
    st = _state(p["id"])
    assert st is not None, "segmentation is active in a new project"
    assert st["config"]["provider"] == "meta.sam"
    assert set(GRANTS) <= set(st["grants"])
    acts = [e["action"] for e in client.get("/api/v1/audit", headers=ws(p["id"])).json()["entries"]]
    assert "plugins.default" in acts and "plugins.activated" in acts


def test_the_shipped_default_is_segmentation_on_meta_sam():
    from studio_api import config
    from studio_api.plugins import defaults

    d = defaults.parse(config.Settings.model_fields["default_plugins"].default)
    assert [(x.plugin_id, x.config) for x in d] == [(SEGMENTATION, {"provider": "meta.sam"})]


def test_no_defaults_when_configured_empty(make_client):
    c = make_client(default_plugins="")
    p = c.post("/api/v1/projects", json={"title": "Bare"}).json()
    assert _state(p["id"]) is None


def test_backfill_is_idempotent_and_keeps_a_disabled_plugin_disabled(make_client):
    from studio_api.db import session_scope
    from studio_api.plugins import defaults

    c = make_client(default_plugins="")
    a = c.post("/api/v1/projects", json={"title": "Old A"}).json()["id"]
    b = c.post("/api/v1/projects", json={"title": "Old B"}).json()["id"]
    wanted = defaults.parse(f"{SEGMENTATION}:provider=meta.sam")
    with session_scope() as db:
        first = defaults.backfill(db, wanted)
    assert first[a] == {SEGMENTATION: "activated"} and first[b] == {SEGMENTATION: "activated"}
    assert _state(a)["config"]["provider"] == "meta.sam"
    assert c.post(f"/api/v1/workspaces/{b}/plugins/disable", json={"pluginId": SEGMENTATION}, headers=ws(b)).status_code == 200
    with session_scope() as db:
        again = defaults.backfill(db, wanted)
    assert again[a] == {SEGMENTATION: "present"} and again[b] == {SEGMENTATION: "present"}
    assert _state(b) is None  # still disabled


def test_an_existing_project_gets_the_defaults_when_its_capabilities_are_read(make_client):
    from studio_api import config

    c = make_client(default_plugins="")
    old = c.post("/api/v1/projects", json={"title": "Before"}).json()["id"]
    off = c.post("/api/v1/projects", json={"title": "Turned off"}).json()["id"]
    assert _state(old) is None
    prev = config.settings()
    try:
        config.set_settings(prev.model_copy(update={"default_plugins": DEFAULTS}))
        caps = c.get(f"/api/v1/workspaces/{old}/capabilities", headers=ws(old)).json()["capabilities"]
        assert any(r["capability"] == "image.segment" and r["pluginId"] == SEGMENTATION for r in caps)
        assert _state(old)["config"]["provider"] == "meta.sam"
        assert c.get(f"/api/v1/workspaces/{off}/capabilities", headers=ws(off)).status_code == 200
        assert c.post(f"/api/v1/workspaces/{off}/plugins/disable", json={"pluginId": SEGMENTATION}, headers=ws(off)).status_code == 200
        c.get(f"/api/v1/workspaces/{off}/capabilities", headers=ws(off))
        assert _state(off) is None  # a plugin someone turned off stays off
    finally:
        config.set_settings(prev)


def test_a_skipped_default_is_not_retried_on_every_read(make_client):
    from studio_api import config

    c = make_client(default_plugins="")
    p = c.post("/api/v1/projects", json={"title": "Missing"}).json()["id"]
    prev = config.settings()
    try:
        config.set_settings(prev.model_copy(update={"default_plugins": "studio.no-such-plugin"}))
        for _ in range(3):
            assert c.get(f"/api/v1/workspaces/{p}/capabilities", headers=ws(p)).status_code == 200
        acts = [e["action"] for e in c.get("/api/v1/audit", headers=ws(p)).json()["entries"]]
        assert acts.count("plugins.default_skipped") == 1
    finally:
        config.set_settings(prev)


# ---- The managed key (D4) ---------------------------------------------------------------------


def _token(project_id, version):
    from studio_api.kernel import secrets

    return secrets.issue_use_token(project_id, SEGMENTATION, version, META, ["api.meta.ai"], "job-1")


def _echo():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json={"ok": True})

    return httpx.MockTransport(handler), seen


def _proxy(project_id, version):
    from studio_api.db import session_scope
    from studio_api.kernel import secrets

    transport, seen = _echo()
    with session_scope() as db:
        r = secrets.proxy(db, _token(project_id, version), "POST", "https://api.meta.ai/v1/responses", body=b"{}", transport=transport)
    return r, seen


def _audit(c, project_id):
    return [e for e in c.get("/api/v1/audit", headers=ws(project_id)).json()["entries"] if e["action"].startswith("secrets.managed")]


def test_broker_uses_the_managed_key_when_allowed_and_audits(make_client):
    c = make_client(default_plugins=DEFAULTS, provider_key_meta="managed-key")
    p = c.post("/api/v1/projects", json={"title": "Managed"}).json()["id"]
    r, seen = _proxy(p, _state(p)["version"])
    assert r.status_code == 200 and seen["auth"] == "Bearer managed-key"
    entries = _audit(c, p)
    assert [e["action"] for e in entries] == ["secrets.managed_use"]
    assert "managed-key" not in str(entries)


def test_project_key_wins_over_the_managed_key(make_client):
    c = make_client(default_plugins=DEFAULTS, provider_key_meta="managed-key")
    p = c.post("/api/v1/projects", json={"title": "Own key"}).json()["id"]
    assert c.put(f"/api/v1/secrets/{META}", json={"value": "own-key"}, headers=ws(p)).status_code == 204
    r, seen = _proxy(p, _state(p)["version"])
    assert seen["auth"] == "Bearer own-key" and _audit(c, p) == []


def test_disallowed_org_gets_a_clear_error_and_an_audit_entry(make_client):
    from fastapi import HTTPException

    c = make_client(default_plugins=DEFAULTS, provider_key_meta="managed-key")
    p = c.post("/api/v1/projects", json={"title": "Off"}).json()["id"]
    assert c.patch("/api/v1/org", json={"managedProviderKeys": False}, headers=ws(p)).json()["managedProviderKeys"] is False
    with pytest.raises(HTTPException) as e:
        _proxy(p, _state(p)["version"])
    assert e.value.status_code == 403 and "Studio-managed provider keys" in e.value.detail
    assert [x["action"] for x in _audit(c, p)] == ["secrets.managed_refused"]


def test_without_a_managed_key_a_missing_secret_is_still_404(make_client):
    from fastapi import HTTPException

    c = make_client(default_plugins=DEFAULTS)
    p = c.post("/api/v1/projects", json={"title": "None"}).json()["id"]
    with pytest.raises(HTTPException) as e:
        _proxy(p, _state(p)["version"])
    assert e.value.status_code == 404


def test_managed_keys_default_off_in_production():
    from studio_api import config
    from studio_api.kernel import secrets
    from studio_api.models import Organization

    prev = config.settings()
    try:
        config.set_settings(prev.model_copy(update={"env": "production"}))
        assert secrets.org_allows_managed_keys(None) is False
        assert secrets.org_allows_managed_keys(Organization(id="o", name="o", kind="team", managed_provider_keys=True)) is True
    finally:
        config.set_settings(prev)


def test_builtin_mock_segment_is_refused_in_production():
    from studio_api import config

    hints = config._check_production({"builtin_mock_segment": "1", "auth_mode": "workos", "blob_store": "gcs", "database_url": "postgresql://x"}, [], [])
    assert any("BUILTIN_MOCK_SEGMENT" in h for h in hints)
