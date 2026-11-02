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
    assert client.post(f"/api/v1/projects/{p}/trash/{s['batchId']}/restore").status_code == 404
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
