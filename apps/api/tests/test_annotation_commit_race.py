"""todo25: a Studio's segmentation batch finishes in parallel; every job's masks must land.

`annotations.commit` appends to one document per Studio. Without a compare-and-set on the
revision, jobs that finish together overwrite each other and all but one batch of masks is lost.
"""

from __future__ import annotations

import threading

from studio_api import db as kdb
from studio_api.context import RequestContext
from studio_api.kernel import annotations

from .conftest import png
from .test_files import _by_name, _inspect_all, _new


def _ann(i: int, k: int) -> dict:
    return {"id": f"a{i}-{k}", "itemId": f"img{i}.png", "label": "right lung" if k == 0 else "left lung", "provenance": "ai-suggested", "author": "plugin:test@1", "createdAt": "2026-11-04T00:00:00Z", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}}


def test_parallel_commits_keep_every_job(make_client, tmp_path):
    client = make_client(database_url=f"sqlite:///{tmp_path}/race.db")
    p, _, imp = _new(client, {"study/a.png": png(4, 4)})
    _inspect_all(client, imp)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Scans", "nodeIds": [_by_name(p)["a.png"].id], "task": {"title": "Studio", "preset": "preset:image-2d"}}).json()
    ctx = RequestContext(p, "plugin:test@1", "corr", task_id=ds["tasks"][0]["id"])
    with kdb.session_scope() as s:  # the document exists, as it does for an open Studio
        annotations.commit(s, ctx, [_ann(99, 0)], idempotency_key="seed", source="test")
    barrier = threading.Barrier(12)
    errors: list[BaseException] = []

    def job(i: int) -> None:
        try:
            barrier.wait()
            with kdb.session_scope() as s:
                annotations.commit(s, ctx, [_ann(i, 0), _ann(i, 1)], idempotency_key=f"job:{i}", job_id=f"j{i}", source="test")
        except BaseException as e:  # noqa: BLE001 — reported below
            errors.append(e)

    threads = [threading.Thread(target=job, args=(i,)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    with kdb.session_scope() as s:
        doc = annotations.get_document(s, ctx)
    ids = {a["id"] for a in doc["annotations"]}
    assert {f"a{i}-{k}" for i in range(12) for k in (0, 1)} <= ids
    assert doc["revision"] >= 13
