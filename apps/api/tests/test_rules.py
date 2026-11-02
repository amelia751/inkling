"""todo17 D3: project rules routes (defaults from the preset, put/patch with revisions, history)."""

from __future__ import annotations

import json

from studio_api.kernel import rules as krules

from .test_files import _by_name, _new
from .test_trash import _member

PRESET_RULES = {"labels": [{"id": "lesion", "name": "Lesion", "synonyms": ["tumour"], "colour": "#ff0000", "allowedGeometries": ["polygon"], "attributes": {}}], "layout": {"maxDepth": 4}}


def _project(client, monkeypatch) -> str:
    p, _, _ = _new(client, {"study/a.png": b"\x89PNG"})
    n = _by_name(p)
    r = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Scans", "nodeIds": [n["a.png"].id], "task": {"title": "Outline", "preset": "preset:image-2d"}})
    assert r.status_code < 300, r.text
    monkeypatch.setattr(krules, "_preset_rules", lambda preset, root: json.dumps(PRESET_RULES) if preset == "image-2d" else None)
    return p


def test_defaults_come_from_the_preset(client, monkeypatch):
    p = _project(client, monkeypatch)
    out = client.get(f"/api/v1/projects/{p}/rules").json()
    assert out["revision"] == 0 and out["source"] == "preset" and out["preset"] == "image-2d"
    assert out["rules"]["labels"][0]["synonyms"] == ["tumour"] and out["rules"]["layout"]["maxDepth"] == 4
    assert client.get(f"/api/v1/projects/{p}/rules/history").json()["history"] == []


def test_without_preset_rules_the_default_is_empty_and_valid(client, monkeypatch):
    p = _project(client, monkeypatch)
    monkeypatch.setattr(krules, "_preset_rules", lambda preset, root: None)
    out = client.get(f"/api/v1/projects/{p}/rules").json()
    assert out["source"] == "default" and out["rules"]["labels"] == [] and out["rules"]["version"] == 1


def test_put_patch_stale_revision_and_history(client, monkeypatch):
    p = _project(client, monkeypatch)
    url = f"/api/v1/projects/{p}/rules"
    cur = client.get(url).json()
    new = {**cur["rules"], "datasets": {"requiredMetadata": ["modality", "license"], "uniqueNames": True}}
    r = client.put(url, json={"rules": new, "baseRevision": 0})
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 1 and r.json()["source"] == "project"
    # Stale: based on revision 0 again.
    r = client.put(url, json={"rules": new, "baseRevision": 0})
    assert r.status_code == 409 and r.json()["detail"]["revision"] == 1
    # Missing base revision.
    assert client.put(url, json={"rules": new}).status_code == 428
    # Bad shape.
    bad = client.put(url, json={"rules": {"labels": [{"id": "x"}]}, "baseRevision": 1})
    assert bad.status_code == 422
    # JSON Patch.
    r = client.patch(url, json={"baseRevision": 1, "ops": [{"op": "replace", "path": "/layout/maxDepth", "value": 6}]})
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 2 and r.json()["rules"]["layout"]["maxDepth"] == 6
    assert client.patch(url, json={"baseRevision": 1, "ops": []}).status_code == 409
    assert client.patch(url, json={"baseRevision": 2, "ops": [{"op": "remove", "path": "/nope"}]}).status_code == 422
    h = client.get(f"{url}/history").json()["history"]
    assert [x["revision"] for x in h] == [2, 1] and h[0]["actor"] == "user:local-expert"
    assert client.get(url).json()["rules"]["datasets"]["uniqueNames"] is True


def test_viewers_and_agents_cannot_edit(client, monkeypatch):
    p = _project(client, monkeypatch)
    _member(p, "viewer")
    bob = {"X-Dev-Principal": "user:bob"}
    assert client.get(f"/api/v1/projects/{p}/rules", headers=bob).status_code == 200
    assert client.put(f"/api/v1/projects/{p}/rules", json={"rules": {}, "baseRevision": 0}, headers=bob).status_code == 403
