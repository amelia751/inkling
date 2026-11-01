"""todo13 Milestone 2 (kernel): drops are classified after inspection, planned, applied (by a
person, by D6's auto-apply or by the fast path) and undone; collections scope Studios; a second,
different drop never changes the open Studio; dataset structure drafts and proposals."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from studio_api import db as kdb
from studio_api.kernel import drops_plan, pipeline_client
from studio_api.models import DatasetCollectionRow, DatasetRepo, DropPlanRow, ImportSession, PluginEvent, TaskRow

from .conftest import png, worker_headers
from .test_explore import _report
from .test_projects import _import

CT = {"dicom": {"modality": "CT"}, "series": {"seriesUidHash": "ser-ct-1", "sliceCount": 3}}


def _project(client, title="Chest") -> str:
    return client.post("/api/v1/projects", json={"title": title}).json()["id"]


def _drop(client, p: str, files: dict[str, bytes], drop_id: str, kinds: dict[str, str], facts: dict[str, dict] | None = None, flags: dict[str, dict] | None = None, **totals) -> dict:
    """An import that belongs to drop `drop_id` (todo13-drops sets `import_sessions.drop_id`;
    until it merges, `totals.dropId`), inspected with the given kinds."""
    imp = _import(client, p, files)
    with kdb.session_scope() as s:
        row = s.get(ImportSession, imp["id"])
        row.totals = {**(row.totals or {}), "dropId": drop_id, **totals}
    _report(client, imp, kinds, facts, flags)
    return imp


def _events(p: str, prefix: str = "drop.") -> list[tuple[str, dict]]:
    with kdb.session_scope() as s:
        rows = s.scalars(select(PluginEvent).where(PluginEvent.workspace_id == p).order_by(PluginEvent.created_at)).all()
        return [(e.type, e.payload) for e in rows if e.type.startswith(prefix)]


def _pngs(n: int, folder="films") -> dict[str, bytes]:
    return {f"{folder}/img{i:03d}.png": png(8 + i, 8) for i in range(n)}


def _flags(make_client, **kw):
    return make_client(**kw)


# ---- Classification and the person's Apply / Undo --------------------------------------------


def test_a_drop_is_classified_and_planned_and_waits_for_the_person_with_flags_off(client):
    p = _project(client)
    files = _pngs(3)
    _drop(client, p, files, "drp_png1", {n.split("/")[-1]: "image" for n in files})
    evs = _events(p)
    assert [k for k, _ in evs] == ["drop.classified", "drop.planned"]
    assert evs[0][1] == {"dropId": "drp_png1", "groups": [{"groupId": "g-image", "kind": "image", "count": 3, "suggestedAction": "new_dataset"}]}
    plan = evs[1][1]
    assert plan["auto"] is False and plan["plan"]["needsPerson"] is False
    (a,) = plan["plan"]["actions"]
    assert a["type"] == "new_dataset" and a["preset"] == "preset:image-2d" and len(a["nodeIds"]) == 3
    got = client.get("/api/v1/drops/drp_png1/plan").json()
    assert got["state"] == "planned" and got["taskIds"] == [] and got["undoUntil"] is None


def test_apply_makes_a_draft_dataset_collection_and_studio_and_undo_takes_them_back(client):
    p = _project(client)
    files = _pngs(3)
    _drop(client, p, files, "drp_png2", {n.split("/")[-1]: "image" for n in files})
    r = client.post("/api/v1/drops/drp_png2/apply", json={})
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["state"] == "applied" and len(st["taskIds"]) == 1 and len(st["collectionIds"]) == 1 and st["undoUntil"]
    task = st["taskIds"][0]
    t = client.get(f"/api/v1/tasks/{task}").json()
    assert t["state"] == "draft" and t["collectionId"] == st["collectionIds"][0]
    doc = client.get(f"/api/v1/tasks/{task}/document").json()
    assert sorted(a["name"] for a in doc["assets"]) == ["img000.png", "img001.png", "img002.png"] and doc["collectionId"] == st["collectionIds"][0]
    ds = client.get(f"/api/v1/projects/{p}/datasets/{st['datasetId']}").json()
    assert ds["draft"] is True and [c["kind"] for c in ds["collections"]] == ["image"] and ds["collections"][0]["files"] == 3 and ds["collections"][0]["taskIds"] == [task]
    applied = [pl for k, pl in _events(p) if k == "drop.applied"]
    assert applied[-1]["taskIds"] == [task] and applied[-1]["datasetId"] == st["datasetId"] and applied[-1]["undoUntil"] == st["undoUntil"]
    # The draft structure has the collection, suggested, with technical fields.
    s = client.get(f"/api/v1/datasets/{st['datasetId']}/structure").json()
    (col,) = s["structure"]["collections"]
    assert col["id"] == st["collectionIds"][0] and col["suggested"] is True and {f["id"] for f in col["fields"]} == {"fact:width", "fact:height"}

    # Applying twice answers the same; Undo takes it all back (Files stay).
    assert client.post("/api/v1/drops/drp_png2/apply", json={}).json()["taskIds"] == [task]
    u = client.post("/api/v1/drops/drp_png2/undo")
    assert u.status_code == 200 and u.json()["state"] == "undone", u.text
    assert client.get(f"/api/v1/tasks/{task}").status_code == 404
    assert client.get(f"/api/v1/projects/{p}/datasets/{st['datasetId']}").status_code == 404
    assert _events(p)[-1] == ("drop.applied", {"dropId": "drp_png2", "taskIds": [], "undoUntil": None, "collectionIds": [], "undone": True})
    assert len(client.get(f"/api/v1/projects/{p}/fs/children").json()["items"]) == 1  # the Files folder is still there
    assert client.post("/api/v1/drops/drp_png2/undo").status_code == 409


def test_undo_window_and_annotations_guard(client):
    p = _project(client)
    files = _pngs(2)
    _drop(client, p, files, "drp_png3", {n.split("/")[-1]: "image" for n in files})
    st = client.post("/api/v1/drops/drp_png3/apply", json={}).json()
    with kdb.session_scope() as s:
        s.get(DropPlanRow, "drp_png3").undo_until = datetime.now(UTC) - timedelta(seconds=1)
    assert client.post("/api/v1/drops/drp_png3/undo").status_code == 409
    assert client.get(f"/api/v1/tasks/{st['taskIds'][0]}").status_code == 200


def test_change_before_apply_moves_a_group_and_never_adds_files(client):
    p = _project(client)
    files = {"docs/protocol.pdf": b"%PDF-1.4 x", **_pngs(2)}
    _drop(client, p, files, "drp_mix", {"protocol.pdf": "document", "img000.png": "image", "img001.png": "image"})
    plan = client.get("/api/v1/drops/drp_mix/plan").json()["plan"]
    img = next(a for a in plan["actions"] if a["kind"] == "image")
    pdf = next(a for a in plan["actions"] if a["kind"] == "document")
    assert pdf["type"] == "keep_reference" and pdf["asks"] == "attach_documentation"
    # A file of another group can't be pulled in.
    bad = client.put("/api/v1/drops/drp_mix/plan", json={"actions": [{"groupId": img["groupId"], "nodeIds": [*img["nodeIds"], *pdf["nodeIds"]]}]})
    assert bad.status_code == 422
    ok = client.put("/api/v1/drops/drp_mix/plan", json={"actions": [{"groupId": img["groupId"], "type": "keep_reference"}]})
    assert ok.status_code == 200 and {a["type"] for a in ok.json()["plan"]["actions"]} == {"keep_reference"}
    st = client.post("/api/v1/drops/drp_mix/apply", json={}).json()
    assert st["taskIds"] == [] and st["undoUntil"] is None  # nothing to undo: Files only


# ---- D6 auto-apply, the fast path, a second different drop --------------------------------------


def test_auto_apply_on_own_drafts_with_the_flag(make_client):
    client = make_client(feature_auto_apply=True)
    p = _project(client)
    files = _pngs(2)
    _drop(client, p, files, "drp_auto", {n.split("/")[-1]: "image" for n in files})
    kinds = [k for k, _ in _events(p)]
    assert kinds == ["drop.classified", "drop.planned", "drop.applied"]
    planned = _events(p)[1][1]
    assert planned["auto"] is True
    st = client.get("/api/v1/drops/drp_auto/plan").json()
    assert st["state"] == "applied" and st["auto"] is True and st["fastPath"] is False and len(st["taskIds"]) == 1


def test_fast_path_boots_without_the_agent_and_maps_request_labels(make_client):
    client = make_client(feature_fast_path=True)
    p = _project(client)
    files = _pngs(3)
    _drop(client, p, files, "drp_fast", {n.split("/")[-1]: "image" for n in files}, request="Label these chest X-rays as normal or pneumonia")
    st = client.get("/api/v1/drops/drp_fast/plan").json()
    assert st["state"] == "applied" and st["fastPath"] is True and len(st["taskIds"]) == 1
    task = st["taskIds"][0]
    env = client.get(f"/api/environments/{task}").json()["environment"]
    assert env["extends"] == "preset:image-2d"
    assert [c["id"] for c in env["labels"][0]["classes"]] == ["normal", "pneumonia"]
    s = client.get(f"/api/v1/datasets/{st['datasetId']}/structure").json()["structure"]
    (ann,) = s["annotations"]
    # The same stable label ids in the structure and the environment.
    assert [x["id"] for x in ann["labels"]] == ["normal", "pneumonia"] and ann["collectionId"] == st["collectionIds"][0]
    applied = [pl for k, pl in _events(p) if k == "drop.applied"][-1]
    assert applied["fastPath"] is True and applied["auto"] is True


def test_fast_path_waits_on_an_ambiguous_drop(make_client):
    client = make_client(feature_fast_path=True)
    p = _project(client)
    files = {**_pngs(1), "clips/a.mp4": b"\x00\x00\x00\x18ftypmp42"}
    _drop(client, p, files, "drp_amb", {"img000.png": "image", "a.mp4": "video"})
    assert client.get("/api/v1/drops/drp_amb/plan").json()["state"] == "planned"


def test_a_second_different_drop_adds_a_collection_and_never_changes_the_open_studio(make_client):
    client = make_client(feature_auto_apply=True)
    p = _project(client)
    files = _pngs(2)
    _drop(client, p, files, "drp_j1", {n.split("/")[-1]: "image" for n in files})
    first = client.get("/api/v1/drops/drp_j1/plan").json()
    xray = first["taskIds"][0]
    env_before = client.get(f"/api/environments/{xray}").json()
    doc_before = client.get(f"/api/v1/tasks/{xray}/document").json()["assets"]

    # J4: in the X-ray Studio, drop a CT series.
    ct = {f"ct/slice{i}.dcm": b"DICM" + bytes([i]) * 40 for i in range(3)}
    _drop(client, p, ct, "drp_j4", {n.split("/")[-1]: "dicom" for n in ct}, {n.split("/")[-1]: CT for n in ct}, taskId=xray)
    st = client.get("/api/v1/drops/drp_j4/plan").json()
    (a,) = st["plan"]["actions"]
    assert a["type"] == "new_collection" and a["datasetId"] == first["datasetId"] and a["preset"] == "preset:volume-3d" and a["name"] == "CT series"
    assert st["state"] == "applied" and st["datasetId"] == first["datasetId"] and len(st["taskIds"]) == 1 and st["taskIds"][0] != xray
    cols = client.get(f"/api/v1/projects/{p}/datasets/{first['datasetId']}/collections").json()["collections"]
    assert sorted(c["kind"] for c in cols) == ["dicom-series", "image"]
    # The X-ray Studio: same environment revision, same items.
    assert client.get(f"/api/environments/{xray}").json()["revision"] == env_before["revision"]
    assert client.get(f"/api/v1/tasks/{xray}/document").json()["assets"] == doc_before
    ct_doc = client.get(f"/api/v1/tasks/{st['taskIds'][0]}/document").json()["assets"]
    assert sorted(x["name"] for x in ct_doc) == ["slice0.dcm", "slice1.dcm", "slice2.dcm"]

    # More X-rays join the X-ray collection (add_to_collection), live in its Studio.
    more = {"more/new.png": png(30, 30)}
    _drop(client, p, more, "drp_j3", {"new.png": "image"}, taskId=xray)
    st3 = client.get("/api/v1/drops/drp_j3/plan").json()
    assert st3["plan"]["actions"][0]["type"] == "add_to_collection" and st3["taskIds"] == [xray]
    assert "new.png" in {x["name"] for x in client.get(f"/api/v1/tasks/{xray}/document").json()["assets"]}


def test_mixed_drop_j5_pdf_zip_mp3_and_a_csv_keyed_by_file_name(client):
    p = _project(client)
    files = {"in/protocol.pdf": b"%PDF-1.4", "in/scans.zip": b"PK\x03\x04zz", "in/voice.mp3": b"ID3x", "in/labels.csv": b"file,label\nimg000.png,a\n", **_pngs(2, "in")}
    kinds = {"protocol.pdf": "document", "scans.zip": "archive", "voice.mp3": "unknown", "labels.csv": "table", "img000.png": "image", "img001.png": "image"}
    facts = {"labels.csv": {"table": {"columnCount": 2, "columns": [{"name": "file", "type": "id"}, {"name": "label", "type": "category"}], "nameColumns": ["file"]}}}
    _drop(client, p, files, "drp_j5", kinds, facts)
    st = client.get("/api/v1/drops/drp_j5/plan").json()
    by = {a["kind"]: a for a in st["plan"]["actions"]}
    assert by["document"]["type"] == "keep_reference"
    assert by["archive"]["type"] == "unpack"
    assert by["unknown"]["type"] == "keep_unsupported" and by["unknown"]["asks"] == "find_plugin"
    assert by["table"]["asks"] == "labels_table" and by["table"]["relatesTo"] == "g-image"
    assert st["plan"]["needsPerson"] is True
    # The person's Apply answers yes: the table becomes a collection related to the images; the ZIP is unpacked.
    out = client.post("/api/v1/drops/drp_j5/apply", json={}).json()
    assert out["state"] == "applied"
    s = client.get(f"/api/v1/datasets/{out['datasetId']}/structure").json()["structure"]
    kinds_ = {c["kind"]: c for c in s["collections"]}
    assert set(kinds_) == {"image", "table"}
    assert [f["id"] for f in kinds_["table"]["fields"]] == ["col:file", "col:label"]
    (rel,) = s["relationships"]
    assert rel["from"] == kinds_["table"]["id"] and rel["to"] == kinds_["image"]["id"] and rel["suggested"] is True
    unpack = [pl for k, pl in _events(p, "archive.") if k == "archive.unpack.requested"]
    assert len(unpack) == 1 and unpack[0]["dropId"] == "drp_j5" and unpack[0]["depth"] == 1


def test_an_existing_file_links_instead_of_reuploading(client):
    p = _project(client)
    files = _pngs(2)
    _drop(client, p, files, "drp_d1", {n.split("/")[-1]: "image" for n in files})
    client.post("/api/v1/drops/drp_d1/apply", json={})
    # J6: the same files again: skipped as duplicates, linked to the existing Files.
    imp = _import(client, p, files)
    with kdb.session_scope() as s:
        row = s.get(ImportSession, imp["id"])
        row.totals = {**(row.totals or {}), "dropId": "drp_d2"}
    assert imp["state"] in ("ready", "inspecting", "failed")
    with kdb.session_scope() as s:
        drops_plan.classify_drop(s, p, "drp_d2")
    st = client.get("/api/v1/drops/drp_d2/plan").json()
    assert [a["type"] for a in st["plan"]["actions"]] == ["link_existing"] and st["groups"][0]["existing"] == 2
    tasks = client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"][0]["tasks"]
    before = client.get(f"/api/v1/tasks/{tasks[0]['id']}/document").json()["assets"]
    client.post("/api/v1/drops/drp_d2/apply", json={})
    assert client.get(f"/api/v1/tasks/{tasks[0]['id']}/document").json()["assets"] == before  # no duplicate items


# ---- Who may apply ------------------------------------------------------------------------------


def _agent(client, p: str, run="run_org-1") -> dict:
    tok = client.post("/api/v1/sessions", json={"agent": "assistant", "profile": "assistant", "scopes": ["proposals.write"]}, headers={"X-Workspace-Id": p}).json()["token"]
    return {"Authorization": f"Bearer {tok}", "X-Agent-Run": run}


def test_an_agent_applies_only_d6_safe_plans_and_never_undoes(client):
    p = _project(client)
    files = _pngs(1)
    _drop(client, p, files, "drp_ag1", {"img000.png": "image"})
    a = _agent(client, p)
    assert client.get("/api/v1/drops/drp_ag1/plan", headers=a).status_code == 200
    r = client.post("/api/v1/drops/drp_ag1/apply", json={}, headers=a)
    assert r.status_code == 200, r.text
    assert client.post("/api/v1/drops/drp_ag1/undo", headers=a).status_code == 403
    # A plan with a question waits for the person.
    files2 = {"t/labels.csv": b"file\nimg000.png\n", "t/img000.png": png(50, 50)}
    _drop(client, p, files2, "drp_ag2", {"labels.csv": "table", "img000.png": "image"}, {"labels.csv": {"table": {"nameColumns": ["file"]}}})
    assert client.post("/api/v1/drops/drp_ag2/apply", json={}, headers=a).status_code == 403


def test_a_viewer_cant_apply(client):
    from .test_files import _add_member

    p = _project(client)
    _drop(client, p, _pngs(1), "drp_v", {"img000.png": "image"})
    _add_member(p, "user:viewer", "viewer")
    v = {"X-Dev-Principal": "user:viewer"}
    assert client.get("/api/v1/drops/drp_v/plan", headers=v).status_code == 200
    assert client.post("/api/v1/drops/drp_v/apply", json={}, headers=v).status_code == 403
    assert client.put("/api/v1/drops/drp_v/plan", json={"actions": []}, headers=v).status_code == 403


# ---- Collections: boots, the backfill job, task documents ---------------------------------------


def test_boot_on_a_collection_and_the_collection_filter(client):
    p = _project(client)
    imp = _import(client, p, {"m/a.png": png(4, 4), "m/b.dcm": b"DICM" + b"x" * 30})
    _report(client, imp, {"a.png": "image", "b.dcm": "dicom"}, {"b.dcm": {"dicom": {"modality": "CR"}}})
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Mixed", "nodeIds": [client.get(f"/api/v1/projects/{p}/fs/children").json()["items"][0]["id"]], "task": {"title": "All", "preset": "preset:image-2d"}}).json()
    old_task = ds["tasks"][0]["id"]
    cols = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}/collections").json()["collections"]
    assert sorted(c["kind"] for c in cols) == ["dicom", "image"]
    # The person's task (made before collections, on a mixed dataset) still sees everything.
    assert {a["name"] for a in client.get(f"/api/v1/tasks/{old_task}/document").json()["assets"]} == {"a.png", "b.dcm"}
    dicom = next(c for c in cols if c["kind"] == "dicom")
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-col00001", "preset": "preset:image-2d", "collectionId": dicom["id"]})
    assert r.status_code == 202, r.text
    t = r.json()["taskIds"][0]
    assert client.get(f"/api/v1/tasks/{t}").json()["collectionId"] == dicom["id"]
    assert [a["name"] for a in client.get(f"/api/v1/tasks/{t}/document").json()["assets"]] == ["b.dcm"]
    assert client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-col00002", "preset": "preset:image-2d", "collectionId": "col-nope"}).status_code == 422
    assert len(client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"]) == 1  # no new dataset


def test_an_empty_boot_gets_an_empty_collection_of_the_presets_kind(client):
    p = _project(client)
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-empty0001", "preset": "preset:image-2d", "name": "Chest X-ray"}).json()
    t = client.get(f"/api/v1/tasks/{r['taskIds'][0]}").json()
    ds = client.get(f"/api/v1/projects/{p}/datasets/{t['datasetId']}").json()
    assert ds["draft"] is True and [(c["kind"], c["files"]) for c in ds["collections"]] == [("image", 0)] and t["collectionId"] == ds["collections"][0]["id"]


def test_backfill_job_gives_single_kind_datasets_a_collection_and_their_tasks(client):
    from studio_api.kernel import collections

    p = _project(client)
    imp = _import(client, p, {"k/a.png": png(4, 4)})
    _report(client, imp, {"a.png": "image"})
    folder = client.get(f"/api/v1/projects/{p}/fs/children").json()["items"][0]["id"]
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "One", "nodeIds": [folder], "task": {"title": "T", "preset": "preset:image-2d"}}).json()
    with kdb.session_scope() as s:
        assert collections.backfill_all(s)["tasks"] >= 1
        t = s.get(TaskRow, ds["tasks"][0]["id"])
        c = s.get(DatasetCollectionRow, t.collection_id)
        assert c.kind == "image" and c.dataset_id == ds["id"]
        assert collections.backfill_all(s) == {"datasets": 0, "tasks": 0}  # idempotent


# ---- D9: the pipeline path ---------------------------------------------------------------------


class _StubPipeline:
    def __init__(self):
        self.runs: list[dict] = []
        self.cancelled: list[str] = []

    def create_run(self, ctx, body, key):
        self.runs.append(body)
        return {"run_id": f"run-{len(self.runs)}", "state": "queued"}

    def cancel_run(self, ctx, run_id, key):
        self.cancelled.append(run_id)
        return {}


def test_apply_starts_the_ingest_pipeline_when_configured(make_client):
    client = make_client(pipeline_url="http://pipeline.invalid")
    stub = _StubPipeline()
    pipeline_client.set_client(stub)  # type: ignore[arg-type]
    try:
        p = _project(client)
        _drop(client, p, _pngs(1), "drp_pipe", {"img000.png": "image"})
        # Add to a versioned dataset: the run's candidate goes to its work branch.
        st = client.post("/api/v1/drops/drp_pipe/apply", json={}).json()
        assert "pipelineRunIds" not in st  # the new dataset isn't versioned yet: kernel apply only
        with kdb.session_scope() as s:
            s.add(DatasetRepo(workspace_id=p, dataset_id=st["datasetId"], repo_id="repo-1", created_by="user:local-expert"))
        _drop(client, p, {"more/x.png": png(9, 9)}, "drp_pipe2", {"x.png": "image"}, taskId=st["taskIds"][0])
        st2 = client.post("/api/v1/drops/drp_pipe2/apply", json={}).json()
        assert st2["pipelineRunIds"] == ["run-1"]
        (run,) = stub.runs
        assert run["definition_id"] == "ingest" and run["target"]["repo_id"] == "repo-1" and run["target"]["branch"].startswith("work/") and run["inputs"]["upload"]["session_id"]
        assert [pl for k, pl in _events(p) if k == "drop.applied"][-1]["pipelineRunIds"] == ["run-1"]
        client.post("/api/v1/drops/drp_pipe2/undo")
        assert stub.cancelled == ["run-1"]
    finally:
        pipeline_client.set_client(None)


# ---- Dataset structure --------------------------------------------------------------------------

STRUCT = {
    "schemaVersion": 1,
    "collections": [{"id": "col-a", "name": "Chest X-rays", "kind": "image", "formats": ["PNG"], "fields": [], "suggested": True}],
    "relationships": [],
    "annotations": [{"id": "ann-1", "collectionId": "col-a", "geometry": "class", "labels": [{"id": "normal", "name": "Normal"}, {"id": "pneumonia", "name": "Pneumonia"}], "suggested": True}],
}


def _draft_dataset(client, p: str) -> str:
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-struct001", "preset": "preset:image-2d"}).json()
    return client.get(f"/api/v1/tasks/{r['taskIds'][0]}").json()["datasetId"]


def test_structure_draft_writes_validate_and_detect_stale_bases(client):
    p = _project(client)
    d = _draft_dataset(client, p)
    empty = client.get(f"/api/v1/datasets/{d}/structure").json()
    assert empty["structure"]["collections"] == [] and empty["storedIn"] == "kernel"
    assert client.put(f"/api/v1/datasets/{d}/structure", json={"structure": {**STRUCT, "extra": 1}}).status_code == 422
    dangling = {**STRUCT, "annotations": [{**STRUCT["annotations"][0], "collectionId": "col-zz"}]}
    bad = client.put(f"/api/v1/datasets/{d}/structure", json={"structure": dangling})
    assert bad.status_code == 422 and bad.json()["errors"][0]["path"] == "/annotations/0/collectionId"
    ok = client.put(f"/api/v1/datasets/{d}/structure", json={"structure": STRUCT, "baseHash": empty["hash"]})
    assert ok.status_code == 200 and ok.json()["structure"] == STRUCT
    assert client.put(f"/api/v1/datasets/{d}/structure", json={"structure": STRUCT, "baseHash": empty["hash"]}).status_code == 409


def test_propose_structure_writes_the_agents_branch_and_returns_the_diff(client):
    p = _project(client)
    d = _draft_dataset(client, p)
    client.put(f"/api/v1/datasets/{d}/structure", json={"structure": STRUCT})
    a = _agent(client, p)
    mine = {**STRUCT, "annotations": [{**STRUCT["annotations"][0], "labels": [*STRUCT["annotations"][0]["labels"], {"id": "effusion", "name": "Effusion"}]}]}
    r = client.put(f"/api/v1/datasets/{d}/structure", json={"structure": mine}, headers=a)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["branch"].startswith("work/agent-") and out["diff"] == [{"op": "add", "path": "annotations/ann-1/labels/effusion"}] and "accepted" not in out
    # The draft is unchanged until the person accepts.
    assert client.get(f"/api/v1/datasets/{d}/structure").json()["structure"] == STRUCT
    assert client.get(f"/api/v1/datasets/{d}/structure", headers=a).json()["agentDiff"] == out["diff"]
    assert client.post(f"/api/v1/datasets/{d}/structure/accept", json={"branch": out["branch"]}, headers=a).status_code == 403
    acc = client.post(f"/api/v1/datasets/{d}/structure/accept", json={"branch": out["branch"]}).json()
    assert acc["structure"] == mine and acc["diff"] == out["diff"]


def test_a_published_datasets_structure_change_is_a_proposal(client):
    p = _project(client)
    d = _draft_dataset(client, p)
    task = client.get(f"/api/v1/projects/{p}/datasets/{d}").json()["tasks"][0]["id"]
    client.post(f"/api/v1/tasks/{task}/publish")
    r = client.put(f"/api/v1/datasets/{d}/structure", json={"structure": STRUCT})
    assert r.status_code == 202 and r.json()["proposal"]["kind"] == "structure"
    assert client.get(f"/api/v1/datasets/{d}/structure").json()["structure"]["collections"] == []
    pid = r.json()["proposal"]["id"]
    assert client.post(f"/api/v1/proposals/{pid}/confirm", json={}).status_code == 200
    assert client.get(f"/api/v1/datasets/{d}/structure").json()["structure"] == STRUCT


# ---- Archive unpack (kernel side) ---------------------------------------------------------------


def test_unpack_routes_land_entries_next_to_the_archive_as_a_child_drop(client):
    import hashlib

    p = _project(client)
    _drop(client, p, {"in/scans.zip": b"PK\x03\x04zz"}, "drp_zip", {"scans.zip": "archive"})
    client.post("/api/v1/drops/drp_zip/apply", json={})
    (ev,) = [pl for k, pl in _events(p, "archive.") if k == "archive.unpack.requested"]
    W = worker_headers()
    data = png(6, 6)
    entries = [{"clientFileId": "e0", "relPath": "a/one.png", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]
    s = client.post(f"/api/v1/worker/unpack/{ev['nodeId']}/start", json={"dropId": ev["dropId"], "childDropId": ev["childDropId"], "depth": ev["depth"], "entries": entries}, headers=W)
    assert s.status_code == 200, s.text
    sid = s.json()["id"]
    assert client.put(f"/api/v1/worker/unpack/sessions/{sid}/files/e0", content=data, headers=W).json()["state"] == "uploaded"
    done = client.post(f"/api/v1/worker/unpack/sessions/{sid}/complete", headers=W).json()
    assert done["state"] == "inspecting"
    with kdb.session_scope() as x:
        assert x.get(ImportSession, sid).totals["dropId"] == ev["childDropId"]
    # Without the worker token: 401.
    assert client.post(f"/api/v1/worker/unpack/{ev['nodeId']}/start", json={"entries": entries}).status_code == 401
    # Inspection of the child drop classifies it on its own, against the parent's dataset.
    _report(client, {"id": sid}, {"one.png": "image"})
    child = client.get(f"/api/v1/drops/{ev['childDropId']}/plan").json()
    assert child["groups"][0]["kind"] == "image"


def test_a_refused_archive_is_flagged_and_reported(client):
    p = _project(client)
    _drop(client, p, {"in/bomb.zip": b"PK\x03\x04zz"}, "drp_bomb", {"bomb.zip": "archive"})
    client.post("/api/v1/drops/drp_bomb/apply", json={})
    (ev,) = [pl for k, pl in _events(p, "archive.") if k == "archive.unpack.requested"]
    r = client.post(f"/api/v1/worker/unpack/{ev['nodeId']}/refused", json={"dropId": "drp_bomb", "reason": "ratio"}, headers=worker_headers())
    assert r.status_code == 200
    failed = [pl for k, pl in _events(p) if k == "drop.failed"][-1]
    assert failed == {"dropId": "drp_bomb", "step": "unpack", "errorClass": "ratio", "nodeId": ev["nodeId"]}
    node = client.get(f"/api/v1/source-nodes/{ev['nodeId']}").json()
    assert "zip bomb" in str(node["flags"].get("unsupported"))


@pytest.mark.parametrize("route", ["/api/v1/drops/x/plan", "/api/v1/datasets/x/structure"])
def test_unknown_ids_are_404(client, route):
    assert client.get(route).status_code == 404


# ---- "Find a plugin": the catalogue read filters by detected kind --------------------------------


def test_catalogue_searches_data_kinds_by_detected_kind(client):
    img = client.get("/api/catalog", params={"kind": "image"}).json()
    assert [c["type"] for c in img["contributions"]] == ["dataKinds"] and any(c["id"].endswith("image2d.dataKinds.raster") for c in img["contributions"])
    assert {m["id"] for m in img["modules"]} == {c["module"] for c in img["contributions"]}
    series = client.get("/api/catalog", params={"kind": "dicom-series"}).json()["contributions"]
    assert any(c["id"].endswith("volume.dataKinds.volume") for c in series)
    # Audio: no plugin yet (the card says so and links to docs/plugins.md).
    assert client.get("/api/catalog", params={"kind": "audio"}).json()["contributions"] == []
    assert len(client.get("/api/catalog").json()["contributions"]) > 50  # unfiltered as before
