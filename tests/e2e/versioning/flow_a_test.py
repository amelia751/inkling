"""Flow A (versioning.md §16A): initial upload → reviewed into `main` → release `v1` visible.

Bytes go to object storage through the API; the commit lands on the uploader's work branch
(`main` is protected); the worker's de-identification check and the service's checks run; a
data steward approves and merges; `v1` is released and readable back, bytes verified.
"""

from __future__ import annotations

import hashlib

import httpx

from common import Actor, box, png, run_id


def run(api: str) -> None:
    rid = run_id()
    ws, ds = f"e2e-a-{rid}", "scans"
    uploader, steward = Actor(api, ws, "user:uploader"), Actor(api, ws, "user:steward")

    repo = uploader.post("/api/v1/datasets", json={"id": ds, "name": "Scans"}, expect=201).json()
    assert repo["defaultBranch"] == "main" and repo["created"]
    images = {f"img/{i}.png": png(16, 12, seed=i) for i in range(3)}
    samples = []
    for i, (path, data) in enumerate(images.items()):
        art = uploader.upload(ds, data, "image/png")
        samples.append({"sample_id": path.replace("/", ":"), "modality": "image", "width": 16, "height": 12, "split": "train", "objects": [{"role": "image", "sha256": art["sha256"], "size_bytes": art["size_bytes"], "media_type": "image/png"}]})
    b = uploader.post(f"/api/v1/datasets/{ds}/branches", json={}, expect=201).json()
    assert b["name"] == f"work/user-uploader/{ds}"
    c = uploader.post(f"/api/v1/datasets/{ds}/commits", json={"branch": b["name"], "expected_head": b["commit_oid"], "message": "Initial upload",
                                                             "changes": {"samples": samples, "annotations": [box("seed-1", "img/0.png", 2)]}}, expect=201).json()
    assert c["sample_count"] == 3 and c["annotation_count"] == 1

    rv = uploader.post(f"/api/v1/datasets/{ds}/reviews", json={"title": "Initial upload"}, expect=201).json()
    rv = steward.wait_review(ds, rv["id"], {"READY", "BLOCKED", "CONFLICTED"})
    assert rv["status"] == "READY", [(x["name"], x["outcome"], x.get("details")) for x in rv["checks"]]
    deid = next(x for x in rv["checks"] if x["name"] == "deidentification")
    assert deid["outcome"] == "passed" and deid["details"]["samples_scanned"] >= 3
    steward.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]}, expect=200)
    merged = steward.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/merge", json={"message": "Initial upload"}, expect=200).json()
    assert merged["status"] == "MERGED" and merged.get("merge_oid")

    rel = steward.post(f"/api/v1/datasets/{ds}/releases", json={"tag": "v1", "ref": "main"}, expect=201).json()
    assert rel["tag"] == "v1"
    # "v1 visible": listed, its annotations load, its bytes come back intact.
    assert [x["tag"] for x in uploader.get(f"/api/v1/datasets/{ds}/releases", expect=200).json()["items"]] == ["v1"]
    doc = uploader.get(f"/api/v1/datasets/{ds}/document", params={"ref": "tag:v1"}, expect=200).json()
    assert [a["id"] for a in doc["annotations"]] == ["seed-1"] and doc["annotations"][0]["geometry"]["x"] == 2
    co = uploader.post(f"/api/v1/datasets/{ds}/checkouts", json={"ref": "tag:v1"}, expect=200).json()
    assert len(co["samples"]) == 3
    by_sha = {o["sha256"]: o for o in co["objects"]}
    for data in images.values():
        o = by_sha[hashlib.sha256(data).hexdigest()]
        assert o["status"] in ("available", "staged") and httpx.get(o["url"]).content == data
    hist = uploader.get(f"/api/v1/datasets/{ds}/commits", params={"ref": "main"}, expect=200).json()["items"]
    ops = [h["operation"] for h in hist]
    assert ops[0] == "merge" and "init" in ops and "commit" in ops, ops
    print("flow A ok: initial upload reviewed into main, v1 released and verified")


if __name__ == "__main__":
    from stack import main_for

    main_for(run)
