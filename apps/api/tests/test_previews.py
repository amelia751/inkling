"""todo23 W6 (D8): a generated Studio boots as a preview only its requester sees; Keep moves it to
the workspace tier; Discard (or expiry) leaves no rows behind."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from studio_api import db as kdb
from studio_api.db import Base
from studio_api.models import EnvironmentPreview, TaskRow

from .conftest import png
from .test_files import _by_name, _inspect_all, _new
from .test_trash import BOB, _member

ENV = {"extends": "preset:image-2d", "labels": [{"name": "finding", "control": "Choices", "classes": [{"id": "a"}, {"id": "b"}]}]}


def _setup(client) -> tuple[str, str]:
    p, _, imp = _new(client, {"study/a.png": png(4, 4)})
    _inspect_all(client, imp)
    n = _by_name(p)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Scans", "nodeIds": [n["a.png"].id]}).json()
    _member(p, "admin")
    return p, ds["id"]


def _boot(client, p: str, ds: str) -> dict:
    r = client.post(f"/api/v1/projects/{p}/previews", json={"datasetId": ds, "environment": ENV, "pluginVersions": {"studio.table": "1.0.0"}, "title": "Finance"})
    assert r.status_code == 201, r.text
    return r.json()


def _rows_for(task_id: str) -> dict[str, int]:
    out = {}
    with kdb.session_scope() as db:
        for t in Base.metadata.sorted_tables:
            if "task_id" in t.c and t.name not in ("plugin_audit", "audit_events"):
                n = db.scalar(select(func.count()).select_from(t).where(t.c.task_id == task_id))
                if n:
                    out[t.name] = n
        if db.get(TaskRow, task_id) is not None:
            out["tasks"] = 1
    return out


def test_only_the_requester_sees_a_preview(client):
    p, ds = _setup(client)
    pv = _boot(client, p, ds)
    assert pv["status"] == "active" and pv["environment"] == ENV and pv["pluginVersions"] == {"studio.table": "1.0.0"}
    tid = pv["taskId"]
    assert client.get(f"/api/v1/tasks/{tid}").json()["state"] == "preview"
    assert [x["id"] for x in client.get(f"/api/v1/projects/{p}/previews").json()["previews"]] == [pv["id"]]

    # Someone else in the project sees nothing: not the preview, its Studio, environment or annotations.
    assert client.get(f"/api/v1/projects/{p}", headers=BOB).status_code == 200
    assert client.get(f"/api/v1/projects/{p}/previews", headers=BOB).json()["previews"] == []
    assert client.get(f"/api/v1/projects/{p}/previews/{pv['id']}", headers=BOB).status_code == 404
    assert client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/keep", headers=BOB).status_code == 404
    assert client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/discard", headers=BOB).status_code == 404
    assert client.get(f"/api/v1/tasks/{tid}", headers=BOB).status_code == 404
    assert client.get(f"/api/environments/{tid}", headers=BOB).status_code == 404
    assert client.get(f"/api/annotations/{tid}", headers=BOB).status_code == 404
    assert tid not in [t["id"] for t in client.get(f"/api/v1/projects/{p}/datasets/{ds}/tasks", headers=BOB).json()["tasks"]]

    # Its environment is immutable.
    r = client.patch(f"/api/environments/{tid}", json={"revision": 1, "patch": [{"op": "replace", "path": "/extends", "value": "preset:video"}]})
    assert r.status_code == 409


def test_keep_moves_the_preview_to_the_workspace(client):
    p, ds = _setup(client)
    pv = _boot(client, p, ds)
    tid = pv["taskId"]
    assert client.put(f"/api/annotations/{tid}", json={"annotations": []}).status_code == 200
    r = client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/keep")
    assert r.status_code == 200, r.text
    assert r.json()["preview"]["status"] == "kept" and r.json()["task"]["state"] == "published"
    # Now everyone in the project sees the Studio, with the preview's environment.
    assert client.get(f"/api/v1/tasks/{tid}", headers=BOB).json()["state"] == "published"
    assert client.get(f"/api/environments/{tid}", headers=BOB).json()["environment"] == ENV
    assert client.get(f"/api/v1/projects/{p}/previews").json()["previews"] == []
    # A kept preview can't be discarded; keeping again is a no-op.
    assert client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/discard").status_code == 409
    assert client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/keep").status_code == 200


def test_discard_leaves_no_rows(client):
    p, ds = _setup(client)
    pv = _boot(client, p, ds)
    tid = pv["taskId"]
    doc = client.get(f"/api/annotations/{tid}").json()
    saved = client.put(f"/api/annotations/{tid}", json={**doc, "annotations": [{"id": "ann-1", "itemId": "x", "label": "a", "provenance": "human-created", "author": "user:local-expert", "createdAt": "2026-11-04T00:00:00Z", "geometry": {"type": "box", "x": 0, "y": 0, "w": 1, "h": 1}}]})
    assert saved.status_code == 200, saved.text
    assert {"tasks", "workspace_environments", "workspace_environment_history", "annotation_documents"} <= set(_rows_for(tid))
    assert client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/discard").status_code == 204
    assert _rows_for(tid) == {}
    with kdb.session_scope() as db:
        assert db.get(EnvironmentPreview, pv["id"]) is None
    assert client.get(f"/api/v1/projects/{p}/previews/{pv['id']}").status_code == 404


def test_an_expired_preview_is_discarded(client):
    p, ds = _setup(client)
    pv = _boot(client, p, ds)
    with kdb.session_scope() as db:
        row = db.get(EnvironmentPreview, pv["id"])
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    assert client.get(f"/api/v1/projects/{p}/previews").json()["previews"] == []
    assert _rows_for(pv["taskId"]) == {}
    assert client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/keep").status_code == 404


def test_keep_needs_a_passing_review_for_generated_plugins(client):
    """D11: a pinned agent-built plugin without a passing review blocks Keep; a pass unblocks it."""
    from studio_api.models import ArtifactReview, PluginArtifact

    p, ds = _setup(client)
    gen = "studio.generated.anomalies"
    with kdb.session_scope() as db:
        db.add(PluginArtifact(plugin_id=gen, version="0.1.0", manifest_digest="sha256:" + "0" * 64, artifact_digest="sha256:" + "1" * 64, trust_tier="generated", publisher="agent", workspace_id=p, manifest={}, signature={}, created_by="agent:builder"))
    r = client.post(f"/api/v1/projects/{p}/previews", json={"datasetId": ds, "environment": ENV, "pluginVersions": {gen: "0.1.0"}, "title": "Gen"})
    assert r.status_code == 201, r.text
    pv = r.json()
    r = client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/keep")
    assert r.status_code == 409 and "review" in r.text
    with kdb.session_scope() as db:
        db.add(ArtifactReview(**_review_row(p, gen)))
    assert client.post(f"/api/v1/projects/{p}/previews/{pv['id']}/keep").status_code == 200


def _review_row(p: str, plugin_id: str) -> dict:
    from studio_api.models import ArtifactReview

    cols = {c.name for c in ArtifactReview.__table__.columns}
    row = {"artifact_kind": "plugin", "artifact_id": plugin_id, "artifact_version": "0.1.0", "verdict": "pass", "reviewer": "agent:reviewer", "review": {"verdict": "pass", "findings": []}, "workspace_id": p}
    return {k: v for k, v in row.items() if k in cols}
