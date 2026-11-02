"""todo18 D4: derivative rows — request, claim, progress, retry, ready/failed, purge keys."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from studio_api.db import Base
from studio_api.kernel import derivatives as d
from studio_api.models import Derivative


def _db() -> Session:
    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng, tables=[Derivative.__table__])  # type: ignore[list-item]
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
