"""todo18 D4: derivative rows — request, claim, progress, retry, ready/failed, purge keys."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from studio_api.db import Base
from studio_api.kernel import derivatives as d
from studio_api.models import Derivative, ProjectRow, SourceNode

TABLES = [Derivative.__table__, ProjectRow.__table__, SourceNode.__table__]


def _db() -> Session:
    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng, tables=TABLES)  # type: ignore[arg-type]
    return Session(eng)


def test_lifecycle_processing_progress_ready_and_purge_keys():
    db = _db()
    node = SimpleNamespace(id="nod-1", project_id="p")
    row = d.request(db, node, "video-mp4")
    assert d.request(db, node, "video-mp4") is row and d.request(db, node, "nope") is None
    assert d.state_for(db, ["nod-1"])["nod-1"] == {"kind": "video-mp4", "state": "processing", "progress": 0, "label": "Converting video"}
    [claimed] = d.claim(db)
    assert claimed.attempts == 1 and d.claim(db) == []  # leased
    d.progress(db, claimed, 42)
    assert d.state_for(db, ["nod-1"])["nod-1"]["progress"] == 42
    d.complete(db, claimed, sha="abc", key="u/p/derived/abc.mp4", keys=["u/p/derived/abc.mp4"], meta={"codec": "h264"})
    s = d.state_for(db, ["nod-1"])["nod-1"]
    assert s["state"] == "ready" and s["key"].endswith("abc.mp4")
    assert d.derived_keys(db, ["nod-1", "other"]) == ["u/p/derived/abc.mp4"]


def test_failures_retry_then_stay_failed_with_the_reason():
    db = _db()
    d.request(db, SimpleNamespace(id="nod-2", project_id="p"), "slide-dzi")
    for _ in range(3):
        [r] = d.claim(db, max_attempts=3)
        d.fail(db, r, "Converting timed out", retry=True, max_attempts=3)
    assert r.state == "failed" and d.claim(db) == []
    s = d.state_for(db, ["nod-2"])["nod-2"]
    assert s["state"] == "failed" and s["error"] == "Converting timed out" and s["label"] == "Preparing slide"


def test_codec_failure_is_not_retried():
    db = _db()
    d.request(db, SimpleNamespace(id="nod-3", project_id="p"), "video-mp4")
    [r] = d.claim(db)
    d.fail(db, r, "ffmpeg can't decode cinepak video", retry=False)
    assert d.state_for(db, ["nod-3"])["nod-3"]["error"].endswith("cinepak video")


def test_worker_routes_convert_an_uploaded_avi_end_to_end(client):
    """Report → pending row → claim → progress → streamed files → complete; purge keys."""
    from studio_api import blobstore
    from studio_api import db as kdb

    from .conftest import worker_headers as W
    from .test_explore import _report
    from .test_projects import _import

    p = client.post("/api/v1/projects", json={"title": "Video"}).json()["id"]
    imp = _import(client, p, {"clips/a.avi": b"RIFF....AVI "})
    _report(client, imp, {"a.avi": "video"}, {"a.avi": {"derivative": {"kind": "video-mp4"}}})
    [row] = client.post("/api/v1/worker/derivatives/claim", json={}, headers=W()).json()["derivatives"]
    assert row["kind"] == "video-mp4" and row["state"] == "processing"
    assert client.post("/api/v1/worker/derivatives/claim", json={}, headers=W()).json()["derivatives"] == []
    assert client.post(f"/api/v1/worker/derivatives/{row['id']}/progress", json={"progress": 40}, headers=W()).status_code == 200
    with kdb.session_scope() as db:
        assert d.state_for(db, [row["nodeId"]])[row["nodeId"]]["progress"] == 40
    up = client.put(f"/api/v1/worker/derivatives/{row['id']}/files/derived/abc.mp4", content=b"mp4-bytes", headers={**W(), "Content-Type": "video/mp4"})
    assert up.status_code == 200, up.text
    key = up.json()["key"]
    assert key.endswith(f"{p}/derived/abc.mp4") and blobstore.data().read(key) == b"mp4-bytes"
    assert client.put(f"/api/v1/worker/derivatives/{row['id']}/files/../x", content=b"x", headers=W()).status_code in (404, 422)
    done = client.post(f"/api/v1/worker/derivatives/{row['id']}/complete", json={"sha": "abc", "key": key, "keys": [key], "meta": {"codec": "h264"}}, headers=W())
    assert done.json()["state"] == "ready"
    with kdb.session_scope() as db:
        assert d.derived_keys(db, [row["nodeId"]]) == [key]
        items = [{"nodeId": row["nodeId"], "path": "x"}]
        d.annotate(db, items)
        assert items[0]["derivative"]["src"] == key and items[0]["derivative"]["state"] == "ready"


def test_a_codec_failure_through_the_api_is_final(client):
    from .conftest import worker_headers as W
    from .test_explore import _report
    from .test_projects import _import

    p = client.post("/api/v1/projects", json={"title": "Video"}).json()["id"]
    imp = _import(client, p, {"b.mov": b"moov"})
    _report(client, imp, {"b.mov": "video"}, {"b.mov": {"derivative": {"kind": "video-mp4"}}})
    [row] = client.post("/api/v1/worker/derivatives/claim", json={}, headers=W()).json()["derivatives"]
    r = client.post(f"/api/v1/worker/derivatives/{row['id']}/fail", json={"reason": "ffmpeg can't decode cinepak video", "retry": False}, headers=W()).json()
    assert r["state"] == "failed"
    assert client.post("/api/v1/worker/derivatives/claim", json={}, headers=W()).json()["derivatives"] == []
    assert client.post("/api/v1/worker/derivatives/claim", json={}).status_code in (401, 403)


def _slide_row(client, title: str) -> tuple[str, dict]:
    from .conftest import worker_headers as W
    from .test_explore import _report
    from .test_projects import _import

    p = client.post("/api/v1/projects", json={"title": title}).json()["id"]
    imp = _import(client, p, {"s.svs": b"II*\x00same-slide"})
    _report(client, imp, {"s.svs": "slide"}, {"s.svs": {"derivative": {"kind": "slide-dzi"}}})
    rows = client.post("/api/v1/worker/derivatives/claim", json={}, headers=W()).json()["derivatives"]
    return p, rows[0] if rows else {}


def test_a_project_in_trash_stops_its_conversion_and_restore_resumes_it(client):
    from .conftest import worker_headers as W

    p, row = _slide_row(client, "Slides")
    assert client.delete(f"/api/v1/projects/{p}").status_code == 200
    assert client.post(f"/api/v1/worker/derivatives/{row['id']}/progress", json={"progress": 10}, headers=W()).status_code == 409
    assert client.put(f"/api/v1/worker/derivatives/{row['id']}/files/derived/x.jpeg", content=b"x", headers=W()).status_code == 409
    assert client.post("/api/v1/worker/derivatives/claim", json={}, headers=W()).json()["derivatives"] == []
    assert client.post(f"/api/v1/projects/{p}/restore").status_code == 200
    [again] = client.post("/api/v1/worker/derivatives/claim", json={}, headers=W()).json()["derivatives"]
    assert again["id"] == row["id"] and again["attempts"] == 1


def test_the_same_slide_in_another_project_reuses_the_conversion(client):
    from studio_api import db as kdb
    from studio_api.models import INCLUDE_TRASHED, Asset

    from .conftest import worker_headers as W

    first, row = _slide_row(client, "First")
    dzi = f"sources/{first}/derived/abc.dzi"
    tiles = [f"sources/{first}/derived/abc_files/0/0_0.jpeg", dzi]
    client.put(f"/api/v1/worker/derivatives/{row['id']}/files/derived/abc.dzi", content=b"<Image/>", headers={**W(), "Content-Type": "application/xml"})
    client.post(f"/api/v1/worker/derivatives/{row['id']}/complete", json={"sha": "abc", "key": dzi, "keys": tiles, "meta": {"mpp": 0.25}}, headers=W())
    assert client.delete(f"/api/v1/projects/{first}").status_code == 200  # the demo loop: trash, drop again
    second, claimed = _slide_row(client, "Second")
    assert claimed == {}  # nothing to convert
    with kdb.session_scope() as db:
        mine = db.scalar(select(Derivative).where(Derivative.project_id == second))
        assert mine.state == "ready" and mine.blob_key == dzi and mine.meta == {"mpp": 0.25}
        assert db.scalar(select(Asset.id).where(Asset.workspace_id == second, Asset.path == dzi)) is not None
        # Purging the first project leaves the files the second one shows.
        nodes = list(db.scalars(select(SourceNode.id).where(SourceNode.project_id == first).execution_options(**INCLUDE_TRASHED)))
        assert nodes
        assert d.derived_keys(db, nodes) == []


# ---- todo19 P0-2 / D10: a missing converter waits; capabilities re-queue it ------------------


def _cap_db() -> Session:
    from studio_api.models import WorkerCapability

    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng, tables=[*TABLES, WorkerCapability.__table__])  # type: ignore[list-item]
    return Session(eng)


def test_a_missing_converter_waits_instead_of_failing():
    from studio_api.kernel import capabilities as caps

    db = _cap_db()
    row = d.request(db, SimpleNamespace(id="nod-s", project_id="p"), "slide-dzi")
    [claimed] = d.claim(db)
    d.fail(db, claimed, "OpenSlide isn't installed", retry=False, unavailable=True)
    assert claimed.state == "waiting" and claimed.attempts == 0
    s = d.state_for(db, ["nod-s"])["nod-s"]
    assert s["state"] == "waiting" and s["error"] == "Waiting for a converter: OpenSlide"
    assert d.claim(db) == []  # nobody can serve it yet
    # a worker without OpenSlide reports: still waiting
    assert caps.report(db, "w1", {"ffmpeg": "7.1"}) == 0 and row.state == "waiting"
    # one with it: re-queued, claimable only by a worker that serves slides
    assert caps.report(db, "w2", {"openslide": "4.0.1"}) == 1 and row.state == "pending"
    assert d.claim(db, kinds=["video-mp4"]) == []
    assert d.claim(db, kinds=["slide-dzi"]) == [row]


def test_capabilities_expire_and_requeue_legacy_isnt_installed_failures():
    from datetime import timedelta

    from studio_api.kernel import capabilities as caps

    db = _cap_db()
    row = d.request(db, SimpleNamespace(id="nod-old", project_id="p"), "slide-dzi")
    row.state, row.attempts, row.error = "failed", 1, "Slide tiling isn't available: OpenSlide isn't installed on the worker"
    codec = d.request(db, SimpleNamespace(id="nod-c", project_id="p"), "video-mp4")
    codec.state, codec.error = "failed", "ffmpeg can't decode cinepak video"
    db.flush()
    assert caps.report(db, "w", {"openslide": "4.0.1", "ffmpeg": "7.1"}, ttl_s=60) == 1
    assert row.state == "pending" and row.attempts == 0 and codec.state == "failed"
    assert set(caps.live(db)) == {"openslide", "ffmpeg"}
    assert caps.live(db, now=d._now() + timedelta(seconds=120)) == {}


def test_capabilities_route_requeues_a_waiting_slide(client):
    from .conftest import worker_headers as W
    from .test_explore import _report
    from .test_projects import _import

    p = client.post("/api/v1/projects", json={"title": "Slides"}).json()["id"]
    imp = _import(client, p, {"s.svs": b"II*\x00"})
    _report(client, imp, {"s.svs": "slide"}, {"s.svs": {"derivative": {"kind": "slide-dzi"}}})
    [row] = client.post("/api/v1/worker/derivatives/claim", json={"kinds": ["slide-dzi"]}, headers=W()).json()["derivatives"]
    r = client.post(f"/api/v1/worker/derivatives/{row['id']}/fail", json={"reason": "OpenSlide isn't installed", "unavailable": True}, headers=W()).json()
    assert r["state"] == "waiting"
    assert client.post("/api/v1/workers/capabilities", json={"workerId": "w", "capabilities": {}}).status_code in (401, 403)
    rep = client.post("/api/v1/workers/capabilities", json={"workerId": "w", "capabilities": {"openslide": "4.0.1"}}, headers=W()).json()
    assert rep["requeued"] == 1 and rep["kinds"] == ["slide-dzi"]
    assert client.get("/api/v1/workers/capabilities", headers=W()).json()["capabilities"] == {"openslide": "4.0.1"}
    assert [x["id"] for x in client.post("/api/v1/worker/derivatives/claim", json={"kinds": ["slide-dzi"]}, headers=W()).json()["derivatives"]] == [row["id"]]
