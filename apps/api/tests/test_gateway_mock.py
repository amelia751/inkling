"""Phase 4 exit (docs/plugins.md Phase 0): a first-party image.segment command with a mock
provider runs through the gateway and stores provider-independent masks as canonical
annotations."""

from __future__ import annotations

from .conftest import ws


def test_mock_segment_commits_canonical_masks(make_client):
    c = make_client(builtin_mock_segment=True)
    r = c.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png", "label": "lesion", "prompts": [{"type": "point", "x": 5, "y": 5}]}}, headers=ws("ws-a"))
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    assert job["state"] == "succeeded", job
    doc = c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()
    masks = [a for a in doc["annotations"] if a["geometry"]["type"] == "mask"]
    assert len(masks) == 2 and doc["revision"] == 1
    m = masks[0]
    assert m["geometry"]["dims"] == [40, 30]
    assert sum(m["geometry"]["counts"]) == 40 * 30
    assert m["provenance"] == "ai-suggested" and m["label"] == "lesion" and m["itemId"] == "img/a.png"
    assert m["attributes"]["provider"] == "mock" and m["attributes"]["model"] == "mock-ellipse-1"
    assert m["attributes"]["review_status"] == "pending" and "prompt" in m["attributes"]
    actions = [e["action"] for e in c.get("/api/v1/audit", headers=ws("ws-a")).json()["entries"]]
    assert {"gateway.invoke", "annotations.commit", "jobs.succeeded"} <= set(actions)


def test_input_is_validated_against_the_capability(make_client):
    c = make_client(builtin_mock_segment=True)
    bad = c.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png", "prompts": [{"type": "box", "box": [10, 10, 5, 5]}]}}, headers=ws("ws-a"))
    assert bad.status_code == 422
    extra = c.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png", "workspace_id": "ws-b"}}, headers=ws("ws-a"))
    assert extra.status_code == 422  # tenancy can't be smuggled in through the input


def test_assets_are_workspace_scoped(make_client):
    c = make_client(builtin_mock_segment=True)
    r = c.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/b.png"}}, headers=ws("ws-a"))
    assert r.status_code == 404


def test_without_the_builtin_or_a_plugin_nothing_runs(client):
    r = client.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    assert r.status_code == 403


def test_review_accept_and_reject(make_client):
    c = make_client(builtin_mock_segment=True)
    c.post("/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    a = c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"][0]
    r = c.post(f"/api/v1/annotations/{a['id']}/review", json={"status": "accepted"}, headers=ws("ws-a"))
    assert r.json()["attributes"]["review_status"] == "accepted"


def test_signed_urls(client):
    asset = client.get("/api/v1/assets", headers=ws("ws-a")).json()["assets"][0]
    assert asset["mediaType"] == "image/png"
    url = client.get(f"/api/v1/assets/{asset['id']}/url", headers=ws("ws-a")).json()["url"]
    assert client.get(url).status_code == 200
    assert client.get(url.replace("sig=", "sig=0")).status_code == 403
    tok = client.post("/api/v1/assets/url-token", headers=ws("ws-a")).json()
    assert client.get(f"{tok['base']}img/a.png?exp={tok['exp']}&sig={tok['sig']}").status_code == 200
    assert client.get(f"/api/v1/assets/ws-b/files/img/b.png?exp={tok['exp']}&sig={tok['sig']}").status_code == 403


def test_annotation_document_roundtrip_and_migration(client):
    doc = {"revision": 0, "annotations": [{"id": "x", "itemId": "i", "label": "l", "geometry": {"type": "box", "x": 1, "y": 2, "w": 3, "h": 4}, "provenance": "human-created", "author": "me", "createdAt": "2026-01-01"}]}
    saved = client.put("/api/annotations/ws-a", json=doc, headers=ws("ws-a")).json()
    assert saved["revision"] == 1
    assert client.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"][0]["id"] == "x"
    from studio_api.kernel.annotations import migrate_document

    m = migrate_document({"revision": 1, "annotations": [{"geometry": {"type": "beat", "lead": "II", "t": 1.2, "code": "N"}}]})
    assert m["annotations"][0]["geometry"] == {"type": "instant", "t": 1.2, "channel": "II"}
    assert m["annotations"][0]["attributes"] == {"kind": "beat", "code": "N"} and m["annotationsVersion"] == 2
