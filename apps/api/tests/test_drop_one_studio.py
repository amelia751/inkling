"""todo19 D4/D5 (P0-4): a drop makes one Studio over every kind it holds. Presets compose into
`data.kinds` profiles, labels say which kind they apply to, and the policy checks each profile."""

from __future__ import annotations

from pathlib import Path

from studio_api.kernel import environment_policy as policy, environment_resolve as er

ROOT = Path(__file__).resolve().parents[3]
ALL = ["preset:image-2d", "preset:volume-3d", "preset:cine-4d", "preset:ecg", "preset:video", "preset:pathology"]


def test_several_presets_compose_into_profiles():
    merged = er.merged_spec({"extends": ["preset:image-2d", "preset:ecg"]}, ROOT)
    kinds = merged["data"]["kinds"]
    assert len(kinds) == 2 and {p["profile"] for p in kinds.values()} == {"preset:image-2d", "preset:ecg"}
    ecg_kind = next(k for k, p in kinds.items() if p["profile"] == "preset:ecg")
    assert all(p["renderer"] for p in kinds.values())
    # Every label group says the kind(s) it came for.
    assert merged["labels"] and all(g.get("appliesTo") for g in merged["labels"])
    assert any(g["appliesTo"] == [ecg_kind] for g in merged["labels"])
    # The first preset stays the one-kind shorthand.
    assert merged["data"]["kind"] != ecg_kind


def test_one_preset_merges_as_before():
    one = er.merged_spec({"extends": "preset:ecg"}, ROOT)
    assert "kinds" not in (one.get("data") or {}) and not any("appliesTo" in g for g in one.get("labels") or [])


def test_every_bundled_profile_composes_without_errors():
    issues = er.resolve_issues({"extends": ALL}, ROOT)
    assert [i for i in issues if i["severity"] == "error"] == []


def test_normalize_folds_the_shorthand():
    n = er.normalize({"data": {"kind": "k"}, "viewports": [{"name": "a", "renderer": "r", "config": {"x": 1}}]})
    assert n["data"]["kinds"] == {"k": {"renderer": "r", "config": {"x": 1}}} and n["accepts"] == ["k"]


def test_policy_rejects_a_label_for_a_kind_the_studio_doesnt_accept():
    merged = er.merged_spec({"extends": ["preset:image-2d", "preset:ecg"]}, ROOT)
    kinds = list(merged["data"]["kinds"])
    env = {"extends": ["preset:image-2d", "preset:ecg"], "accepts": kinds[:1], "labels": [{"name": "rhythm", "control": "Choices", "appliesTo": [kinds[1]], "classes": [{"id": "AF"}]}]}
    r = policy.check_write(principal="person", installed=[], environment=env)
    assert not r.ok
    e = next(e for e in r.errors if e["code"] == "label-applies-to")
    assert e["path"].endswith("/appliesTo") and "accepts" in e["suggestion"]


def test_policy_rejects_a_profile_whose_renderer_doesnt_consume_its_kind():
    merged = er.merged_spec({"extends": ["preset:image-2d", "preset:ecg"]}, ROOT)
    (img, p_img), (ecg, p_ecg) = list(merged["data"]["kinds"].items())
    env = {"extends": ["preset:image-2d", "preset:ecg"], "data": {"kinds": {ecg: {"renderer": p_img["renderer"]}}}}
    issues = er.resolve_issues(env, ROOT)
    bad = [i for i in issues if i["code"] == "renderer-data-mismatch"]
    assert bad and bad[0]["path"] == f"/data/kinds/{ecg}/renderer" and bad[0].get("suggestion") == p_ecg["renderer"]


def test_boot_takes_extends_and_accepts(client):
    from .test_drops import _project_without_assistant as _project

    pid = _project(client)
    r = client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": "boot-mixed-1", "extends": ["preset:image-2d", "preset:ecg"], "accepts": ["image", "waveform"], "name": "Mixed"})
    assert r.status_code == 202, r.text
    tid = r.json()["taskIds"][0]
    doc = client.get(f"/api/v1/tasks/{tid}/document").json()
    assert doc["environment"]["extends"] == ["preset:image-2d", "preset:ecg"] and doc["accepts"] == ["image", "waveform"]
    bad = client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": "boot-mixed-2", "extends": ["image-2d"]})
    assert bad.status_code == 422 and bad.json()["errors"][0]["path"] == "/extends"


def test_accepts_given_as_data_kind_ids_become_item_kinds(client):
    from .test_drops import _project_without_assistant as _project

    pid = _project(client)
    ids = ["studio.image2d.dataKinds.raster", "studio.cine.dataKinds.volume-time", "studio.timeseries.dataKinds.multichannel-timeseries", "studio.wsi.dataKinds.raster-pyramid"]
    r = client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": "boot-ids-1", "extends": ["preset:image-2d", "preset:cine-4d", "preset:ecg", "preset:pathology"], "accepts": ids, "name": "Ids"})
    assert r.status_code == 202, r.text
    doc = client.get(f"/api/v1/tasks/{r.json()['taskIds'][0]}/document").json()
    assert doc["accepts"] == ["image", "dicom", "volume-time", "waveform", "slide"]


def test_a_mixed_drop_makes_one_studio(client):
    from sqlalchemy import select

    from studio_api import db as kdb
    from studio_api.models import DropPlanRow, TaskRow

    from .test_drops import _drop, _project_without_assistant as _project, _report

    pid = _project(client)
    files = {"x/chest.png": b"png", "v/clip.mp4": b"mp4", "m/brain.nii.gz": b"nii"}
    drop, imp = _drop(client, pid, files)
    _report(client, imp, {"chest.png": "image", "clip.mp4": "video", "brain.nii.gz": "volume"}, {})
    with kdb.session_scope() as db:
        row = db.get(DropPlanRow, drop["id"])
        assert row is not None and row.state == "applied", row and (row.state, row.error)
        assert [a["type"] for a in row.plan["actions"]].count("new_dataset") == 1
        tasks = list(db.scalars(select(TaskRow).where(TaskRow.project_id == pid)))
        assert len(tasks) == 1 and sorted(tasks[0].accepts) == ["image", "video", "volume"]
        tid = tasks[0].id
    doc = client.get(f"/api/v1/tasks/{tid}/document").json()
    assert sorted((a["name"], a["kind"]) for a in doc["assets"]) == [("brain.nii.gz", "volume"), ("chest.png", "image"), ("clip.mp4", "video")]
    assert all(a.get("profile") for a in doc["assets"])


def test_a_hidden_sidecar_is_a_slot_of_its_group_not_a_reference():
    from studio_api.kernel import drops_classify as dc

    side = {"sidecar": {"role": "info", "slot": "info", "group": "patient001", "hidden": True, "consumedBy": ["v1"]}}
    files = [dc.FileIn("v1", "volume", "volume", {"frames": 30}), dc.FileIn("cfg", "document", "unknown", side), dc.FileIn("loose", "document", "document")]
    groups = dc.classify(files, dc.Context())
    assert [(g.kind, g.node_ids, g.count, g.action) for g in groups] == [("volume-time", ["v1", "cfg"], 1, "new_dataset"), ("document", ["loose"], 1, "keep_reference")]
