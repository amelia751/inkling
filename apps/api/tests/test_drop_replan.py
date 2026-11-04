"""Re-plan a drop (`POST /drops/{id}/replan`): a drop applied under the old rules (a separate
Masks Studio, the 4D cine inside the 3D volumes) is reconciled with the current ones without
losing work: the seg joins its subject's volumes, the 4D cine gets its own collection and Studio,
the emptied Masks Studio goes to Trash (unless it has annotations), and a second re-plan is a
no-op."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from studio_api import db as kdb
from studio_api.kernel import drops_classify as dc, drops_plan
from studio_api.models import AnnotationDocumentRow, PluginAudit, DatasetCollectionRow, DatasetRow, DropPlanRow, SourceNode, TaskRow

from .test_drops import _drop, _project_without_assistant as _project, _report

BRATS = "BraTS2021_00621"


def _old_style_drop(client, monkeypatch) -> tuple[str, str]:
    """A drop applied with the rules before bb30524: no seg pairing, no 4D group."""
    with monkeypatch.context() as m:
        m.setattr(drops_plan, "mask_volumes", lambda nodes: {})
        m.setattr(dc, "_time_series", lambda f: False)
        m.setattr(drops_plan, "PER_KIND_STUDIOS", True)  # before todo19 D5: a Studio per kind
        pid = _project(client)
        files = {f"brain/{BRATS}_{s}.nii.gz": f"vol-{s}".encode() for s in ("t1", "t2")}
        files[f"brain/{BRATS}_seg.nii.gz"] = b"seg"
        files["cine/patient101_4d.nii.gz"] = b"cine"
        drop, imp = _drop(client, pid, files)
        kinds = {n.split("/")[-1]: "volume" for n in files}
        kinds[f"{BRATS}_seg.nii.gz"] = "mask"
        _report(client, imp, kinds, {"patient101_4d.nii.gz": {"slices": 10, "frames": 30}})
    with kdb.session_scope() as db:
        row = db.get(DropPlanRow, drop["id"])
        assert row is not None and row.state == "applied", row and row.state
        assert sorted(g["kind"] for g in row.groups) == ["mask", "volume"]
    return pid, drop["id"]


def _layout(pid: str) -> dict[str, tuple[list[str], list[str]]]:
    """Live collection kind → (file names, live task ids)."""
    with kdb.session_scope() as db:
        out = {}
        for c in db.scalars(select(DatasetCollectionRow).where(DatasetCollectionRow.project_id == pid, DatasetCollectionRow.trashed_at.is_(None))):
            d = db.get(DatasetRow, c.dataset_id)
            refs = [r["nodeId"] for r in (d.definition or {}).get("files") or [] if r.get("collectionId") == c.id]
            names = sorted(db.get(SourceNode, n).name for n in refs)
            tasks = sorted(t.id for t in db.scalars(select(TaskRow).where(TaskRow.collection_id == c.id, TaskRow.trashed_at.is_(None))))
            out[c.kind] = (names, tasks)
        return out


def _task_of(pid: str, kind: str) -> str:
    return _layout(pid)[kind][1][0]


def test_replan_reconciles_an_old_style_drop(client, monkeypatch):
    pid, drop_id = _old_style_drop(client, monkeypatch)
    before = _layout(pid)
    assert before["mask"][0] == [f"{BRATS}_seg.nii.gz"] and before["mask"][1]
    assert "patient101_4d.nii.gz" in before["volume"][0]
    masks_task, volume_task = before["mask"][1][0], before["volume"][1][0]

    r = client.post(f"/api/v1/drops/{drop_id}/replan")
    assert r.status_code == 200, r.text
    out = r.json()
    s = out["replan"]
    assert s["changed"] is True
    assert s["retiredStudios"] == [masks_task] and not s["keptAnnotated"]
    assert len(s["createdStudios"]) == 1
    after = _layout(pid)
    assert set(after) == {"volume", "volume-time"}
    assert after["volume"] == (sorted(f"{BRATS}_{x}.nii.gz" for x in ("seg", "t1", "t2")), [volume_task])
    assert after["volume-time"] == (["patient101_4d.nii.gz"], s["createdStudios"])
    assert out["state"] == "applied" and s["createdStudios"][0] in out["taskIds"] and masks_task not in out["taskIds"]
    with kdb.session_scope() as db:
        t = db.scalar(select(TaskRow).where(TaskRow.id == masks_task).execution_options(include_trashed=True))
        assert t is not None and t.trashed_at is not None  # trashed, never hard-deleted
        assert db.scalar(select(PluginAudit).where(PluginAudit.action == "drop.replanned", PluginAudit.target == drop_id)) is not None

    # Same rules again: nothing changes.
    again = client.post(f"/api/v1/drops/{drop_id}/replan").json()
    assert again["replan"]["changed"] is False
    assert not any(again["replan"][k] for k in ("moved", "createdStudios", "createdCollections", "retiredStudios"))
    assert _layout(pid) == after


def test_replan_keeps_an_annotated_studio(client, monkeypatch):
    pid, drop_id = _old_style_drop(client, monkeypatch)
    masks_task = _task_of(pid, "mask")
    with kdb.session_scope() as db:
        doc = db.get(AnnotationDocumentRow, (pid, masks_task))
        if doc is None:
            doc = AnnotationDocumentRow(workspace_id=pid, task_id=masks_task)
            db.add(doc)
        doc.annotations = [{"id": "a1", "label": "tumor"}]
    s = client.post(f"/api/v1/drops/{drop_id}/replan").json()["replan"]
    assert s["keptAnnotated"] == [masks_task] and not s["retiredStudios"]
    after = _layout(pid)
    assert after["mask"] == ([], [masks_task])
    assert f"{BRATS}_seg.nii.gz" in after["volume"][0]
    again = client.post(f"/api/v1/drops/{drop_id}/replan").json()["replan"]
    assert again["changed"] is False and again["keptAnnotated"] == [masks_task]


@pytest.mark.parametrize("who", ["agent"])
def test_only_a_person_replans(client, monkeypatch, who):
    pid, drop_id = _old_style_drop(client, monkeypatch)
    from .test_drops import _agent

    r = client.post(f"/api/v1/drops/{drop_id}/replan", headers=_agent(pid))
    assert r.status_code in (403, 404), r.text
