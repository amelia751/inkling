"""todo7: Files, the project's drive (docs/files-api.md). Phase 1 exit list plus Trash,
versions, download, activity, privacy and dataset staleness."""

from __future__ import annotations

import hashlib
import io
import zipfile

import pytest
from sqlalchemy import event, select

from studio_api import blobstore
from studio_api import db as kdb
from studio_api.kernel import tree
from studio_api.models import Asset, FsOp, OrganizationMember, PluginAudit, PluginEvent, ProjectRow, SourceNode

from .conftest import png
from .test_explore import _report
from .test_projects import _import, _session_body

ALICE = "user:local-expert"
BOB = {"X-Dev-Principal": "user:bob"}


# ---- Helpers -----------------------------------------------------------------------------------


def _new(client, files: dict[str, bytes], title: str = "Files") -> tuple[str, str, dict]:
    p = client.post("/api/v1/projects", json={"title": title}).json()["id"]
    imp = _import(client, p, files)
    root = client.get(f"/api/v1/projects/{p}/fs").json()["rootNodeId"]
    return p, root, imp


def _by_name(pid: str) -> dict[str, SourceNode]:
    with kdb.session_scope() as db:
        rows = list(db.scalars(select(SourceNode).where(SourceNode.project_id == pid)))
        for r in rows:
            db.expunge(r)
    return {r.name: r for r in rows}


def _ops(client, pid: str, ops: list[dict], headers: dict | None = None, **extra):
    return client.post(f"/api/v1/projects/{pid}/fs/ops", json={"ops": ops, **extra}, headers=headers or {})


def _children(client, pid: str, node: str | None = None, **params) -> list[dict]:
    q = {"node": node, **params} if node else params
    return client.get(f"/api/v1/projects/{pid}/fs/children", params=q).json()["items"]


def _add_member(pid: str, principal: str = "user:bob", role: str = "editor") -> None:
    with kdb.session_scope() as db:
        p = db.get(ProjectRow, pid)
        assert p is not None
        db.add(OrganizationMember(org_id=p.org_id, principal=principal, role=role))


def _agent(pid: str) -> dict:
    from studio_api.context import issue_session

    with kdb.session_scope() as db:
        token = issue_session(db, "agent:run_1", pid, ["proposals.write"], on_behalf_of=ALICE)
    return {"Authorization": f"Bearer {token}"}


# ---- The drive and listings --------------------------------------------------------------------


def test_one_drive_per_project_with_imports_as_top_level_folders(client):
    p, root, _ = _new(client, {"study/MRI/a.png": png(4, 4), "study/b.csv": b"k,v\n1,2\n"})
    info = client.get(f"/api/v1/projects/{p}/fs").json()
    assert info == {"projectId": p, "rootNodeId": root, "writable": True, "trashCount": 0}
    _import(client, p, {"study/c.png": png(5, 5)})  # the same folder name again: a second top folder
    top = _children(client, p)
    assert [i["name"] for i in top] == ["study", "study (2)"]
    assert all(i["parentId"] == root and i["kind"] == "folder" and i["locked"] is False and "starred" in i for i in top)
    nodes = _by_name(p)
    # New ids are opaque (D3), not hashes of a path.
    assert tree.NEW_ID.fullmatch(nodes["a.png"].id) and nodes["a.png"].original_path == "MRI/a.png"
    detail = client.get(f"/api/v1/source-nodes/{nodes['a.png'].id}").json()
    assert detail["pathText"] == "study/MRI/a.png" and detail["originalPath"] == "MRI/a.png" and detail["version"] == 1
    assert [x["name"] for x in detail["path"]] == ["Sources", "study", "MRI"]
    # The source alias still lists a source's folder.
    src = client.get(f"/api/v1/projects/{p}/sources").json()["sources"][0]
    assert {i["name"] for i in client.get(f"/api/v1/sources/{src['id']}/children").json()["items"]} == {"MRI", "b.csv"}


def test_children_sort_server_side_with_folders_first(client):
    files = {"s/big.bin": b"x" * 500, "s/small.bin": b"y", "s/z/one.bin": b"zz" * 2000, "s/a/one.bin": b"q"}
    p, root, _ = _new(client, files)
    folder = _by_name(p)["s"].id
    by_size = _children(client, p, folder, sort="size", dir="desc")
    assert [i["name"] for i in by_size] == ["z", "a", "big.bin", "small.bin"]
    assert by_size[0]["totalBytes"] == 4000
    assert [i["name"] for i in _children(client, p, folder, sort="name", dir="desc")] == ["z", "a", "small.bin", "big.bin"]
    assert client.get(f"/api/v1/projects/{p}/fs/children", params={"sort": "nope"}).status_code == 422


# ---- Names (D10) -------------------------------------------------------------------------------


def test_mkdir_rename_and_case_insensitive_conflicts(client):
    p, root, _ = _new(client, {"study/scan.png": png(4, 4), "study/Notes.txt": b"n"})
    r = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "MRI  . "}]).json()
    mri = next(n for n in r["nodes"] if n["name"] == "MRI")  # trailing spaces and dots trimmed
    assert r["parentIds"] == [root] and r["summary"] == "Created folder MRI"
    clash = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "mri", "id": "nod-" + "a" * 32}])
    assert clash.status_code == 409
    detail = clash.json()["detail"]
    assert detail["conflicts"][0] | {"existingId": None} == {"nodeId": "nod-" + "a" * 32, "name": "mri", "parentId": root, "parentName": "Sources", "existingId": None, "kind": "folder", "identical": False}
    assert 'An item named "mri" already exists in Sources' == detail["message"]
    both = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "mri", "id": "nod-" + "a" * 32}], resolutions={"*": "keep_both"}).json()
    assert [n["name"] for n in both["nodes"]] == ["mri (2)"] and both["nodes"][0]["id"] == "nod-" + "a" * 32
    for bad, why in (("a/b", "/"), ("", "empty"), ("..", "empty"), ("x" * 256, "255"), ("a\x01", "control")):
        r = _ops(client, p, [{"kind": "rename", "nodeId": mri["id"], "name": bad}])
        assert r.status_code == 422 and why in r.json()["detail"], (bad, r.text)
    nodes = _by_name(p)
    # A case-only rename of the same node is fine; renaming onto a sibling's name (any case) isn't.
    assert _ops(client, p, [{"kind": "rename", "nodeId": nodes["Notes.txt"].id, "name": "notes.txt"}]).status_code == 200
    r = _ops(client, p, [{"kind": "rename", "nodeId": nodes["scan.png"].id, "name": "NOTES.TXT"}])
    assert r.status_code == 409 and r.json()["detail"]["conflicts"][0]["name"] == "NOTES.TXT"
    # All or nothing: the mkdir before the failing rename didn't happen either.
    r = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "Ghost"}, {"kind": "rename", "nodeId": nodes["scan.png"].id, "name": "notes.txt"}])
    assert r.status_code == 409 and "Ghost" not in _by_name(p)


# ---- Moves (D4) --------------------------------------------------------------------------------


def test_moving_a_10k_file_folder_touches_o_depth_rows(client):
    p, root, _ = _new(client, {"study/deep/er/x.png": png(4, 4)})
    nodes = _by_name(p)
    with kdb.session_scope() as db:
        big = SourceNode(**tree._row(id=tree.new_node_id(), source_id=None, project_id=p, project_root=root, parent_id=nodes["er"].id, name="big", original_path="", is_dir=True))
        db.add(big)
        db.flush()
        tree.bump(db, nodes["er"].id, 0, 0, children=1)
        tree.add_files(db, p, None, big.id, [tree.FileSpec(f"f{i:05d}.dcm", None, None, 10) for i in range(10_000)])
        big_id = big.id
    dest = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "dest"}]).json()["nodes"][0]["id"]
    updated: list[int] = []

    def count(conn, cursor, statement, params, context, executemany):
        if statement.lstrip().upper().startswith("UPDATE SOURCE_NODES"):
            updated.append(max(cursor.rowcount, 0))

    event.listen(kdb.engine(), "after_cursor_execute", count)
    try:
        r = _ops(client, p, [{"kind": "move", "nodeIds": [big_id], "parentId": dest}])
    finally:
        event.remove(kdb.engine(), "after_cursor_execute", count)
    assert r.status_code == 200, r.text
    # The node, its old ancestors (er, deep, study, Files) and its new ones (dest, Files): not 10k.
    assert sum(updated) <= 12, updated
    after = _by_name(p)
    assert (after["dest"].descendant_count, after["dest"].total_bytes, after["dest"].child_count) == (10_000, 100_000, 1)
    assert after["er"].descendant_count == 1 and after["study"].descendant_count == 1
    assert after["Sources"].descendant_count == 10_001
    assert after["f00042.dcm"].parent_id == big_id  # children untouched


def test_cycles_are_refused(client):
    p, root, _ = _new(client, {"study/a/b/x.png": png(4, 4)})
    n = _by_name(p)
    r = _ops(client, p, [{"kind": "move", "nodeIds": [n["a"].id], "parentId": n["b"].id}])
    assert r.status_code == 422 and r.json()["detail"] == "Can't move a folder into itself"
    assert _ops(client, p, [{"kind": "move", "nodeIds": [n["a"].id], "parentId": n["a"].id}]).status_code == 422
    assert _ops(client, p, [{"kind": "copy", "nodeIds": [n["a"].id], "parentId": n["b"].id}]).status_code == 422
    assert _ops(client, p, [{"kind": "move", "nodeIds": [root], "parentId": n["b"].id}]).status_code == 422


def test_move_conflicts_and_their_resolutions(client):
    img, other = png(4, 4), png(6, 6)
    p, root, _ = _new(client, {"study/in/A.PNG": img, "study/a.png": other, "study/b.png": png(7, 7), "study/c.png": png(8, 8)})
    n = _by_name(p)
    target = n["in"].id
    r = _ops(client, p, [{"kind": "move", "nodeIds": [n["a.png"].id, n["b.png"].id], "parentId": target}])
    assert r.status_code == 409
    conflicts = r.json()["detail"]["conflicts"]
    assert [(c["name"], c["existingId"], c["parentName"]) for c in conflicts] == [("a.png", n["A.PNG"].id, "in")]
    assert _by_name(p)["b.png"].parent_id == n["study"].id  # nothing moved
    ok = _ops(client, p, [{"kind": "move", "nodeIds": [n["a.png"].id, n["b.png"].id], "parentId": target}], resolutions={n["a.png"].id: "keep_both"}).json()
    assert sorted(x["name"] for x in ok["nodes"]) == ["a (2).png", "b.png"] and ok["summary"] == "Moved 2 items to in"
    assert set(ok["parentIds"]) == {target, n["study"].id}
    # Replace: the existing file gets a new version with the moved file's bytes; the mover goes to Trash.
    _import(client, p, {"study/x/A.PNG": other})
    with kdb.session_scope() as db:
        moved = db.scalars(select(SourceNode).where(SourceNode.project_id == p, SourceNode.name == "A.PNG", SourceNode.parent_id != target)).one()
        db.expunge(moved)
    r = _ops(client, p, [{"kind": "move", "nodeIds": [moved.id], "parentId": target}], resolutions={"*": "replace"}).json()
    with kdb.session_scope() as db:
        existing = db.get(SourceNode, n["A.PNG"].id)
        assert existing.version == 2 and existing.sha256 == hashlib.sha256(other).hexdigest()
        assert db.get(SourceNode, moved.id).trashed_at is not None
    assert r["summary"]
    # Skip leaves it where it was.
    r = _ops(client, p, [{"kind": "move", "nodeIds": [n["c.png"].id], "parentId": target}], resolutions={"*": "skip"}).json()
    assert "skipped" not in r and _by_name(p)["c.png"].parent_id == target  # no conflict: just moved
    _import(client, p, {"study/c.png": png(9, 8)})
    again = _by_name(p)
    with kdb.session_scope() as db:
        c2 = db.scalars(select(SourceNode).where(SourceNode.project_id == p, SourceNode.name == "c.png", SourceNode.parent_id != target)).one().id
    r = _ops(client, p, [{"kind": "move", "nodeIds": [c2], "parentId": target}], resolutions={"*": "skip"}).json()
    assert r["skipped"]["byResolution"] == 1 and again


def test_copy_is_free_and_duplicates_in_place(client):
    p, root, _ = _new(client, {"study/a.png": png(4, 4), "study/sub/b.png": png(5, 5)})
    n = _by_name(p)
    r = _ops(client, p, [{"kind": "copy", "nodeIds": [n["a.png"].id], "parentId": n["study"].id}]).json()
    dup = r["nodes"][0]
    assert dup["name"] == "a (copy).png" and dup["id"] != n["a.png"].id
    r = _ops(client, p, [{"kind": "copy", "nodeIds": [n["sub"].id], "parentId": root}]).json()
    after = _by_name(p)
    with kdb.session_scope() as db:
        copies = list(db.scalars(select(SourceNode).where(SourceNode.project_id == p, SourceNode.name == "b.png")))
        assert len(copies) == 2 and copies[0].asset_id == copies[1].asset_id and copies[0].id != copies[1].id
        assert db.query(Asset).filter(Asset.workspace_id == p).count() == 2  # no bytes copied (D5)
    assert after["Sources"].descendant_count == 4
    # Identical bytes into a folder that has them: skipped silently.
    r = _ops(client, p, [{"kind": "copy", "nodeIds": [n["b.png"].id], "parentId": r["nodes"][0]["id"]}]).json()
    assert r["skipped"]["identical"] == 1


# ---- Undo and redo (D9) ------------------------------------------------------------------------


def test_undo_redo_and_refusal_after_someone_elses_change(client):
    p, root, _ = _new(client, {"study/a.png": png(4, 4), "study/patient_002.png": png(5, 5)})
    _add_member(p)
    n = _by_name(p)
    dest = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "dest"}]).json()["nodes"][0]["id"]
    moved = _ops(client, p, [{"kind": "move", "nodeIds": [n["a.png"].id, n["patient_002.png"].id], "parentId": dest}]).json()
    hist = client.get(f"/api/v1/projects/{p}/fs/history").json()
    assert hist["undo"] == {"batchId": moved["batchId"], "label": "move of 2 items"} and hist["redo"] is None
    u = client.post(f"/api/v1/projects/{p}/fs/undo", json={}).json()
    assert u["undoneBatchId"] == moved["batchId"] and u["next"]["label"] == "new folder of 1 item"
    assert {_by_name(p)["a.png"].parent_id, _by_name(p)["patient_002.png"].parent_id} == {n["study"].id}
    assert _by_name(p)["dest"].descendant_count == 0 and _by_name(p)["study"].descendant_count == 2
    hist = client.get(f"/api/v1/projects/{p}/fs/history").json()
    assert hist["redo"]["label"] == "move of 2 items"
    client.post(f"/api/v1/projects/{p}/fs/redo", json={})
    assert _by_name(p)["a.png"].parent_id == dest
    # Bob renames one of them; Alice's undo of her move is refused, naming it.
    assert _ops(client, p, [{"kind": "rename", "nodeId": n["patient_002.png"].id, "name": "p2.png"}], headers=BOB).status_code == 200
    r = client.post(f"/api/v1/projects/{p}/fs/undo", json={})
    assert r.status_code == 409 and r.json()["detail"] == "Can't undo: p2.png changed after that"
    # Bob's own undo works, and undoing a mkdir removes the folder again.
    assert client.post(f"/api/v1/projects/{p}/fs/undo", json={}, headers=BOB).status_code == 200
    assert "patient_002.png" in _by_name(p)
    folder = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "tmp"}]).json()
    assert client.post(f"/api/v1/projects/{p}/fs/undo", json={"batchId": folder["batchId"]}).status_code == 200
    assert "tmp" not in _by_name(p)
    client.post(f"/api/v1/projects/{p}/fs/redo", json={})
    assert _by_name(p)["tmp"].id == folder["nodes"][0]["id"]  # redo brings back the same id


def test_undo_of_a_copy_and_of_trash(client):
    p, root, _ = _new(client, {"study/sub/a.png": png(4, 4), "study/sub/b.png": png(5, 5)})
    n = _by_name(p)
    c = _ops(client, p, [{"kind": "copy", "nodeIds": [n["sub"].id], "parentId": root}]).json()
    assert _by_name(p)["Sources"].descendant_count == 4
    client.post(f"/api/v1/projects/{p}/fs/undo", json={"batchId": c["batchId"]})
    with kdb.session_scope() as db:
        assert db.query(SourceNode).filter(SourceNode.project_id == p, SourceNode.name == "a.png").count() == 1
    assert _by_name(p)["Sources"].descendant_count == 2
    t = _ops(client, p, [{"kind": "trash", "nodeIds": [n["sub"].id]}]).json()
    assert _by_name(p)["Sources"].descendant_count == 0
    client.post(f"/api/v1/projects/{p}/fs/undo", json={"batchId": t["batchId"]})
    assert _by_name(p)["Sources"].descendant_count == 2 and _by_name(p)["sub"].trashed_at is None


# ---- Trash (D8) --------------------------------------------------------------------------------


def test_trash_restores_to_the_original_folder_or_the_root(client):
    p, root, _ = _new(client, {"study/MRI/x.png": png(4, 4), "study/MRI/y.png": png(5, 5)})
    n = _by_name(p)
    t = _ops(client, p, [{"kind": "trash", "nodeIds": [n["x.png"].id]}]).json()
    assert t["summary"] == "Moved x.png to Trash"
    assert [i["name"] for i in _children(client, p, n["MRI"].id)] == ["y.png"]
    assert _by_name(p)["MRI"].descendant_count == 1
    page = client.get(f"/api/v1/projects/{p}/trash").json()
    assert page["total"] == 1 and page["items"][0]["originalLocation"] == "study/MRI" and page["items"][0]["purgeInDays"] == 30
    assert page["items"][0]["trashedBy"]["id"] == ALICE and page["items"][0]["trashedByName"] == ALICE and page["items"][0]["trashed"] is True
    assert client.get(f"/api/v1/projects/{p}/fs").json()["trashCount"] == 1
    # Ops on something in Trash are refused (only restore and purge apply).
    assert _ops(client, p, [{"kind": "rename", "nodeId": n["x.png"].id, "name": "z.png"}]).status_code == 422
    _ops(client, p, [{"kind": "restore", "nodeIds": [n["x.png"].id]}])
    assert _by_name(p)["x.png"].parent_id == n["MRI"].id and _by_name(p)["MRI"].descendant_count == 2
    # Its folder went to Trash meanwhile: restoring puts it in Files, and says so.
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["x.png"].id]}])
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["MRI"].id]}])
    assert client.get(f"/api/v1/projects/{p}/trash").json()["items"][1]["originalLocation"] is None
    r = _ops(client, p, [{"kind": "restore", "nodeIds": [n["x.png"].id]}]).json()
    assert _by_name(p)["x.png"].parent_id == root and "its folder is gone" in r["warnings"][0]
    # A restored name that is taken again is a conflict like any other.
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["x.png"].id]}])
    folder = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "X.PNG"}]).json()["nodes"][0]["id"]
    r = _ops(client, p, [{"kind": "restore", "nodeIds": [n["x.png"].id]}])
    assert r.status_code == 409 and r.json()["detail"]["conflicts"][0]["existingId"] == folder
    r = _ops(client, p, [{"kind": "restore", "nodeIds": [n["x.png"].id]}], resolutions={"*": "keep_both"}).json()
    assert r["nodes"][0]["name"] == "x (2).png"


def test_purge_keeps_bytes_a_dataset_uses_and_deletes_the_rest(client):
    keep, drop = png(4, 4), png(5, 5)
    p, root, _ = _new(client, {"study/keep.png": keep, "study/drop.png": drop})
    n = _by_name(p)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "LV segmentation", "nodeIds": [n["keep.png"].id]}).json()
    t = _ops(client, p, [{"kind": "trash", "nodeIds": [n["keep.png"].id, n["drop.png"].id]}]).json()
    assert t["warnings"] == ["LV segmentation still uses 1 of these"]
    preview = client.get(f"/api/v1/projects/{p}/trash/empty/preview").json()
    preview.pop("byKind")
    assert preview == {"purged": 2, "keptBytes": [{"name": "keep.png", "reason": "Kept: the LV segmentation dataset uses it"}]}
    with kdb.session_scope() as db:
        keep_asset = db.get(Asset, n["keep.png"].asset_id)
        drop_asset = db.get(Asset, n["drop.png"].asset_id)
        keep_path, drop_path = keep_asset.path, drop_asset.path
    store = blobstore.data()
    assert store.stat(drop_path) is not None
    out = client.post(f"/api/v1/projects/{p}/trash/empty").json()
    assert out["purged"] == 2 and len(out["keptBytes"]) == 1
    with kdb.session_scope() as db:
        assert db.get(SourceNode, n["keep.png"].id) is None and db.get(SourceNode, n["drop.png"].id) is None
        assert db.get(Asset, n["keep.png"].asset_id) is not None and db.get(Asset, n["drop.png"].asset_id) is None
    assert store.stat(keep_path) is not None and store.stat(drop_path) is None
    # Purge can't be undone.
    r = client.post(f"/api/v1/projects/{p}/fs/undo", json={})
    assert r.status_code == 409 and "can't be undone" in r.json()["detail"]
    assert client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()["fileCount"] == 0


def test_purge_keeps_bytes_a_version_uses(client):
    v1, v2 = png(4, 4), png(5, 5)
    p, root, _ = _new(client, {"study/a.png": v1, "study/x/a.png": v2})
    nodes = _by_name(p)
    with kdb.session_scope() as db:
        a, b = sorted(db.scalars(select(SourceNode).where(SourceNode.project_id == p, SourceNode.name == "a.png")), key=lambda x: x.parent_id != nodes["study"].id)
        a_id, b_id, b_asset = a.id, b.id, b.asset_id
    # b's bytes become version 2 of a (move with Replace); b goes to the Trash.
    _ops(client, p, [{"kind": "move", "nodeIds": [b_id], "parentId": nodes["study"].id}], resolutions={"*": "replace"})
    # Restoring a's version 1 leaves b's bytes referenced only by a's version 2.
    client.post(f"/api/v1/source-nodes/{a_id}/versions/1/restore")
    assert [v["version"] for v in client.get(f"/api/v1/source-nodes/{a_id}/versions").json()["versions"]] == [3, 2, 1]
    out = client.post(f"/api/v1/projects/{p}/trash/empty").json()
    out.pop("byKind")
    assert out == {"purged": 1, "keptBytes": [{"name": "a.png", "reason": "Kept: a version of a.png uses it"}]}
    with kdb.session_scope() as db:
        assert db.get(SourceNode, b_id) is None and db.get(Asset, b_asset) is not None
    assert client.post(f"/api/v1/source-nodes/{a_id}/versions/2/restore").status_code == 200


def test_empty_trash_job_runs_once_a_day(client):
    from .conftest import worker_headers

    p, root, _ = _new(client, {"study/a.png": png(4, 4)})
    n = _by_name(p)
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["a.png"].id]}])
    young = client.post("/api/v1/worker/scheduled/files.empty_trash", json={}, headers=worker_headers()).json()
    assert young["ran"] is True and young["result"]["purged"] == 0  # not 30 days old yet
    again = client.post("/api/v1/worker/scheduled/files.empty_trash", json={}, headers=worker_headers()).json()
    assert again["ran"] is False
    forced = client.post("/api/v1/worker/scheduled/files.empty_trash", json={"force": True, "days": 0}, headers=worker_headers()).json()
    assert forced["result"]["purged"] == 1
    assert client.post("/api/v1/worker/scheduled/files.empty_trash", json={}).status_code == 401


# ---- Datasets (D7) and versions (D6) -----------------------------------------------------------


def _inspect_all(client, imp: dict, kind: str = "image") -> None:
    from .conftest import worker_headers

    files = client.get(f"/api/v1/worker/inspect/imports/{imp['id']}", headers=worker_headers()).json()["files"]
    _report(client, imp, {f["name"]: kind for f in files})


def test_dataset_contents_and_annotations_survive_moves_and_renames(client):
    p, root, imp = _new(client, {"study/MRI/a.png": png(4, 4), "study/MRI/b.png": png(5, 5), "study/other/c.png": png(6, 6)})
    _inspect_all(client, imp)
    n = _by_name(p)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Scans", "nodeIds": [n["MRI"].id], "task": {"title": "Outline", "preset": "preset:image-2d"}}).json()
    assert ds["definition"]["followedFolders"] == [n["MRI"].id] and len(ds["definition"]["files"]) == 2
    task = ds["tasks"][0]["id"]
    doc = client.get(f"/api/v1/tasks/{task}/document").json()
    paths = sorted(a["path"] for a in doc["assets"])
    ann = {"revision": 0, "annotations": [{"id": "x", "itemId": paths[0], "label": "normal", "provenance": "human-created", "author": "me", "createdAt": "2026-10-30T00:00:00Z", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}}]}
    assert client.put(f"/api/annotations/{task}", json=ann, headers={"X-Workspace-Id": task}).status_code == 200
    # Rename and move a, move c into the followed folder: the dataset doesn't change (D7).
    _ops(client, p, [{"kind": "rename", "nodeId": n["a.png"].id, "name": "renamed.png"}, {"kind": "move", "nodeIds": [n["a.png"].id], "parentId": root}, {"kind": "move", "nodeIds": [n["c.png"].id], "parentId": n["MRI"].id}])
    after = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()
    assert after["fileCount"] == 2 and after["definition"]["files"] == ds["definition"]["files"]
    assert after["staleness"] == {"newerVersions": 0, "newFilesInFollowed": 1, "followedFolderNames": ["MRI"]}
    doc2 = client.get(f"/api/v1/tasks/{task}/document").json()
    assert sorted(a["path"] for a in doc2["assets"]) == paths  # Asset.path never changes (D3)
    assert {a["name"] for a in doc2["assets"]} == {"renamed.png", "b.png"}
    assert [a["itemId"] for a in client.get(f"/api/annotations/{task}", headers={"X-Workspace-Id": task}).json()["annotations"]] == [paths[0]]
    with kdb.session_scope() as db:
        assert db.get(Asset, n["a.png"].asset_id).path in paths
    added = client.post(f"/api/v1/projects/{p}/datasets/{ds['id']}/add-followed").json()
    assert added["fileCount"] == 3 and added["staleness"]["newFilesInFollowed"] == 0


def _replace(client, node_id: str, data: bytes, prefix: str = "v") -> dict:
    body = {**_session_body({"new.png": data}, prefix=prefix), "mode": "replace"}
    s = client.post(f"/api/v1/source-nodes/{node_id}/versions", json=body)
    assert s.status_code == 201, s.text
    s = s.json()
    for f in s["files"]:
        if f["uploadUrl"]:
            assert client.put(f["uploadUrl"], content=data).json()["state"] == "uploaded"
    return client.post(f"/api/v1/imports/{s['id']}/complete").json()


def test_replace_adds_a_version_and_datasets_stay_pinned(client):
    v1, v2 = png(4, 4), png(9, 9)
    p, root, imp = _new(client, {"study/a.png": v1})
    _inspect_all(client, imp)
    n = _by_name(p)["a.png"]
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Pinned", "nodeIds": [n.id], "task": {"title": "T", "preset": "preset:image-2d"}}).json()
    task = ds["tasks"][0]["id"]
    old_path = client.get(f"/api/v1/tasks/{task}/document").json()["assets"][0]["path"]
    done = _replace(client, n.id, v2)
    assert done["state"] == "inspecting" and done["totals"]["version"] == 2
    _report(client, done, {"a.png": "image"})
    versions = client.get(f"/api/v1/source-nodes/{n.id}/versions").json()["versions"]
    assert [(v["version"], v["current"]) for v in versions] == [(2, True), (1, False)]
    assert versions[1]["sha256"] == hashlib.sha256(v1).hexdigest()
    assert client.get(f"/api/v1/source-nodes/{n.id}").json()["version"] == 2
    d = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()
    assert d["staleness"]["newerVersions"] == 1
    assert client.get(f"/api/v1/tasks/{task}/document").json()["assets"][0]["path"] == old_path  # still v1
    preview = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}/update-versions/preview").json()
    assert preview["files"] == [{"nodeId": n.id, "name": "a.png", "from": 1, "to": 2, "annotations": 0}]
    upd = client.post(f"/api/v1/projects/{p}/datasets/{ds['id']}/update-versions", json={}).json()
    assert upd["staleness"]["newerVersions"] == 0
    new_path = client.get(f"/api/v1/tasks/{task}/document").json()["assets"][0]["path"]
    assert new_path != old_path
    # Restoring version 1 adds version 3 with v1's bytes and facts.
    r = client.post(f"/api/v1/source-nodes/{n.id}/versions/1/restore").json()
    assert r["summary"].startswith("Restored an earlier version")
    detail = client.get(f"/api/v1/source-nodes/{n.id}").json()
    assert detail["version"] == 3 and detail["sha256"] == hashlib.sha256(v1).hexdigest() and detail["detectedKind"] == "image"
    assert client.post(f"/api/v1/source-nodes/{n.id}/versions/3/restore").status_code == 409
    # Undo of the restore goes back to version 2.
    client.post(f"/api/v1/projects/{p}/fs/undo", json={})
    assert client.get(f"/api/v1/source-nodes/{n.id}").json()["version"] == 2
    acts = client.get(f"/api/v1/source-nodes/{n.id}/activity").json()["items"]
    assert [a["kind"] for a in acts][:3] == ["undo", "restore_version", "replace"]


def test_upload_completion_is_idempotent_by_node_id(client):
    p, root, imp = _new(client, {"study/a.png": png(4, 4), "study/b.png": png(5, 5)})
    with kdb.session_scope() as db:
        from studio_api.models import ImportSession, UploadFile

        s = db.get(ImportSession, imp["id"])
        ids = sorted(f.node_id for f in db.scalars(select(UploadFile).where(UploadFile.session_id == s.id)))
        assert all(ids)
        s.state = "uploading"  # as if completion ran again (a retried request)
    again = client.post(f"/api/v1/imports/{imp['id']}/complete").json()
    assert again["totals"]["committed"] == 2
    with kdb.session_scope() as db:
        assert db.query(SourceNode).filter(SourceNode.project_id == p, SourceNode.is_dir.is_(False)).count() == 2


# ---- Locked samples (D2) -----------------------------------------------------------------------


def test_sample_data_is_locked_but_can_be_copied_out(client):
    drive = client.get("/api/v1/projects/ws-a/fs").json()
    top = _children(client, "ws-a")
    sample = top[0]
    assert sample["locked"] is True
    files = _children(client, "ws-a", sample["id"])
    f = files[0]
    assert f["locked"] is True
    for op in ({"kind": "rename", "nodeId": f["id"], "name": "x.png"}, {"kind": "trash", "nodeIds": [f["id"]]}, {"kind": "mkdir", "parentId": sample["id"], "name": "mine"}, {"kind": "move", "nodeIds": [f["id"]], "parentId": drive["rootNodeId"]}):
        r = _ops(client, "ws-a", [op])
        assert r.status_code == 423, (op, r.text)
    assert "Copy" in _ops(client, "ws-a", [{"kind": "trash", "nodeIds": [f["id"]]}]).json()["detail"]
    r = _ops(client, "ws-a", [{"kind": "copy", "nodeIds": [f["id"]], "parentId": drive["rootNodeId"]}])
    assert r.status_code == 200
    copy = r.json()["nodes"][0]
    assert copy["locked"] is False and copy["name"] == f["name"]
    assert _ops(client, "ws-a", [{"kind": "rename", "nodeId": copy["id"], "name": "mine.png"}]).status_code == 200


# ---- Agents (Phase 8 goes through approvals) ---------------------------------------------------


def test_agent_tokens_cannot_write_the_namespace_or_see_original_names(client):
    p, root, _ = _new(client, {"study/a.png": png(4, 4)})
    n = _by_name(p)["a.png"]
    _ops(client, p, [{"kind": "rename", "nodeId": n.id, "name": "case_01.png"}])
    agent = _agent(p)
    for method, url, body in (
        ("post", f"/api/v1/projects/{p}/fs/ops", {"ops": [{"kind": "mkdir", "parentId": root, "name": "x"}]}),
        ("post", f"/api/v1/projects/{p}/fs/undo", {}),
        ("post", f"/api/v1/projects/{p}/fs/redo", {}),
        ("post", f"/api/v1/projects/{p}/trash/empty", None),
        ("post", f"/api/v1/source-nodes/{n.id}/versions", {**_session_body({"a.png": b"x"}), "mode": "replace"}),
        ("post", f"/api/v1/source-nodes/{n.id}/versions/1/restore", None),
    ):
        r = getattr(client, method)(url, json=body, headers=agent)
        assert r.status_code == 403, (url, r.status_code, r.text)
    # Reads work, without the name the file arrived with.
    assert client.get(f"/api/v1/projects/{p}/fs", headers=agent).status_code == 200
    detail = client.get(f"/api/v1/source-nodes/{n.id}", headers=agent).json()
    assert detail["name"] == "case_01.png" and "originalPath" not in detail
    acts = client.get(f"/api/v1/source-nodes/{n.id}/activity", headers=agent).json()["items"]
    assert acts[0]["text"] == "Renamed" and "a.png" not in str(acts)
    mine = client.get(f"/api/v1/source-nodes/{n.id}/activity").json()["items"]
    assert mine[0]["text"] == "Renamed from a.png"


# ---- Download and ZIP --------------------------------------------------------------------------


def test_zip_streams_current_names_and_leaves_held_files_out(client):
    a, b, held = png(4, 4), png(5, 5), png(6, 6)
    p, root, imp = _new(client, {"study/MRI/a.png": a, "study/MRI/sub/b.png": b, "study/MRI/Smith_John.png": held})
    _report(client, imp, {"a.png": "image", "b.png": "image", "Smith_John.png": "image"}, flags={"Smith_John.png": {"privacy": {"reason": "Held: a name looks like a person's name", "source": "path"}}})
    n = _by_name(p)
    _ops(client, p, [{"kind": "rename", "nodeId": n["sub"].id, "name": "renamed"}])
    r = client.post(f"/api/v1/projects/{p}/fs/zip", json={"nodeIds": [n["MRI"].id]})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert 'filename="MRI.zip"' in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["MRI/a.png", "MRI/renamed/b.png", "_held_files.txt"]
    assert z.read("MRI/renamed/b.png") == b and z.testzip() is None
    note = z.read("_held_files.txt").decode()
    assert "MRI/Smith_John.png" in note and "privacy" in note
    assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())
    assert r.headers["x-held-files"] == "1"
    with kdb.session_scope() as db:
        assert db.query(PluginAudit).filter(PluginAudit.workspace_id == p, PluginAudit.action == "files.downloaded").count() == 1
    # A single file downloads with its current name; a held one is refused.
    one = client.get(f"/api/v1/source-nodes/{n['a.png'].id}/download")
    assert one.status_code == 200 and one.content == a and 'filename="a.png"' in one.headers["content-disposition"]
    assert client.get(f"/api/v1/source-nodes/{n['Smith_John.png'].id}/download").status_code == 423


def test_an_older_version_downloads_with_its_number_and_is_audited(client):
    v1, v2 = png(4, 4), png(9, 9)
    p, root, imp = _new(client, {"study/a.png": v1})
    _inspect_all(client, imp)
    n = _by_name(p)["a.png"]
    _report(client, _replace(client, n.id, v2), {"a.png": "image"})
    old = client.get(f"/api/v1/source-nodes/{n.id}/versions/1/download")
    assert old.status_code == 200 and old.content == v1 and 'filename="a (v1).png"' in old.headers["content-disposition"]
    cur = client.get(f"/api/v1/source-nodes/{n.id}/versions/2/download")
    assert cur.content == v2 and 'filename="a.png"' in cur.headers["content-disposition"]
    assert client.get(f"/api/v1/source-nodes/{n.id}/versions/7/download").status_code == 404
    with kdb.session_scope() as db:
        rows = db.query(PluginAudit).filter(PluginAudit.workspace_id == p, PluginAudit.action == "files.downloaded").all()
        assert sorted((r.after_ref or {}).get("version") for r in rows) == [1, 2]
    # A held file's versions are held too.
    with kdb.session_scope() as db:
        node = db.get(SourceNode, n.id)
        node.flags = {**(node.flags or {}), "privacy": {"reason": "Held: header", "source": "header"}}
    assert client.get(f"/api/v1/source-nodes/{n.id}/versions/1/download").status_code == 423


def test_zip_writer_streams_in_bounded_chunks(client, monkeypatch):
    from studio_api.kernel import zipstream

    p, root, _ = _new(client, {"study/big.bin": bytes(range(256)) * 4096})  # 1 MB
    with kdb.session_scope() as db:
        a = db.scalars(select(Asset).where(Asset.workspace_id == p)).first()
        path, size = a.path, a.size
    monkeypatch.setattr(zipstream, "FLUSH_BYTES", 64 * 1024)
    chunks = list(zipstream.stream([("big.bin", path, size)]))
    assert len(chunks) > 4 and max(len(c) for c in chunks) < 1024 * 1024
    z = zipfile.ZipFile(io.BytesIO(b"".join(chunks)))
    assert z.read("big.bin") == bytes(range(256)) * 4096


# ---- Privacy (Phase 7) and proposals -----------------------------------------------------------


def test_renaming_clears_a_name_only_privacy_hold_and_undo_brings_it_back(client):
    p, root, imp = _new(client, {"study/Smith_John.png": png(4, 4), "study/hdr.png": png(5, 5)})
    flag = {"privacy": {"reason": "Held: a name looks like a person's name", "source": "path", "findings": ["a name looks like a person's name"]}}
    _report(client, imp, {"Smith_John.png": "image", "hdr.png": "image"}, flags={"Smith_John.png": flag, "hdr.png": {"privacy": {"reason": "Held: header", "source": "header"}}})
    n = _by_name(p)
    assert client.get(f"/api/v1/source-nodes/{n['Smith_John.png'].id}").json()["status"] == "privacy"
    r = _ops(client, p, [{"kind": "rename", "nodeId": n["Smith_John.png"].id, "name": "case_014.png"}, {"kind": "rename", "nodeId": n["hdr.png"].id, "name": "case_015.png"}])
    assert r.status_code == 200
    d = client.get(f"/api/v1/source-nodes/{n['Smith_John.png'].id}").json()
    assert d["status"] == "ready" and d["flags"]["privacy"]["clearReason"] == "renamed"
    assert client.get(f"/api/v1/source-nodes/{n['hdr.png'].id}").json()["status"] == "privacy"  # a header hold stays
    with kdb.session_scope() as db:
        cleared = db.query(PluginAudit).filter(PluginAudit.workspace_id == p, PluginAudit.action == "privacy.cleared").all()
        assert [(c.target, c.after_ref["reason"]) for c in cleared] == [(n["Smith_John.png"].id, "renamed")]
    client.post(f"/api/v1/projects/{p}/fs/undo", json={})
    assert client.get(f"/api/v1/source-nodes/{n['Smith_John.png'].id}").json()["status"] == "privacy"
    # A folder move re-checks what's inside.
    client.post(f"/api/v1/projects/{p}/fs/redo", json={})
    assert client.get(f"/api/v1/source-nodes/{n['Smith_John.png'].id}").json()["status"] == "ready"


def test_privacy_patterns_match_the_workers(client):
    """`privacy_names` is a copy of the worker's path check (apps don't import each other)."""
    from pathlib import Path

    from studio_api.kernel import privacy_names

    root = Path(__file__).resolve().parents[2]
    worker = (root / "worker/src/studio_worker/inspect/privacy.py").read_text() + (root / "worker/src/studio_worker/deid.py").read_text()
    for rx in (privacy_names.NAME_LIKE, privacy_names.DATE_LIKE, privacy_names.MRN_LIKE, *(r for _, r in privacy_names.PHI_VALUE)):
        assert rx.pattern in worker, rx.pattern
    assert privacy_names.path_findings("study/Smith_John.png") and not privacy_names.path_findings("study/case_014.png")


def test_proposals_naming_renamed_nodes_are_marked_stale(client):
    p, root, _ = _new(client, {"study/p1/a.png": png(4, 4)})
    n = _by_name(p)
    pr = client.post(f"/api/v1/projects/{p}/proposals", json={"kind": "group", "payload": {"nodeIds": [n["a.png"].id], "summary": "s"}, "evidence": {}, "strength": "possible"}).json()
    _ops(client, p, [{"kind": "move", "nodeIds": [n["a.png"].id], "parentId": root}])
    assert not client.get(f"/api/v1/proposals/{pr['id']}").json()["evidence"].get("stale")  # a move keeps its name
    _ops(client, p, [{"kind": "rename", "nodeId": n["a.png"].id, "name": "b.png"}])
    ev = client.get(f"/api/v1/proposals/{pr['id']}").json()
    assert ev["evidence"]["stale"] is True and ev["status"] == "proposed"


# ---- Stars, recent, events, activity -----------------------------------------------------------


def test_stars_recent_and_the_fs_changed_event(client):
    p, root, _ = _new(client, {"study/a.png": png(4, 4), "study/b.png": png(5, 5)})
    n = _by_name(p)
    assert client.post(f"/api/v1/source-nodes/{n['a.png'].id}/star").json() == {"starred": True}
    assert [i["node"]["name"] for i in client.get(f"/api/v1/projects/{p}/starred").json()["items"]] == ["a.png"]
    assert client.get(f"/api/v1/projects/{p}/starred", headers=BOB).status_code == 404  # not a member
    assert next(i for i in _children(client, p, n["study"].id) if i["name"] == "a.png")["starred"] is True
    client.delete(f"/api/v1/source-nodes/{n['a.png'].id}/star")
    assert client.get(f"/api/v1/projects/{p}/starred").json()["items"] == []
    client.get(f"/api/v1/source-nodes/{n['b.png'].id}")  # opened in the inspector
    r = _ops(client, p, [{"kind": "rename", "nodeId": n["a.png"].id, "name": "c.png"}]).json()
    assert [i["node"]["name"] for i in client.get(f"/api/v1/projects/{p}/recent").json()["items"]] == ["c.png", "b.png"]
    with kdb.session_scope() as db:
        ev = db.scalars(select(PluginEvent).where(PluginEvent.workspace_id == p, PluginEvent.type == "fs.changed")).all()[-1]
        assert {k: ev.payload[k] for k in ("projectId", "parentIds", "batchId", "actor", "summary")} == {"projectId": p, "parentIds": [n["study"].id], "batchId": r["batchId"], "actor": ALICE, "summary": "Renamed to c.png"}
        ops = db.scalars(select(FsOp).where(FsOp.batch_id == r["batchId"])).all()
        assert [(o.kind, o.before["name"], o.after["name"]) for o in ops] == [("rename", "a.png", "c.png")]
        audits = db.scalars(select(PluginAudit).where(PluginAudit.workspace_id == p, PluginAudit.action == "files.renamed")).all()
        assert len(audits) == 1 and audits[0].after_ref["batchId"] == r["batchId"]
    feed = client.get(f"/api/v1/projects/{p}/activity").json()["entries"]
    assert any(e["label"] == "renamed 1 item" for e in feed)


@pytest.mark.parametrize("bad", [{"ops": []}, {"ops": [{"kind": "explode"}]}, {"ops": [{"kind": "move", "nodeIds": "x", "parentId": "y"}]}, {"ops": [{"kind": "trash", "nodeIds": []}], "resolutions": {"*": "maybe"}}])
def test_bad_requests_are_422(client, bad):
    p, root, _ = _new(client, {"study/a.png": png(4, 4)})
    assert client.post(f"/api/v1/projects/{p}/fs/ops", json=bad).status_code == 422


def test_delegated_assistant_writes_and_trashes_but_destroy_needs_approval(client):
    """todo16 D8: with `project.write` the assistant acts with the person's rights."""
    from studio_api.context import issue_session

    p, root, _ = _new(client, {"study/a.png": png(4, 4)})
    n = _by_name(p)["a.png"]
    with kdb.session_scope() as db:
        token = issue_session(db, "agent:run_2", p, ["proposals.write", "project.write"], on_behalf_of=ALICE)
    agent = {"Authorization": f"Bearer {token}"}
    r = client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "rename", "nodeId": n.id, "name": "b.png"}]}, headers=agent)
    assert r.status_code == 200, r.text
    r = client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "trash", "nodeIds": [n.id]}]}, headers=agent)
    assert r.status_code == 200, r.text
    r = client.post(f"/api/v1/projects/{p}/trash/empty", headers=agent)
    assert r.status_code == 403 and "approval" in r.json()["detail"]
    r = client.post(f"/api/v1/projects/{p}/trash/empty", headers={**agent, "X-Approval-Id": "appr_1"})
    assert r.status_code == 403, r.text  # a bare id is not a signed approval (test_approvals.py)
