"""todo17 D7: agents change published things through change requests (open, check, auto-merge or
a person's merge, stale base re-check, close, comments)."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.context import issue_session
from studio_api.kernel import admission
from studio_api.models import DatasetRow, TaskRow

from .test_files import ALICE, _by_name
from .test_rules import _project

AGENT = "agent:run_cr"


def _agent(p: str) -> dict:
    with kdb.session_scope() as db:
        token = issue_session(db, AGENT, p, ["proposals.write", "project.write"], on_behalf_of=ALICE, profile="claude-desktop")
    return {"Authorization": f"Bearer {token}"}


def _rules(client, p: str) -> dict:
    return client.get(f"/api/v1/projects/{p}/rules").json()


def _never(client, p: str) -> None:
    cur = _rules(client, p)
    r = client.put(f"/api/v1/projects/{p}/rules", json={"rules": {**cur["rules"], "merge": {"auto": "never"}}, "baseRevision": cur["revision"]})
    assert r.status_code == 200, r.text


def _agent_patch(client, p: str, h: dict, ops: list[dict]) -> dict:
    r = client.patch(f"/api/v1/projects/{p}/rules", json={"ops": ops, "baseRevision": _rules(client, p)["revision"]}, headers=h)
    assert r.status_code == 202, r.text
    return r.json()["changeRequest"]


def test_agent_rules_change_opens_a_change_request_and_auto_merges_when_clean(client, monkeypatch):
    p = _project(client, monkeypatch)
    h = _agent(p)
    cr = _agent_patch(client, p, h, [{"op": "replace", "path": "/layout/maxDepth", "value": 7}])
    assert cr["state"] == "merged" and cr["mergedBy"] == "auto-merge" and cr["actor"] == AGENT
    assert cr["agent"] == "claude-desktop" and cr["onBehalfOf"] == ALICE and cr["operations"][0]["op"] == "rules.update"
    out = _rules(client, p)
    assert out["rules"]["layout"]["maxDepth"] == 7 and out["revision"] == 1
    assert client.get(f"/api/v1/projects/{p}/rules/history").json()["history"][0]["actor"] == AGENT
    # Listing: merged ones are not open.
    assert client.get(f"/api/v1/projects/{p}/changes").json()["changes"] == []
    assert [c["id"] for c in client.get(f"/api/v1/projects/{p}/changes", params={"state": "all"}).json()["changes"]] == [cr["id"]]


def test_failing_check_waits_and_people_apply_directly(client, monkeypatch):
    p = _project(client, monkeypatch)
    h = _agent(p)
    cr = _agent_patch(client, p, h, [{"op": "add", "path": "/labels/-", "value": {"id": "x"}}])  # no name: invalid
    assert cr["state"] == "failed" and cr["findings"] and cr["findings"][0]["path"].startswith("/operations/0")
    assert _rules(client, p)["revision"] == 0
    # The agent's next change lands in the same change request, and the checks run again.
    cr2 = _agent_patch(client, p, h, [{"op": "replace", "path": "/layout/maxDepth", "value": 3}])
    assert cr2["id"] == cr["id"] and len(cr2["operations"]) == 2 and cr2["state"] == "failed"
    # A person merging a failing change request: 409, nothing applied.
    assert client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/merge").status_code == 409
    assert _rules(client, p)["revision"] == 0
    # People's writes apply directly.
    r = client.patch(f"/api/v1/projects/{p}/rules", json={"ops": [{"op": "replace", "path": "/layout/maxDepth", "value": 5}], "baseRevision": 0})
    assert r.status_code == 200 and r.json()["revision"] == 1


def test_never_mode_waits_for_a_person_and_agents_cannot_merge(client, monkeypatch):
    p = _project(client, monkeypatch)
    _never(client, p)
    h = _agent(p)
    cr = _agent_patch(client, p, h, [{"op": "replace", "path": "/layout/maxDepth", "value": 9}])
    assert cr["state"] == "passed" and cr["mergedBy"] is None
    detail = client.get(f"/api/v1/projects/{p}/changes/{cr['id']}", headers=h).json()
    assert detail["diff"] == [{"op": "rules.update", "path": "/rules/layout/maxDepth", "before": 4, "after": 9}]
    assert client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/merge", headers=h).status_code == 403
    assert _rules(client, p)["rules"]["layout"]["maxDepth"] == 4
    c = client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/comments", json={"body": "Looks right."})
    assert c.status_code == 201 and c.json()["author"] == ALICE
    r = client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/merge")
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "merged" and r.json()["mergedBy"] == ALICE and r.json()["comments"][0]["body"] == "Looks right."
    assert _rules(client, p)["rules"]["layout"]["maxDepth"] == 9


def test_stale_base_rechecks_merges_when_clean_and_needs_update_when_not(client, monkeypatch):
    p = _project(client, monkeypatch)
    _never(client, p)
    h = _agent(p)
    cr = _agent_patch(client, p, h, [{"op": "replace", "path": "/layout/maxDepth", "value": 9}])
    # The base moves in a way the change still applies to: re-checked, rebased, merged.
    cur = _rules(client, p)
    client.put(f"/api/v1/projects/{p}/rules", json={"rules": {**cur["rules"], "datasets": {"uniqueNames": True}}, "baseRevision": cur["revision"]})
    r = client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/merge")
    assert r.status_code == 200 and r.json()["state"] == "merged"
    out = _rules(client, p)["rules"]
    assert out["layout"]["maxDepth"] == 9 and out["datasets"]["uniqueNames"] is True
    # The base moves so the change no longer applies: needs update (kept, with findings).
    cr = _agent_patch(client, p, h, [{"op": "replace", "path": "/layout/maxDepth", "value": 2}])
    assert cr["state"] == "passed"
    cur = _rules(client, p)
    client.put(f"/api/v1/projects/{p}/rules", json={"rules": {**cur["rules"], "layout": {}}, "baseRevision": cur["revision"]})
    r = client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/merge")
    assert r.status_code == 409 and r.json()["code"] == "needs-update"
    got = client.get(f"/api/v1/projects/{p}/changes/{cr['id']}").json()
    assert got["state"] == "needs-update" and got["findings"]
    assert "maxDepth" not in _rules(client, p)["rules"]["layout"]


def test_close_and_open_from_the_changes_route(client, monkeypatch):
    p = _project(client, monkeypatch)
    _never(client, p)
    h = _agent(p)
    with kdb.session_scope() as db:
        ds = db.scalars(select(DatasetRow).where(DatasetRow.project_id == p)).first()
        task = db.scalars(select(TaskRow).where(TaskRow.dataset_id == ds.id)).first()
        ds_id, task_id, files_before = ds.id, task.id, len(ds.definition.get("files") or [])
        assert task.state == "published"
    node = _by_name(p)["a.png"].id
    r = client.post(f"/api/v1/projects/{p}/changes", json={"title": "Tidy", "operations": [
        {"op": "dataset.add_files", "input": {"datasetId": ds_id, "nodeIds": [node]}},
        {"op": "studio.patch", "input": {"taskId": task_id, "patch": [{"op": "replace", "path": "/title", "value": "Outline v2"}]}},
    ]}, headers=h)
    assert r.status_code == 201, r.text
    cr = r.json()
    assert cr["title"] == "Tidy" and cr["state"] in ("passed", "failed")
    assert client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/operations", json={"operations": [{"op": "nope", "input": {}}]}, headers=h).status_code == 422
    r = client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/close", headers=h)
    assert r.status_code == 200 and r.json()["state"] == "closed"
    assert client.post(f"/api/v1/projects/{p}/changes/{cr['id']}/merge").status_code == 409
    with kdb.session_scope() as db:
        assert len(db.get(DatasetRow, ds_id).definition.get("files") or []) == files_before


def test_dataset_change_auto_merges(client, monkeypatch):
    from .test_files import _import

    p = _project(client, monkeypatch)
    _import(client, p, {"more/b.png": b"\x89PNG"})
    h = _agent(p)
    with kdb.session_scope() as db:
        ds_id = db.scalars(select(DatasetRow).where(DatasetRow.project_id == p)).first().id
    node = _by_name(p)["b.png"].id
    r = client.post(f"/api/v1/projects/{p}/changes", json={"operations": [{"op": "dataset.add_files", "input": {"datasetId": ds_id, "nodeIds": [node]}}]}, headers=h)
    assert r.status_code == 201 and r.json()["state"] == "merged", r.text
    with kdb.session_scope() as db:
        assert node in {f["nodeId"] for f in db.get(DatasetRow, ds_id).definition["files"]}


def test_admit_defers_agents_published_writes():
    op = admission.Operation(id="thing.update", published=admission.CHANGE_REQUEST, persist=lambda v, c: "applied")
    opened = []
    ctx = admission.Ctx(rules={}, agent=True, targets_published=lambda o, v, c: v.get("published", False), open_change_request=lambda op_id, v: opened.append(op_id) or {"id": "cr1"})
    res = admission.admit(op, {"published": True}, ctx)
    assert res.deferred and res.value == {"changeRequest": {"id": "cr1"}} and opened == ["thing.update"]
    assert admission.admit(op, {"published": False}, ctx).value == "applied"  # a draft: direct
    person = admission.Ctx(rules={}, targets_published=ctx.targets_published, open_change_request=ctx.open_change_request)
    assert admission.admit(op, {"published": True}, person).value == "applied"
    assert admission.admit(op, {"published": True}, ctx, dry_run=True).deferred is False


def test_open_or_append_collects_fixes_in_one_change_request(client, monkeypatch):
    """W-HEALTH's fixes: one open change request per actor, annotation.relabel and source.rename."""
    from studio_api.context import RequestContext
    from studio_api.kernel import change_requests as crs
    from studio_api.models import AnnotationDocumentRow

    p = _project(client, monkeypatch)
    _never(client, p)
    node = _by_name(p)["a.png"].id
    with kdb.session_scope() as db:
        task_id = db.scalars(select(TaskRow).where(TaskRow.project_id == p)).first().id
        db.merge(AnnotationDocumentRow(workspace_id=p, task_id=task_id, revision=1, annotations=[{"id": "ann1", "itemId": "i", "label": "tumour", "geometry": {"type": "polygon", "points": []}}]))
    ctx = RequestContext(workspace_id=p, principal=AGENT, correlation_id="c1", on_behalf_of=ALICE, profile="gardener")
    with kdb.session_scope() as db:
        a = crs.open_or_append(db, ctx, "annotation.relabel", {"taskId": task_id, "annotationId": "ann1", "label": "tumour"}, title="Fix findings")
        b = crs.open_or_append(db, ctx, "source.rename", {"nodeId": node, "name": "scan-a.png"}, title="Fix findings")
    assert a["id"] == b["id"] and b["title"] == "Fix findings" and [o["op"] for o in b["operations"]] == ["annotation.relabel", "source.rename"]
    assert b["state"] == "passed", b["findings"]
    diff = client.get(f"/api/v1/projects/{p}/changes/{b['id']}").json()["diff"]
    assert {d["op"] for d in diff} == {"annotation.relabel", "source.rename"}
    assert client.post(f"/api/v1/projects/{p}/changes/{b['id']}/merge").json()["state"] == "merged"
    with kdb.session_scope() as db:
        assert db.get(AnnotationDocumentRow, (p, task_id)).annotations[0]["label"] == "Lesion"  # synonym → canonical
    assert _by_name(p).get("scan-a.png") is not None
    # An unknown label fails the check.
    with kdb.session_scope() as db:
        c = crs.open_or_append(db, ctx, "annotation.relabel", {"taskId": task_id, "annotationId": "ann1", "label": "Spleen"})
    assert c["state"] == "failed" and c["findings"][0]["rule"] == "label.unknown"
