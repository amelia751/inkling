"""todo14 Milestone 1: samples are opt-in private copies that share the template's bytes."""

from __future__ import annotations

import json

import pytest

from studio_api import db as kdb
from studio_api.kernel import projects, samples
from studio_api.models import Asset

from .conftest import png, ws

CAROL = {"X-Dev-Principal": "user:carol"}
DAVE = {"X-Dev-Principal": "user:dave"}
ANN = {"id": "x", "itemId": "img/a.png", "label": "l", "provenance": "human-created", "author": "me", "createdAt": "2026-11-01T00:00:00Z", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}}


@pytest.fixture
def client(make_client, seed):
    """The product's rule (no Samples maintainers), plus one restricted template."""
    manifest = json.loads((seed / "manifest.json").read_text())
    manifest["projects"].append({"id": "ws-r", "title": "R", "license": "dev only", "restricted": True, "assets": [{"path": "img/b.png"}]})
    manifest["projects"].append({"id": "ws-soon", "title": "Soon", "status": "coming-soon", "assets": []})
    manifest["projects"][0]["license"] = "CC BY 4.0"
    (seed / "manifest.json").write_text(json.dumps(manifest))
    return make_client(sample_editors=())


def take(c, sample="ws-a", headers=CAROL, **body):
    r = c.post("/api/v1/projects/from-sample", json={"sampleId": sample, **body}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def test_the_picker_lists_available_templates(client, monkeypatch):
    r = client.get("/api/v1/samples", headers=CAROL).json()
    assert r["enabled"] is True
    assert [s["id"] for s in r["samples"]] == ["ws-a", "ws-b", "ws-r"]
    a = r["samples"][0]
    assert a == {"id": "ws-a", "title": "A", "modality": None, "license": "CC BY 4.0", "restricted": False}
    # Restricted templates are offered only in dev.
    monkeypatch.setattr(samples, "dev_mode", lambda: False)
    assert [s["id"] for s in client.get("/api/v1/samples").json()["samples"]] == ["ws-a", "ws-b"]
    assert client.post("/api/v1/projects/from-sample", json={"sampleId": "ws-r"}, headers=CAROL).status_code == 404


def test_a_copy_lands_in_the_callers_org_and_nobody_elses(client):
    p = take(client)
    assert p["id"].startswith("prj-") and p["id"] != "ws-a"
    assert p["sample"] is True and p["sampleOf"] == "ws-a" and p["license"] == "CC BY 4.0" and p["restricted"] is False
    assert p["orgId"] == projects.personal_org_id("user:carol") and p["role"] == "owner" and p["title"] == "A"
    assert [x["id"] for x in client.get("/api/v1/projects", headers=CAROL).json()["projects"]] == [p["id"]]
    # Another person: the copy doesn't exist for them.
    for url in (f"/api/v1/projects/{p['id']}", f"/api/v1/projects/{p['id']}/sources", f"/api/v1/tasks/{p['id']}/document"):
        assert client.get(url, headers=DAVE).status_code == 404, url
    assert client.get("/api/v1/projects", headers=DAVE).json()["projects"] == []
    # A second copy gets a numbered title.
    assert take(client)["title"] == "A (2)"
    # Audited, with the template.
    entries = client.get("/api/v1/audit", params={"action": "project.created"}, headers={**CAROL, **ws(p["id"])}).json()["entries"]
    assert any((e.get("after") or {}).get("sampleOf") == "ws-a" for e in entries), entries


def test_labels_on_a_copy_are_its_own(client):
    mine, theirs = take(client), take(client, headers=DAVE)
    doc = {"revision": 0, "annotations": [ANN]}
    assert client.put(f"/api/annotations/{mine['id']}", json=doc, headers={**CAROL, **ws(mine["id"])}).status_code == 200
    assert [a["id"] for a in client.get(f"/api/annotations/{mine['id']}", headers={**CAROL, **ws(mine["id"])}).json()["annotations"]] == ["x"]
    assert client.get(f"/api/annotations/{theirs['id']}", headers={**DAVE, **ws(theirs["id"])}).json()["annotations"] == []
    assert client.get(f"/api/annotations/{mine['id']}", headers={**DAVE, **ws(mine["id"])}).status_code == 404
    assert client.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"] == []


def test_the_studio_reads_the_shared_bytes(client):
    p = take(client)
    pid = p["id"]
    d = client.get(f"/api/v1/tasks/{pid}/document", headers=CAROL).json()
    assert [a["path"] for a in d["assets"]] == ["img/a.png"]
    assert d["assets"][0]["nodeId"] != client.get("/api/v1/tasks/ws-a/document").json()["assets"][0]["nodeId"]
    assert client.get(f"/api/environments/{pid}", headers=CAROL).json()["effective"] == client.get("/api/environments/ws-a").json()["effective"]
    # Files: the sample's folder, download from the shared key.
    node = d["assets"][0]["nodeId"]
    r = client.get(f"/api/v1/source-nodes/{node}/download", headers=CAROL)
    assert r.status_code == 200 and r.content == png(40, 30)
    # The Studio's asset route: a signed URL inside the copy's workspace.
    listed = client.get("/api/v1/assets", headers={**CAROL, **ws(pid)}).json()["assets"]
    aid = next(x["id"] for x in listed if x["path"] == "img/a.png")
    u = client.get(f"/api/v1/assets/{aid}/url", headers={**CAROL, **ws(pid)})
    assert u.status_code == 200, u.text
    assert client.get(u.json()["url"]).content == png(40, 30)
    with kdb.session_scope() as s:
        rows = s.query(Asset).filter(Asset.path == "img/a.png").all()
        assert {r.workspace_id for r in rows} == {"ws-a", pid}


def test_a_copy_is_an_ordinary_project_for_its_owner(client):
    p = take(client)
    assert client.patch(f"/api/v1/projects/{p['id']}", json={"title": "Mine"}, headers=CAROL).json()["title"] == "Mine"
    r = client.post(f"/api/v1/projects/{p['id']}/imports", json={"attested": True, "files": [{"clientFileId": "c0", "relPath": "x.png", "size": 3, "sha256": "0" * 64}]}, headers=CAROL)
    assert r.status_code == 201, r.text


def test_who_may_take_a_sample_and_where(client, make_client):
    assert client.post("/api/v1/projects/from-sample", json={"sampleId": "nope"}, headers=CAROL).status_code == 404
    assert client.post("/api/v1/projects/from-sample", json={"sampleId": "ws-soon"}, headers=CAROL).status_code == 404
    assert client.post("/api/v1/projects/from-sample", json={}, headers=CAROL).status_code == 422
    assert client.post("/api/v1/projects/from-sample", json={"sampleId": "ws-a", "orgId": "org-samples"}).status_code == 403
    assert client.post("/api/v1/projects/from-sample", json={"sampleId": "ws-a", "orgId": projects.personal_org_id("user:dave")}, headers=CAROL).status_code == 403
    # local-expert (a Samples viewer) copies into their personal org.
    p = take(client, headers={})
    assert p["orgId"] == projects.personal_org_id("user:local-expert") and p["role"] == "owner"
    # An explicit orgId the caller may write to.
    assert take(client, orgId=projects.personal_org_id("user:carol"))["orgId"] == projects.personal_org_id("user:carol")
    # Agents don't take samples for people.
    tok = client.post("/api/v1/sessions", json={"agent": "assistant", "scopes": ["*"]}, headers={**CAROL, **ws(p["id"])})
    token = tok.json()["token"]
    assert client.post("/api/v1/projects/from-sample", json={"sampleId": "ws-a"}, headers={"Authorization": f"Bearer {token}"}).status_code == 403


def test_samples_can_be_turned_off(make_client):
    c = make_client(sample_editors=(), samples_enabled=False)
    assert c.get("/api/v1/samples").json() == {"enabled": False, "samples": []}
    assert c.post("/api/v1/projects/from-sample", json={"sampleId": "ws-a"}, headers=CAROL).status_code == 404
