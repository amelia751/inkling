"""The worker's de-identification check: a review opened through the kernel is checked by
the worker loop and the result posted back (todo4 Phase 6). apps/versioning is the kernel's
in-memory stand-in, installed in the same process as the live kernel."""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from studio_worker.deid import DeidSubscriber, scan
from studio_worker.main import Worker


@pytest.fixture
def versioning():
    from studio_api.kernel.versioning import client as vclient, service
    from studio_api.kernel.versioning.fake import FakeVersioning

    fake = FakeVersioning()
    vclient.set_client(fake)
    service.clear_cache()
    yield fake
    vclient.set_client(None)
    service.clear_cache()


def ann(id_: str, item: str = "img/a.png") -> dict:
    return {"id": id_, "itemId": item, "label": "cell", "geometry": {"type": "box", "x": 1, "y": 1, "w": 4, "h": 4}, "provenance": "human-created", "author": "user:a", "createdAt": "2026-10-30T00:00:00Z"}


def open_review(url: str, ws: str, extra_sample: dict | None = None, blob: bytes | None = None) -> dict:
    h = {"X-Workspace-Id": ws, "X-Dev-Principal": "user:alice"}
    assert httpx.post(f"{url}/api/v1/datasets", json={"id": "ds"}, headers=h).status_code == 201
    b = httpx.post(f"{url}/api/v1/datasets/ds/branches", json={}, headers=h).json()
    changes: dict = {"annotations": [ann("a1")]}
    if blob is not None:
        art = httpx.post(f"{url}/api/v1/datasets/ds/artifacts", content=blob, headers={**h, "Content-Type": "application/json"}).json()
        changes["samples"] = [{**(extra_sample or {}), "objects": [{"role": "metadata", "sha256": art["sha256"], "size_bytes": art["size_bytes"], "media_type": "application/json"}]}]
    r = httpx.post(f"{url}/api/v1/datasets/ds/commits", json={"branch": b["name"], "expected_head": b["commit_oid"], "changes": changes}, headers=h)
    assert r.status_code == 201, r.text
    rv = httpx.post(f"{url}/api/v1/datasets/ds/reviews", json={"title": "t"}, headers=h).json()
    assert rv["status"] == "CHECKING"
    return rv


def deid(rv: dict) -> dict:
    return next(c for c in rv["checks"] if c["name"] == "deidentification")


def test_review_opened_is_checked_by_the_worker_loop(stack, tmp_path, versioning):
    url = stack["url"]
    rv = open_review(url, "deid-ok")
    w = Worker(url, stack["token"], tmp_path, "w-deid")
    w.tick()
    after = httpx.get(f"{url}/api/v1/datasets/ds/reviews/{rv['id']}", headers={"X-Workspace-Id": "deid-ok"}).json()
    c = deid(after)
    assert c["outcome"] == "passed" and c["details"]["checker"] == "dev-metadata-v1" and c["details"]["samples_scanned"] == 1
    assert after["status"] == "READY"
    # Acknowledged: a second pass does nothing.
    assert w.deid.tick() == 0


def test_identifier_metadata_fails_the_check(stack, versioning):
    url = stack["url"]
    meta = json.dumps({"StudyDescription": "chest", "PatientName": "DOE^JANE", "notes": "call 555-123-4567"}).encode()
    rv = open_review(url, "deid-bad", {"sample_id": "s-meta", "modality": "image"}, meta)
    http = httpx.Client(base_url=url, headers={"X-Worker-Token": stack["token"]})
    sub = DeidSubscriber(http)
    sub._json = lambda u: json.loads(versioning.fetch(u))  # the stand-in's objects live in-process
    assert sub.tick() == 1
    after = httpx.get(f"{url}/api/v1/datasets/ds/reviews/{rv['id']}", headers={"X-Workspace-Id": "deid-bad"}).json()
    c = deid(after)
    assert c["outcome"] == "failed" and after["status"] == "BLOCKED"
    reasons = {(f["path"], f["reason"]) for f in c["details"]["findings"]}
    assert ("PatientName", "identifier-like key") in reasons and ("notes", "phone-shaped value") in reasons
    assert hashlib.sha256(meta).hexdigest() in json.dumps(versioning.manifests)  # the sample really carries it


def test_scan_ignores_opaque_hashes_and_clean_metadata():
    assert scan([{"sample_id": "s1", "modality": "ct", "group": {"study_uid_hash": "a" * 64}, "objects": []}], [], {}) == []
    assert scan([], [{"annotation_id": "a", "ref": "sha256:" + "b" * 64}], {"b" * 64: {"attributes": {"studio_hash": "c" * 32}}}) == []
    assert scan([{"sample_id": "s", "objects": [{"sha256": "x", "role": "m"}]}], [], {"x": {"birth_date": "1970"}})[0]["reason"] == "identifier-like key"
