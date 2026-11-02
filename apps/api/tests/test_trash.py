"""todo16 Milestone 1: delete and recover everything (D2-D6)."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.models import INCLUDE_TRASHED, AuditEvent, DatasetCollectionRow, OrganizationMember, ProjectRow, TaskRow

from .conftest import png, worker_headers
from .test_files import _by_name, _inspect_all, _new, _ops

BOB = {"X-Dev-Principal": "user:bob"}


def _member(pid: str, role: str, principal: str = "user:bob") -> None:
    with kdb.session_scope() as db:
        p = db.get(ProjectRow, pid)
        assert p is not None
        db.add(OrganizationMember(org_id=p.org_id, principal=principal, role=role))


def _setup(client) -> tuple[str, dict, str]:
    p, _, imp = _new(client, {"study/a.png": png(4, 4), "study/b.png": png(5, 5)})
    _inspect_all(client, imp)
    n = _by_name(p)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Scans", "nodeIds": [n["a.png"].id], "task": {"title": "Outline", "preset": "preset:image-2d"}}).json()
    with kdb.session_scope() as db:
        task = db.scalars(select(TaskRow).where(TaskRow.dataset_id == ds["id"])).first()
        assert task is not None
        task_id = task.id
        db.add(DatasetCollectionRow(id="col-1", dataset_id=ds["id"], project_id=p, name="X-rays", kind="image", created_by="user:local-expert"))
        task.collection_id = "col-1"
    return p, ds, task_id


def _trash(client, p: str, kind: str = "all") -> dict:
    r = client.get(f"/api/v1/projects/{p}/trash", params={"kind": kind})
    assert r.status_code == 200, r.text
    return r.json()


def test_dataset_goes_to_trash_with_its_collections_and_studios_and_comes_back(client):
    p, ds, task_id = _setup(client)
    dry = client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}", params={"dryRun": "true"}).json()
    kinds = sorted(i["kind"] for i in dry["impact"]["items"])
    assert kinds == ["collection", "dataset", "studio"] and dry["impact"]["files"] == 0
    assert client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").status_code == 200  # dry run changes nothing

    out = client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()
    assert out["batchId"] and len(out["impact"]["items"]) == 3
    assert client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").status_code == 404
    assert ds["id"] not in [d["id"] for d in client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"]]
    assert client.get(f"/api/v1/tasks/{task_id}").status_code == 404
    # The files a dataset uses stay in Sources (D3).
    assert _trash(client, p, "sources")["count"] == 0

    t = _trash(client, p)
    assert t["count"] == 1 and t["total"] == 0 and t["files"] == []
    it = t["items"][0]
    assert it["kind"] == "dataset" and it["name"] == "Scans" and it["batchId"] == out["batchId"] and it["daysLeft"] == 30
    assert it["trashedBy"] == {"id": "user:local-expert", "name": "local-expert", "viaAssistant": False}
    assert it["dependents"]["collections"] == 1 and it["dependents"]["studios"] == 1
    assert _trash(client, p, "studios")["count"] == 0 and _trash(client, p, "datasets")["count"] == 1

    back = client.post(f"/api/v1/projects/{p}/trash/{out['batchId']}/restore").json()
    assert [r["kind"] for r in back["restored"]] == ["dataset"] and back["relocatedToRoot"] is False
    assert client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").status_code == 200
    assert client.get(f"/api/v1/tasks/{task_id}").status_code == 200
    assert _trash(client, p)["count"] == 0
    with kdb.session_scope() as db:
        actions = list(db.scalars(select(AuditEvent.action).where(AuditEvent.action.like("trash.%"))))
    assert actions == ["trash.moved", "trash.restored"]


def test_studio_and_collection_delete_and_rename(client):
    p, ds, task_id = _setup(client)
    r = client.patch(f"/api/v1/projects/{p}/studios/{task_id}", json={"name": "Contours"}).json()
    assert r["name"] == "Contours"
    assert client.patch(f"/api/v1/projects/{p}/collections/col-1", json={"name": "Chest"}).json()["name"] == "Chest"
    assert client.patch(f"/api/v1/projects/{p}/datasets/{ds['id']}", json={"name": "Scans 2", "description": "d"}).json()["description"] == "d"
    assert client.patch(f"/api/v1/projects/{p}/datasets/{ds['id']}", json={"name": " "}).status_code == 422

    s = client.delete(f"/api/v1/projects/{p}/studios/{task_id}").json()
    assert [i["kind"] for i in s["impact"]["items"]] == ["studio"]
    item = _trash(client, p, "studios")["items"][0]
    assert item["name"] == "Contours" and item["originalLocation"] == "Scans 2"
    c = client.delete(f"/api/v1/projects/{p}/collections/col-1").json()
    assert [i["kind"] for i in c["impact"]["items"]] == ["collection"]  # its Studio is already in Trash
    assert _trash(client, p)["count"] == 2

    # Destroy is for good.
    assert client.delete(f"/api/v1/projects/{p}/trash/{s['batchId']}").json() == {"purged": 1}
    with kdb.session_scope() as db:
        assert db.get(TaskRow, task_id, execution_options=INCLUDE_TRASHED) is None
    assert client.post(f"/api/v1/projects/{p}/trash/{s['batchId']}/restore").status_code == 409  # todo18: already deleted forever
    # Empty Trash takes every kind.
    assert client.post(f"/api/v1/projects/{p}/trash/empty").json()["purged"] == 1
    assert _trash(client, p)["count"] == 0


def test_files_are_in_the_same_trash_and_restore_by_batch(client):
    p, _, _ = _new(client, {"study/a.png": png(4, 4)})
    n = _by_name(p)
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["a.png"].id]}])
    t = _trash(client, p)
    assert t["total"] == 1 and t["count"] == 1
    it = t["items"][0]
    assert it["kind"] == "source" and it["name"] == "a.png" and it["purgeInDays"] == 30 and it["dependents"] == {"files": 1}
    back = client.post(f"/api/v1/projects/{p}/trash/{it['batchId']}/restore").json()
    assert back["restored"][0]["id"] == n["a.png"].id
    assert _trash(client, p)["count"] == 0


def test_viewers_cannot_delete_and_only_owners_destroy(client):
    p, ds, task_id = _setup(client)
    _member(p, "viewer")
    r = client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}", headers=BOB)
    assert r.status_code == 403 and r.json()["detail"] == "You can view this project but not delete from it"
    assert client.patch(f"/api/v1/projects/{p}/datasets/{ds['id']}", json={"name": "x"}, headers=BOB).status_code == 403
    assert client.get(f"/api/v1/projects/{p}/trash", headers=BOB).status_code == 200

    _member(p, "member", "user:carol")
    carol = {"X-Dev-Principal": "user:carol"}
    out = client.delete(f"/api/v1/projects/{p}/studios/{task_id}", headers=carol)
    assert out.status_code == 200  # an editor may move to Trash
    batch = out.json()["batchId"]
    assert client.delete(f"/api/v1/projects/{p}/trash/{batch}", headers=carol).status_code == 403
    assert client.delete(f"/api/v1/projects/{p}", headers=carol).status_code == 403
    assert client.delete(f"/api/v1/projects/{p}/trash/{batch}").status_code == 200  # the owner


def test_projects_go_to_deleted_projects_and_come_back(client):
    p, _, _ = _setup(client)
    dry = client.delete(f"/api/v1/projects/{p}", params={"dryRun": "true"}).json()
    assert dry["impact"]["files"] == 2
    client.delete(f"/api/v1/projects/{p}").raise_for_status()
    assert client.get(f"/api/v1/projects/{p}").status_code == 404
    assert p not in [x["id"] for x in client.get("/api/v1/projects").json()["projects"]]
    gone = client.get("/api/v1/org/deleted-projects").json()["projects"]
    assert [x["id"] for x in gone] == [p] and gone[0]["daysLeft"] == 30
    client.post(f"/api/v1/projects/{p}/restore").raise_for_status()
    assert client.get(f"/api/v1/projects/{p}").status_code == 200
    assert client.get("/api/v1/org/deleted-projects").json()["projects"] == []
    # Forever.
    client.delete(f"/api/v1/projects/{p}").raise_for_status()
    assert client.delete(f"/api/v1/org/deleted-projects/{p}").json() == {"purged": 1}
    with kdb.session_scope() as db:
        assert db.get(ProjectRow, p, execution_options=INCLUDE_TRASHED) is None


def test_trash_purge_job_purges_every_kind_after_the_retention(client):
    p, ds, _ = _setup(client)
    client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}").raise_for_status()
    young = client.post("/api/v1/worker/scheduled/trash.purge", json={"force": True}, headers=worker_headers()).json()
    assert young["result"]["purged"] == 0 and _trash(client, p)["count"] == 1
    forced = client.post("/api/v1/worker/scheduled/trash.purge", json={"force": True, "days": 0}, headers=worker_headers()).json()
    assert forced["result"]["purged"] == 3
    assert _trash(client, p)["count"] == 0


# ---- Round 2: what a file delete does to datasets (D3-D5) ----------------------------------------


def test_trashed_files_stay_dataset_items_greyed_with_their_batch(client):
    p, ds, task_id = _setup(client)
    a = _by_name(p)["a.png"].id
    imp = client.get(f"/api/v1/projects/{p}/trash/impact", params={"nodeIds": a}).json()["impact"]
    assert imp["files"] == 1 and imp["datasetsLosingItems"] == [{"id": ds["id"], "name": "Scans", "items": 1}]
    folder = _by_name(p)["study"].id
    assert client.get(f"/api/v1/projects/{p}/trash/impact", params={"nodeIds": folder}).json()["impact"]["files"] == 2
    assert client.get(f"/api/v1/projects/{p}/trash/impact", params={"nodeIds": "nope"}).status_code == 404
    assert client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()["filesInTrash"] == 0

    with kdb.session_scope() as db:
        t = db.get(TaskRow, task_id)
        assert t is not None
        t.collection_id = None  # every file of the dataset (col-1 is a bare test row)
    assert [i.get("state") for i in client.get(f"/api/v1/tasks/{task_id}/document").json()["assets"]] == [None]
    _ops(client, p, [{"kind": "trash", "nodeIds": [folder]}])
    d = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()
    assert d["filesInTrash"] == 1 and d["itemCount"] == 0
    assert d["tasks"][0]["datasetTrashed"] is False
    batch = _trash(client, p, "sources")["items"][0]["batchId"]
    items = client.get(f"/api/v1/tasks/{task_id}/document").json()["assets"]
    assert [(i["nodeId"], i.get("state"), i.get("trashBatchId")) for i in items] == [(a, "trashed", batch)]
    assert d["filesTrashBatchIds"] == [batch]

    s = client.get(f"/api/v1/projects/{p}/search", params={"q": "png"}).json()
    assert s["items"] == [] and s["trashedMatches"] == 2


def test_purging_files_commits_their_removal_as_a_dataset_version(client):
    from studio_api.kernel.versioning import client as vclient, service
    from studio_api.kernel.versioning.fake import FakeVersioning

    from .conftest import ws

    fake = FakeVersioning()
    vclient.set_client(fake)
    service.clear_cache()
    try:
        p, ds, _ = _setup(client)
        assert client.post("/api/v1/datasets", json={"id": ds["id"]}, headers=ws(p)).status_code == 201
        a = _by_name(p)["a.png"].id
        _ops(client, p, [{"kind": "trash", "nodeIds": [a]}])
        _ops(client, p, [{"kind": "purge", "nodeIds": [a]}])
        d = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()
        assert d["fileCount"] == 0 and d["definition"]["files"] == []
        commits = [c for m, c in fake.calls if m == "create_commit"]
        assert len(commits) == 1
        with kdb.session_scope() as db:
            ev = db.scalars(select(AuditEvent).where(AuditEvent.action == "dataset.files_purged")).one()
            assert ev.detail["files"] == 1 and ev.detail["commitOid"]
    finally:
        vclient.set_client(None)
        service.clear_cache()


def test_deleting_a_project_forever_removes_its_workspace_and_unshared_blobs(client, monkeypatch):
    from studio_api.kernel import trash as ktrash
    from studio_api.models import Asset, Workspace

    p, _, _ = _setup(client)
    deleted: list[str] = []
    monkeypatch.setattr(ktrash, "_delete_blobs", lambda keys: deleted.extend(keys))
    with kdb.session_scope() as db:
        paths = sorted(db.scalars(select(Asset.path).where(Asset.workspace_id == p)))
        assert paths
        db.add(Workspace(id="ws-other", name="other"))
        db.flush()
        db.add(Asset(workspace_id="ws-other", path=paths[0], media_type="image/png"))
    client.delete(f"/api/v1/projects/{p}").raise_for_status()
    client.delete(f"/api/v1/org/deleted-projects/{p}").raise_for_status()
    assert sorted(deleted) == paths[1:]
    with kdb.session_scope() as db:
        assert db.get(Workspace, p) is None
        assert db.scalars(select(Asset).where(Asset.workspace_id == p)).first() is None


def test_a_studio_offers_restore_explore_shows_files_in_trash_and_names_are_people(client):
    """todo16 round 3: a Studio whose dataset is in Trash names the batch that restores it; Explore
    keeps trashed tables and documents as greyed records with their batch; Trash and Activity use
    the person's display name, not their id."""
    from studio_api.models import User

    p, ds, task_id = _setup(client)
    assert client.get(f"/api/v1/tasks/{task_id}").json()["datasetTrashBatchId"] is None
    out = client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()
    assert client.get(f"/api/v1/tasks/{task_id}").status_code == 404  # hidden by default
    st = client.get(f"/api/v1/tasks/{task_id}", params={"includeTrashed": "true"}).json()
    assert st["trashed"] is True and st["datasetTrashed"] is True and st["datasetTrashBatchId"] == out["batchId"]
    with kdb.session_scope() as db:
        db.add(User(id="user:local-expert", workos_user_id="w-1", email="ana@example.com", first_name="Ana", last_name="Lima"))
    assert _trash(client, p)["items"][0]["trashedBy"]["name"] == "Ana Lima"
    client.post(f"/api/v1/projects/{p}/trash/{out['batchId']}/restore")

    pt, _, imp = _new(client, {"notes/readme.txt": b"hello", "notes/b.png": png(4, 4)})
    _inspect_all(client, imp)
    with kdb.session_scope() as db:
        from studio_api.models import SourceNode

        doc = db.scalars(select(SourceNode).where(SourceNode.project_id == pt, SourceNode.name == "readme.txt")).one()
        doc.detected_kind = "document"
        doc_id = doc.id
    before = client.get(f"/api/v1/projects/{pt}/explore").json()
    assert before["files"]["inTrash"] == 0 and not [r for r in before["records"] if r["status"] == "trashed"]
    _ops(client, pt, [{"kind": "trash", "nodeIds": [doc_id]}])
    after = client.get(f"/api/v1/projects/{pt}/explore").json()
    trashed = [r for r in after["records"] if r["status"] == "trashed"]
    assert after["files"]["inTrash"] == 1
    assert [(r["nodeId"], r["title"], bool(r["trashBatchId"])) for r in trashed] == [(doc_id, "readme.txt", True)]


def test_sources_empty_trash_purges_files_only_and_preview_counts_per_kind(client):
    """todo18 P0-1: Sources › Trash empties files only; the project Trash lists counts per kind."""
    p, ds, _ = _setup(client)
    n = _by_name(p)
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["b.png"].id]}])
    assert client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}").status_code == 200
    pre = client.get(f"/api/v1/projects/{p}/trash/empty/preview").json()
    assert pre["byKind"] == {"sources": 1, "datasets": 1, "collections": 1, "studios": 1}
    assert client.get(f"/api/v1/projects/{p}/trash/empty/preview", params={"kind": "sources"}).json()["byKind"]["datasets"] == 0
    out = client.post(f"/api/v1/projects/{p}/trash/empty", params={"kind": "sources"}).json()
    assert out["purged"] == 1
    t = _trash(client, p)
    assert [i["kind"] for i in t["items"]] == ["dataset"]  # the dataset is still in Trash
    assert client.post(f"/api/v1/projects/{p}/trash/empty", params={"kind": "bogus"}).status_code == 422


def test_a_batch_restored_or_destroyed_twice_gets_409_not_404(client):
    """todo18 B: the batch lock. The second restore or destroy of a batch loses with 409."""
    p, ds, _ = _setup(client)
    b = client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()["batchId"]
    assert client.post(f"/api/v1/projects/{p}/trash/{b}/restore").status_code == 200
    r = client.post(f"/api/v1/projects/{p}/trash/{b}/restore")
    assert r.status_code == 409 and "already restored" in r.text
    assert client.delete(f"/api/v1/projects/{p}/trash/{b}").status_code == 409
    b2 = client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}").json()["batchId"]
    assert client.delete(f"/api/v1/projects/{p}/trash/{b2}").status_code == 200
    assert client.post(f"/api/v1/projects/{p}/trash/{b2}/restore").status_code == 409
    with kdb.session_scope() as db:
        from studio_api.models import FsBatch

        assert db.get(FsBatch, b2).state == "destroyed"
    assert client.post(f"/api/v1/projects/{p}/trash/nope/restore").status_code == 404


def test_restore_takes_several_batches_in_one_request(client):
    """todo18 B: "Restore all" is one request restoring every batch, not parallel restores."""
    p, _, _ = _new(client, {"study/a.png": png(4, 4), "study/b.png": png(5, 5)})
    n = _by_name(p)
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["a.png"].id]}])
    _ops(client, p, [{"kind": "trash", "nodeIds": [n["b.png"].id]}])
    ids = [i["batchId"] for i in _trash(client, p)["items"]]
    assert len(set(ids)) == 2
    r = client.post(f"/api/v1/projects/{p}/trash/{ids[0]}/restore", json={"batchIds": ids[1:]})
    assert r.status_code == 200, r.text
    assert sorted(x["name"] for x in r.json()["restored"]) == ["a.png", "b.png"]
    assert _trash(client, p)["count"] == 0
    assert client.post(f"/api/v1/projects/{p}/trash/{ids[0]}/restore", json={"batchIds": "x"}).status_code == 422
