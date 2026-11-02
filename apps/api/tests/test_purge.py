"""todo18 D8: purge deletes what it made (derived blobs, versioning repos), and after-commit
deletes that fail are queued in `blob_delete_retries` and swept by `blobs.retry`."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import blobstore, db
from studio_api.kernel import purge
from studio_api.models import Asset, BlobDeleteRetry, DatasetRepo, TaskItem, Workspace

from .conftest import worker_headers


def _item(s, node: str, thumb: str) -> None:
    s.add(TaskItem(task_id="t", project_id="p1", session_id="x", client_file_id=node, item_id=f"sources/p1/{node}", node_id=node, name=node, rel_path=node, kind="image", size=1, sha256="0" * 64, state="ready", meta={"thumb": thumb}, priority=0, attempts=0))


def _put(key: str) -> None:
    blobstore.data().put(key, b"x", "image/webp")


def test_file_purge_deletes_its_thumbnails_but_not_one_a_kept_file_shares(client):
    own, shared = "sources/p1/derived/aaa.webp", "sources/p1/derived/bbb.webp"
    for k in (own, shared):
        _put(k)
    with db.session_scope() as s:
        s.add(Workspace(id="p1", name="p1"))
        s.flush()
        _item(s, "n1", own)
        _item(s, "n2", shared)
        _item(s, "n3", shared)  # stays
        s.add(Asset(workspace_id="p1", path=own, media_type="image/webp", role="thumbnail", size=1))
    with db.session_scope() as s:
        assert purge.run(s, "files", ["n1", "n2"], project_id="p1") == {"blobs": 1, "repos": 0}
    store = blobstore.data()
    assert store.stat(own) is None
    assert store.stat(shared) is not None
    with db.session_scope() as s:
        assert s.scalar(select(Asset).where(Asset.path == own)) is None


def test_project_purge_deletes_versioning_repos_then_gcs(client):
    from studio_api.kernel.versioning import client as vclient
    from studio_api.kernel.versioning.fake import FakeVersioning

    fake = FakeVersioning()
    vclient.set_client(fake)
    try:
        with db.session_scope() as s:
            s.add(DatasetRepo(workspace_id="p1", dataset_id="d1", repo_id="r-1", created_by="user:a"))
        with db.session_scope() as s:
            assert purge.run(s, "project", ["p1"])["repos"] == 1
        assert fake.deleted == ["r-1"] and fake.gcs == 1
    finally:
        vclient.set_client(None)


def test_failed_deletes_are_queued_and_the_daily_sweep_retries_them(client, monkeypatch):
    key = "sources/p1/derived/ccc.webp"
    _put(key)
    store = blobstore.data()
    real = type(store).delete

    def broken(self, k):  # noqa: ANN001
        raise OSError("bucket unavailable")

    monkeypatch.setattr(type(store), "delete", broken)
    before = purge.FAILED["blob"]
    with db.session_scope() as s:
        purge.defer_blob_deletes(s, [key])
    assert purge.FAILED["blob"] == before + 1
    with db.session_scope() as s:
        row = s.scalars(select(BlobDeleteRetry)).one()
        assert (row.kind, row.target, row.attempts) == ("blob", key, 1) and "bucket unavailable" in row.last_error
    monkeypatch.setattr(type(store), "delete", real)
    r = client.post("/api/v1/worker/scheduled/blobs.retry", json={}, headers=worker_headers()).json()
    assert r["ran"] and r["result"] == {"deleted": 1, "failing": 0}
    assert store.stat(key) is None
    assert client.post("/api/v1/worker/scheduled/blobs.retry", json={}, headers=worker_headers()).json()["ran"] is False  # once a day
    with db.session_scope() as s:
        assert s.scalars(select(BlobDeleteRetry)).all() == []


def test_transcodes_and_tiles_come_from_derivatives_when_it_exists(client, monkeypatch):
    import sys
    import types

    key = "sources/p1/derived/tiles/n9/0.png"
    _put(key)
    mod = types.ModuleType("studio_api.kernel.derivatives")
    mod.derived_keys = lambda db_, node_ids: [key] if "n9" in node_ids else []  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "studio_api.kernel.derivatives", mod)
    with db.session_scope() as s:
        assert purge.run(s, "files", ["n9"], project_id="p1")["blobs"] == 1
    assert blobstore.data().stat(key) is None
