"""todo14 Milestone 0: an empty product for anyone but the dev person; samples are read-only.

- A new `user:` principal gets an empty personal org and no Samples membership (D3).
- Principals in `API_SAMPLE_MEMBERS` (default `user:local-expert`) see the samples as `viewer`s (D7).
- A viewer reads a sample but every write route refuses (403), whichever way it is addressed.
"""

from __future__ import annotations

import hashlib

from studio_api import config
from studio_api import db as kdb
from studio_api.kernel import projects
from studio_api.models import OrganizationMember

import pytest

from .conftest import png, ws

NEW = {"X-Dev-Principal": "user:new-person"}


@pytest.fixture
def client(make_client):
    """The product's rule, without the test suite's Samples-maintainer grant (conftest)."""
    return make_client(sample_editors=())


ANN = {"id": "x", "itemId": "img/a.png", "label": "l", "provenance": "human-created", "author": "me", "createdAt": "2026-11-01T00:00:00Z", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}}


def test_a_new_principal_starts_empty(client):
    assert client.get("/api/v1/projects", headers=NEW).json()["projects"] == []
    for url in ("/api/v1/projects/ws-a", "/api/v1/projects/ws-a/sources", "/api/v1/tasks/ws-a/document"):
        assert client.get(url, headers=NEW).status_code == 404, url
    assert client.put("/api/annotations/ws-a", json={"revision": 0, "annotations": [ANN]}, headers={**NEW, **ws("ws-a")}).status_code == 404
    with kdb.session_scope() as s:
        assert s.get(OrganizationMember, (projects.SAMPLES_ORG, "user:new-person")) is None
        assert s.get(OrganizationMember, (projects.personal_org_id("user:new-person"), "user:new-person")).role == "owner"
    # Their own projects work as before.
    p = client.post("/api/v1/projects", json={"title": "Mine"}, headers=NEW).json()
    assert [x["id"] for x in client.get("/api/v1/projects", headers=NEW).json()["projects"]] == [p["id"]]


def test_local_expert_sees_the_samples_read_only(client):
    listed = client.get("/api/v1/projects").json()["projects"]
    assert {p["id"] for p in listed} == {"ws-a", "ws-b"}
    assert all(p["sample"] and p["role"] == "viewer" for p in listed)
    # Reading works: the project, Files, the Studio's task document, annotations and environment.
    for url in ("/api/v1/projects/ws-a", "/api/v1/projects/ws-a/sources", "/api/v1/projects/ws-a/overview", "/api/v1/tasks/ws-a/document", "/api/environments/ws-a"):
        assert client.get(url).status_code == 200, url
    assert client.get("/api/annotations/ws-a", headers=ws("ws-a")).status_code == 200
    # Personal state is not a write to the sample (todo14 D5).
    assert client.put("/api/v1/projects/ws-a/resume", json={"taskId": "ws-a"}).status_code == 200
    # A clean boot is acknowledged but never moves last-known-good for a viewer.
    r = client.post("/api/environments/ws-a/checks", json={"revision": 0, "ok": True})
    assert r.status_code == 200 and r.json()["moved"] is False


def test_a_viewer_cant_write_a_sample(client):
    root = client.get("/api/v1/projects/ws-a/sources").json()["sources"][0]["rootNodeId"]
    h = ws("ws-a")
    writes = [
        ("put", "/api/annotations/ws-a", {"revision": 0, "annotations": [ANN]}, h),
        ("put", "/api/environments/ws-a", {"revision": 0, "environment": {"extends": "preset:image-2d"}}, {}),
        ("put", "/api/environments/ws-a/readme", {"readme": "mine"}, {}),
        ("post", "/api/environments/ws-a/rollback", None, {}),
        ("put", "/api/v1/workspaces/ws-a/environment", {"environment": {"extends": "preset:image-2d"}}, h),
        ("patch", "/api/v1/projects/ws-a", {"title": "Renamed"}, {}),
        ("post", "/api/v1/projects/ws-a/imports", {"files": [{"path": "x.png", "size": 3}]}, {}),
        ("post", "/api/v1/projects/ws-a/drops", {}, {}),
        ("post", "/api/v1/projects/ws-a/fs/ops", {"ops": [{"op": "mkdir", "parentId": root, "name": "new"}]}, {}),
        ("post", "/api/v1/projects/ws-a/trash/empty", None, {}),
        ("post", "/api/v1/projects/ws-a/datasets", {"title": "Mine", "nodeIds": [root]}, {}),
        ("post", "/api/v1/projects/ws-a/datasets/ws-a/tasks", {"title": "T", "kind": "annotate"}, {}),
        ("post", "/api/v1/projects/ws-a/proposals", {"kind": "dataset", "payload": {}}, {}),
        ("post", "/api/v1/projects/ws-a/boots", {"bootId": "b1"}, {}),
        ("post", "/api/v1/annotations/x/review", {"status": "accepted"}, h),
        ("put", "/api/v1/secrets/K", {"value": "v"}, h),
        ("post", "/api/v1/workspaces/ws-a/plugins/plan", {"pluginId": "p"}, {}),
        ("post", "/api/v1/commands", {"tool": "some.tool", "input": {}}, h),
    ]
    for method, url, body, headers in writes:
        r = client.request(method.upper(), url, json=body, headers=headers)
        assert r.status_code == 403, (url, r.status_code, r.text)
    # Nothing changed.
    assert client.get("/api/annotations/ws-a", headers=h).json()["annotations"] == []
    assert client.get("/api/v1/projects/ws-a").json()["title"] == "A"


def test_an_agent_acting_for_a_viewer_cant_write_a_sample(client):
    tok = client.post("/api/v1/sessions", json={"agent": "assistant", "scopes": ["*"]}, headers=ws("ws-a"))
    assert tok.status_code == 200, tok.text
    token = tok.json()["token"]
    r = client.put("/api/annotations/ws-a", json={"revision": 0, "annotations": [ANN]}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403, r.text


def test_sample_members_is_configurable_and_dev_only(make_client):
    c = make_client(sample_editors=(), sample_members="user:alice, user:bob")
    assert {p["id"] for p in c.get("/api/v1/projects", headers={"X-Dev-Principal": "user:bob"}).json()["projects"]} == {"ws-a", "ws-b"}
    assert c.get("/api/v1/projects").json()["projects"] == []  # local-expert isn't listed any more
    s = config.settings()
    assert s.sample_member("user:alice") and not s.sample_member("user:local-expert")
    # TODO(todo9): outside dev mode (no trusted headers; WorkOS later) nobody joins the Samples org.
    assert not s.model_copy(update={"dev_trust_headers": False}).sample_member("user:alice")


def test_a_member_can_still_write_their_own_project(client):
    p = client.post("/api/v1/projects", json={"title": "Mine"}).json()
    assert p["role"] == "owner"
    r = client.post(f"/api/v1/projects/{p['id']}/imports", json={"attested": True, "files": [{"clientFileId": "c0", "relPath": "a.png", "size": len(png(4, 4)), "sha256": hashlib.sha256(png(4, 4)).hexdigest()}]})
    assert r.status_code in (200, 201), r.text
    assert client.patch(f"/api/v1/projects/{p['id']}", json={"title": "Renamed"}).status_code == 200


def test_features_carry_the_samples_switch(make_client):
    assert make_client().get("/api/v1/features").json()["samples"] is True
    assert make_client(samples_enabled=False).get("/api/v1/features").json()["samples"] is False
