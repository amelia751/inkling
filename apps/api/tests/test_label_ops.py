"""todo17 Milestone 1: label rename and merge rewrite annotations with the rules, undoably; a rules
change that would orphan annotations is refused with the count and the merge operation."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.models import AnnotationDocumentRow, TaskRow

from .test_rules import _project

RULES = {"labels": [
    {"id": "pneumonia", "name": "pneumonia", "synonyms": ["PNA"]},
    {"id": "normal", "name": "normal", "synonyms": []},
    {"id": "effusion", "name": "effusion", "synonyms": []},
]}


def _ann(i: str, label: str) -> dict:
    return {"id": i, "itemId": "a.png", "label": label, "geometry": {"type": "box", "x": 0, "y": 0, "w": 1, "h": 1}, "provenance": "human-created", "author": "user:local-expert", "createdAt": "2026-11-02T00:00:00Z"}


def _setup(client, monkeypatch, labels: list[str]) -> str:
    p = _project(client, monkeypatch)
    r = client.put(f"/api/v1/projects/{p}/rules", json={"rules": RULES, "baseRevision": 0})
    assert r.status_code == 200, r.text
    with kdb.session_scope() as db:
        task = db.scalars(select(TaskRow).where(TaskRow.project_id == p)).first()
        db.add(AnnotationDocumentRow(workspace_id=p, task_id=task.id, revision=3, annotations=[_ann(f"a{i}", lab) for i, lab in enumerate(labels)]))
    return p


def _labels(p: str) -> list[str]:
    with kdb.session_scope() as db:
        return [a["label"] for d in db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.workspace_id == p)) for a in d.annotations]


def _doc_revision(p: str) -> int:
    with kdb.session_scope() as db:
        return db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.workspace_id == p)).one().revision


def test_rename_rewrites_annotations_and_keeps_old_name_as_synonym(client, monkeypatch):
    p = _setup(client, monkeypatch, ["pneumonia", "PNA", "normal", "pneumonia"])
    r = client.post(f"/api/v1/projects/{p}/labels/rename", json={"from": "pneumonia", "to": " Pneumonia "})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["rewritten"] == {"annotations": 3, "documents": 1}
    assert out["revision"] == 2 and isinstance(out["historyId"], int)
    lab = out["rules"]["labels"][0]
    assert lab["id"] == "pneumonia" and lab["name"] == "Pneumonia" and lab["synonyms"] == ["PNA"]  # case-only: matching is case-folded
    assert _labels(p) == ["Pneumonia", "Pneumonia", "normal", "Pneumonia"]
    assert _doc_revision(p) == 4
    hist = client.get(f"/api/v1/projects/{p}/rules/history").json()["history"]
    assert [h["revision"] for h in hist] == [2, 1]
    # Renaming onto another label is a merge, and says so.
    bad = client.post(f"/api/v1/projects/{p}/labels/rename", json={"from": "normal", "to": "effusion"})
    assert bad.status_code == 422 and bad.json()["violations"][0]["rule"] == "label.name-taken"
    assert "labels.merge" in bad.json()["violations"][0]["fix"]
    unknown = client.post(f"/api/v1/projects/{p}/labels/rename", json={"from": "nope", "to": "x"})
    assert unknown.status_code == 422 and unknown.json()["violations"][0]["rule"] == "label.unknown"


def test_merge_folds_labels_and_stray_strings_into_one(client, monkeypatch):
    p = _setup(client, monkeypatch, ["PNA", "effusion", "Pneumonia ", "consolidation", "normal"])
    r = client.post(f"/api/v1/projects/{p}/labels/merge", json={"from": ["effusion", "consolidation", "PNA"], "into": "pneumonia"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert [lab["name"] for lab in out["rules"]["labels"]] == ["pneumonia", "normal"]
    assert out["rules"]["labels"][0]["synonyms"] == ["PNA", "effusion", "consolidation"]
    # "Pneumonia " already canonicalises to pneumonia but isn't in `from`: untouched.
    assert _labels(p) == ["pneumonia", "pneumonia", "Pneumonia ", "pneumonia", "normal"]
    assert out["rewritten"] == {"annotations": 3, "documents": 1}


def test_dry_run_counts_without_changing_anything(client, monkeypatch):
    p = _setup(client, monkeypatch, ["effusion", "effusion", "normal"])
    r = client.post(f"/api/v1/projects/{p}/labels/merge?dryRun=true", json={"from": ["effusion"], "into": "normal"})
    assert r.status_code == 200, r.text
    assert r.json()["dryRun"] is True and r.json()["rewritten"] == {"annotations": 2, "documents": 1}
    assert _labels(p) == ["effusion", "effusion", "normal"] and _doc_revision(p) == 3
    assert client.get(f"/api/v1/projects/{p}/rules").json()["revision"] == 1
    assert len(client.get(f"/api/v1/projects/{p}/rules/history").json()["history"]) == 1


def test_idempotency_key_replays(client, monkeypatch):
    p = _setup(client, monkeypatch, ["effusion"])
    h = {"Idempotency-Key": "merge-1"}
    a = client.post(f"/api/v1/projects/{p}/labels/merge", json={"from": ["effusion"], "into": "normal"}, headers=h)
    b = client.post(f"/api/v1/projects/{p}/labels/merge", json={"from": ["effusion"], "into": "normal"}, headers=h)
    assert a.status_code == b.status_code == 200 and a.json() == b.json()
    assert client.get(f"/api/v1/projects/{p}/rules").json()["revision"] == 2


def test_rules_change_that_orphans_annotations_is_refused(client, monkeypatch):
    p = _setup(client, monkeypatch, ["pneumonia", "PNA", "effusion", "normal"])
    url = f"/api/v1/projects/{p}/rules"
    without = {"labels": [{"id": "lung-disease", "name": "lung disease"}, {"id": "normal", "name": "normal"}]}
    r = client.put(url, json={"rules": without, "baseRevision": 1})
    assert r.status_code == 422, r.text
    body = r.json()
    assert r.headers["content-type"].startswith("application/problem+json") and body["code"] == "write_rejected"
    vs = {v["value"]: v for v in body["violations"]}
    assert set(vs) == {"pneumonia", "effusion"} and {v["rule"] for v in vs.values()} == {"label.in-use"}
    assert vs["pneumonia"]["fix"].startswith("2 annotations use 'pneumonia'; merge it into 'lung disease' with labels.merge")
    assert vs["effusion"]["fix"].startswith("1 annotation uses 'effusion'")
    assert client.get(url).json()["revision"] == 1
    # JSON Patch removing a label: same check.
    r = client.patch(url, json={"baseRevision": 1, "ops": [{"op": "remove", "path": "/labels/2"}]})
    assert r.status_code == 422 and r.json()["violations"][0]["value"] == "effusion"
    # Removing an unused label, or a stale base, are not orphan errors.
    assert client.patch(url, json={"baseRevision": 0, "ops": [{"op": "remove", "path": "/labels/2"}]}).status_code == 409
    keep = {"labels": [*RULES["labels"], {"id": "nodule", "name": "nodule"}]}
    assert client.put(url, json={"rules": keep, "baseRevision": 1}).status_code == 200
    assert client.patch(url, json={"baseRevision": 2, "ops": [{"op": "remove", "path": "/labels/3"}]}).status_code == 200
    # No label set at all: any labels are fine, nothing to orphan.
    assert client.put(url, json={"rules": {"labels": []}, "baseRevision": 3}).status_code == 200


def test_undo_restores_rules_and_annotations(client, monkeypatch):
    p = _setup(client, monkeypatch, ["PNA", "effusion", "normal"])
    out = client.post(f"/api/v1/projects/{p}/labels/merge", json={"from": ["PNA", "effusion"], "into": "normal"}).json()
    assert _labels(p) == ["normal", "normal", "normal"]
    hid = out["historyId"]
    dry = client.post(f"/api/v1/projects/{p}/labels/undo/{hid}?dryRun=true")
    assert dry.status_code == 200 and dry.json()["restored"]["annotations"] == 2 and _labels(p) == ["normal", "normal", "normal"]
    r = client.post(f"/api/v1/projects/{p}/labels/undo/{hid}")
    assert r.status_code == 200, r.text
    assert r.json()["restored"] == {"annotations": 2, "documents": 1} and r.json()["revision"] == 3
    assert _labels(p) == ["PNA", "effusion", "normal"]
    assert r.json()["rules"]["labels"] == client.get(f"/api/v1/projects/{p}/rules/history").json()["history"][2]["rules"]["labels"]
    assert client.post(f"/api/v1/projects/{p}/labels/undo/{hid}").status_code == 409
    assert client.post(f"/api/v1/projects/{p}/labels/undo/99999").status_code == 404


def test_undo_refuses_after_a_later_rules_change(client, monkeypatch):
    p = _setup(client, monkeypatch, ["effusion"])
    hid = client.post(f"/api/v1/projects/{p}/labels/rename", json={"from": "effusion", "to": "pleural effusion"}).json()["historyId"]
    client.post(f"/api/v1/projects/{p}/labels/rename", json={"from": "normal", "to": "clear"})
    assert client.post(f"/api/v1/projects/{p}/labels/undo/{hid}").status_code == 409


def test_agents_cannot_rename(client, monkeypatch):
    from .test_trash import _member

    p = _setup(client, monkeypatch, ["effusion"])
    _member(p, "viewer")
    r = client.post(f"/api/v1/projects/{p}/labels/rename", json={"from": "effusion", "to": "x"}, headers={"X-Dev-Principal": "user:bob"})
    assert r.status_code == 403


def test_rename_keeps_the_old_name_as_a_synonym(client, monkeypatch):
    p = _setup(client, monkeypatch, ["effusion"])
    out = client.post(f"/api/v1/projects/{p}/labels/rename", json={"from": "effusion", "to": "pleural effusion"}).json()
    assert out["rules"]["labels"][2] == {"id": "effusion", "name": "pleural effusion", "synonyms": ["effusion"]}
    assert _labels(p) == ["pleural effusion"]
