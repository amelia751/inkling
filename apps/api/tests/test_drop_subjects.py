"""A nested imaging drop (BraTS sequences + their `_seg`, an ACDC 4D cine): reference segmentations
join their subject's volumes instead of a Masks Studio, a 4D volume gets the cine collection, and
the task document gives volume items a `subject` / `sequence`."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.kernel import drops_classify as dc
from studio_api.kernel.kinds import mask_volumes, subject_sequence
from studio_api.models import DatasetCollectionRow, DropPlanRow, TaskRow

from .test_drops import _drop, _project, _report

BRATS = "BraTS2021_00621"


def test_subject_sequence_vocabulary():
    assert subject_sequence(f"{BRATS}_t1ce.nii.gz") == (BRATS, "t1ce")
    assert subject_sequence(f"{BRATS}_FLAIR.nii") == (BRATS, "flair")
    assert subject_sequence("patient101_frame01_gt.nii.gz") == ("patient101_frame01", "gt")
    assert subject_sequence("patient101_4d.nii.gz") == ("patient101_4d", None)
    assert subject_sequence("scan.nii.gz") == ("scan", None)
    assert subject_sequence("x.png") is None


def test_a_seg_beside_its_subjects_volumes_is_part_of_them():
    nodes = [
        ("t1", "brain", f"{BRATS}_t1.nii.gz", "volume"),
        ("t2", "brain", f"{BRATS}_t2.nii.gz", "volume"),
        ("seg", "brain", f"{BRATS}_seg.nii.gz", "mask"),
        ("gt", "acdc", "patient101_frame01_gt.nii.gz", "mask"),
        ("fr", "acdc", "patient101_frame01.nii.gz", "volume"),
        ("lone", "masks", "case9_seg.nii.gz", "mask"),
        ("other", "elsewhere", f"{BRATS}_seg.nii.gz", "mask"),
    ]
    assert mask_volumes(nodes) == {"seg": "t1", "gt": "fr"}
    files = [dc.FileIn("t1", "volume", "volume"), dc.FileIn("t2", "volume", "volume"), dc.FileIn("seg", "mask", "mask", part_of="t1"), dc.FileIn("lone", "mask", "mask")]
    groups = dc.classify(files, dc.Context())
    vol = next(g for g in groups if g.kind == "volume")
    assert vol.node_ids == ["t1", "t2", "seg"] and vol.count == 2
    # A mask with no volume of its subject keeps a Masks collection.
    assert [g.node_ids for g in groups if g.kind == "mask"] == [["lone"]]


def test_a_4d_volume_is_its_own_cine_group():
    files = [dc.FileIn("v", "volume", "volume", {"slices": 155}), dc.FileIn("c", "volume", "volume", {"slices": 10, "frames": 30}), dc.FileIn("one", "volume", "volume", {"frames": 1})]
    groups = dc.classify(files, dc.Context())
    assert {g.kind: g.node_ids for g in groups} == {"volume": ["v", "one"], "volume-time": ["c"]}
    from .test_drops_classify import preset

    p = dc.plan("drp-1", groups, dc.Context(), preset)
    by_kind = {a["kind"]: a for a in p["actions"]}
    assert by_kind["volume-time"]["preset"] == "preset:cine-4d" and by_kind["volume-time"]["name"] == "4D cine"
    assert by_kind["volume"]["preset"] == "preset:volume-3d"


def test_the_drop_groups_subjects_and_the_document_names_them(client):
    pid = _project(client)
    seqs = ["t1", "t1ce", "t2", "flair"]
    files = {f"brain/{BRATS}_{s}.nii.gz": f"vol-{s}".encode() for s in seqs}
    files[f"brain/{BRATS}_seg.nii.gz"] = b"seg"
    files["cine/patient101_4d.nii.gz"] = b"cine"
    files["plain/scan.nii.gz"] = b"plain"
    drop, imp = _drop(client, pid, files)
    kinds = {n.split("/")[-1]: "volume" for n in files}
    kinds[f"{BRATS}_seg.nii.gz"] = "mask"
    facts = {"patient101_4d.nii.gz": {"slices": 10, "frames": 30}, f"{BRATS}_seg.nii.gz": {"sequence": "seg"}}
    _report(client, imp, kinds, facts)
    with kdb.session_scope() as db:
        row = db.get(DropPlanRow, drop["id"])
        assert row is not None
        assert sorted((g["kind"], g["count"]) for g in row.groups) == [("volume", 5), ("volume-time", 1)], row.groups
        tasks = {db.get(DatasetCollectionRow, t.collection_id).kind: t.id for t in db.scalars(select(TaskRow).where(TaskRow.project_id == pid))}
    assert set(tasks) == {"volume", "volume-time"}, tasks
    doc = client.get(f"/api/v1/tasks/{tasks['volume']}/document").json()
    got = {a["name"]: (a.get("subject"), a.get("sequence")) for a in doc["assets"]}
    assert got == {**{f"{BRATS}_{s}.nii.gz": (BRATS, s) for s in seqs}, f"{BRATS}_seg.nii.gz": (BRATS, "seg"), "scan.nii.gz": ("scan", None)}
    cine = client.get(f"/api/v1/tasks/{tasks['volume-time']}/document").json()["assets"]
    assert [(a["name"], a["subject"], a.get("frames")) for a in cine] == [("patient101_4d.nii.gz", "patient101_4d", 30)]
