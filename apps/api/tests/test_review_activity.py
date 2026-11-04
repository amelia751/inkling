"""todo6 Phase 8: the project review queue (Overview's attention is its top 5) and the activity feed."""

from __future__ import annotations

from studio_api import db as kdb
from studio_api.context import RequestContext
from studio_api.kernel import audit
from studio_api.models import SourceNode

from .conftest import png, ws
from .test_projects import _import, _session_body

BOB = {"X-Dev-Principal": "user:bob"}


def _hold(node_id: str, reason: str = "header has a patient name field") -> None:
    """What the inspection worker does (Phase 5) for a file with identifiers."""
    with kdb.session_scope() as s:
        n = s.get(SourceNode, node_id)
        n.flags = {**(n.flags or {}), "privacy": {"reason": reason}}


def _files(client, project_id: str) -> list[dict]:
    src = client.get(f"/api/v1/projects/{project_id}/sources").json()["sources"][0]
    return [k for k in client.get(f"/api/v1/sources/{src['id']}/children").json()["items"] if k["kind"] == "file"]


def _review_opened(project_id: str, dataset_id: str, review_id: str, merged: bool = False) -> None:
    """The kernel's audit entries for a versioning review (kernel/versioning/service.py)."""
    with kdb.session_scope() as s:
        ctx = RequestContext(project_id, "user:local-expert", "c")
        audit.record(s, ctx, "versioning.review.open", target=f"dataset:{dataset_id}", after={"reviewId": review_id, "source": "work/dev", "target": "main"})
        if merged:
            audit.record(s, ctx, "versioning.merge", target=f"dataset:{dataset_id}", after={"reviewId": review_id, "merge_oid": "0" * 40})


def test_review_queue_covers_every_type_filters_and_feeds_overview(client):
    p = client.post("/api/v1/projects", json={"title": "Queue"}).json()
    pid = p["id"]
    _import(client, pid, {"d/a.png": png(4, 4), "d/b.png": png(5, 5), "d/c.png": png(6, 6)})
    files = _files(client, pid)
    root = client.get(f"/api/v1/projects/{pid}/sources").json()["sources"][0]["rootNodeId"]
    _hold(files[0]["id"])
    ds = client.post(f"/api/v1/projects/{pid}/datasets", json={"title": "Scans", "nodeIds": [root], "task": {"title": "Outline", "preset": "preset:image-2d"}}).json()
    # A failed upload: wrong bytes for the declared checksum.
    s = client.post(f"/api/v1/projects/{pid}/imports", json=_session_body({"e/x.png": png(9, 9)}, prefix="x")).json()
    client.put(s["files"][0]["uploadUrl"], content=b"x" * s["files"][0]["size"])
    client.post(f"/api/v1/projects/{pid}/proposals", json={"kind": "relationship", "payload": {"summary": "scans ↔ labels"}, "evidence": {"unmatched": 7}, "strength": "possible"})
    _review_opened(pid, ds["id"], "rv-1")
    _review_opened(pid, ds["id"], "rv-2", merged=True)
    task = ds["tasks"][0]["id"]
    ann = {"id": "s1", "itemId": "x", "label": "normal", "provenance": "ai-suggested", "author": "m", "createdAt": "2026-10-30T00:00:00Z", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}, "attributes": {"review_status": "pending"}}
    assert client.put(f"/api/annotations/{task}", json={"revision": 0, "annotations": [ann]}, headers=ws(task)).status_code == 200

    r = client.get(f"/api/v1/projects/{pid}/review").json()
    types = [i["type"] for i in r["items"]]
    assert set(types) == {"privacy", "import", "proposal", "version-review", "annotations"}, types
    # Most severe first; privacy and failed imports are high.
    assert types[:2] in (["privacy", "import"], ["import", "privacy"])
    by = {i["type"]: i for i in r["items"]}
    assert by["privacy"]["target"] == {"section": "sources", "nodeId": files[0]["id"]} and by["privacy"]["datasetId"] == ds["id"]
    assert by["import"]["target"] == {"section": "sources", "importId": s["id"]} and by["import"]["title"] == "1 file didn't upload"
    assert by["proposal"]["title"] == "7 records need matching" and by["proposal"]["target"]["tab"] == "relationships"
    # Only the review that wasn't merged is open; it opens that review's page.
    assert by["version-review"]["target"] == {"section": "datasets", "datasetId": ds["id"], "tab": "versions", "reviewId": "rv-1"}
    assert by["annotations"]["target"] == {"section": "studio", "taskId": task}
    assert r["total"] == 5 and r["facets"]["types"]["privacy"] == 1 and r["facets"]["datasets"] == [{"id": ds["id"], "title": "Scans", "count": 3}]

    # Filters: by type, severity and dataset.
    assert [i["type"] for i in client.get(f"/api/v1/projects/{pid}/review", params={"type": "proposal"}).json()["items"]] == ["proposal"]
    assert {i["type"] for i in client.get(f"/api/v1/projects/{pid}/review", params={"severity": "high"}).json()["items"]} == {"privacy", "import"}
    assert {i["type"] for i in client.get(f"/api/v1/projects/{pid}/review", params={"dataset": ds["id"]}).json()["items"]} == {"privacy", "version-review", "annotations"}
    assert client.get(f"/api/v1/projects/{pid}/review", params={"type": "nope"}).status_code == 422
    assert client.get(f"/api/v1/projects/{pid}/review", headers=BOB).status_code == 404

    # Overview's attention is the top 5 of the same queue.
    ov = client.get(f"/api/v1/projects/{pid}/overview").json()
    assert [i["id"] for i in ov["attention"]] == [i["id"] for i in r["items"]][:5] and ov["attentionTotal"] == 5

    # Clearing the hold takes it off the queue.
    assert client.post(f"/api/v1/source-nodes/{files[0]['id']}/privacy/clear", json={"reason": "synthetic"}).status_code == 200
    assert "privacy" not in {i["type"] for i in client.get(f"/api/v1/projects/{pid}/review").json()["items"]}


def test_activity_shows_an_import_flow_in_order_with_actors(client):
    p = client.post("/api/v1/projects", json={"title": "Mixed import"}).json()
    pid = p["id"]
    _import(client, pid, {"mixed/scan1.png": png(4, 4), "mixed/scan2.png": png(5, 5)})
    files = _files(client, pid)
    _hold(files[0]["id"])
    # The assistant proposes a dataset for the person; the person confirms it.
    tok = client.post("/api/v1/sessions", json={"scopes": ["proposals.write"], "agent": "run-7"}, headers=ws(pid)).json()["token"]
    pr = client.post(f"/api/v1/projects/{pid}/proposals", json={"kind": "relationship", "payload": {"summary": "link"}}, headers={"Authorization": f"Bearer {tok}"}).json()
    assert client.post(f"/api/v1/proposals/{pr['id']}/confirm", json={}).status_code == 200
    assert client.post(f"/api/v1/source-nodes/{files[0]['id']}/privacy/clear", json={"reason": "synthetic"}).status_code == 200
    root = client.get(f"/api/v1/projects/{pid}/sources").json()["sources"][0]["rootNodeId"]
    ds = client.post(f"/api/v1/projects/{pid}/datasets", json={"title": "Scans", "nodeIds": [root], "task": {"title": "Outline", "preset": "preset:image-2d"}}).json()

    feed = client.get(f"/api/v1/projects/{pid}/activity").json()["entries"]
    audited = [e for e in feed if e["id"].startswith("audit:")]
    oldest_first = [e["action"] for e in reversed(audited)]
    assert oldest_first == ["project.created", "import.started", "import.completed", "proposal.created", "proposal.confirmed", "privacy.cleared", "dataset.created", "task.created"], oldest_first
    by = {e["action"]: e for e in audited}
    assert by["project.created"]["who"] == {"kind": "person", "name": "local-expert", "onBehalfOf": None}
    assert by["proposal.created"]["who"] == {"kind": "assistant", "name": "Assistant", "onBehalfOf": "local-expert"}
    assert by["proposal.created"]["label"] == "proposed a link between files"
    assert by["proposal.confirmed"]["who"]["kind"] == "person"
    assert by["import.completed"]["label"] == "added 2 files"
    assert by["dataset.created"]["subject"] == "Scans" and by["dataset.created"]["link"] == {"section": "datasets", "datasetId": ds["id"]}
    assert by["task.created"]["link"] == {"section": "studio", "taskId": ds["tasks"][0]["id"]}
    assert by["privacy.cleared"]["link"] == {"section": "sources", "nodeId": files[0]["id"]}
    # The task's Studio setup is a revision entry; plumbing (sessions) isn't in the feed.
    assert any(e["action"] == "environment.saved" and e["label"] == "set up the Studio" for e in feed)
    assert not any(e["action"].startswith("sessions.") for e in feed)


def test_activity_names_version_events_and_links_reviews(client):
    _review_opened("ws-a", "ws-a", "rv-9")
    feed = client.get("/api/v1/projects/ws-a/activity").json()["entries"]
    e = next(x for x in feed if x["action"] == "versioning.review.open")
    assert e["label"] == "asked for a version review" and e["subject"] == "A"
    assert e["link"] == {"section": "datasets", "datasetId": "ws-a", "tab": "versions", "reviewId": "rv-9"}
    q = client.get("/api/v1/projects/ws-a/review").json()["items"]
    assert [i["type"] for i in q] == ["version-review"]


def test_settings_patch_is_audited(client):
    p = client.post("/api/v1/projects", json={"title": "Old"}).json()
    r = client.patch(f"/api/v1/projects/{p['id']}", json={"title": "New", "description": "d", "visibility": "shared"})
    assert r.status_code == 200 and r.json()["visibility"] == "shared"
    assert client.patch(f"/api/v1/projects/{p['id']}", json={"title": "Newer"}).json()["title"] == "Newer"
    feed = client.get(f"/api/v1/projects/{p['id']}/activity").json()["entries"]
    assert [e["action"] for e in feed].count("project.updated") == 2 and feed[0]["link"] == {"section": "settings"}
