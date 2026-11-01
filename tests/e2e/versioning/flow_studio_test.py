"""Flow S (todo10 Phase 2): the Studio definition is versioned with the dataset.

A person sets up a task (environment + README), saves it (a commit of `.studio/` on their work
branch: lockfile, environment, README), annotates, requests review (the setup travels with
it), a steward approves and merges, `v1` is released. Then:

- `v1` pins exactly that environment and plugins.lock.json (hashes and content), whatever the
  Studio runs later;
- the setup changes (a new environment, a plugin disabled); reverting the work branch to the
  saved version restores the Studio's environment and plugin pins (lockfile hash matches).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps" / "api" / "src"))

from common import Actor, box, png, run_id  # noqa: E402
from studio_api.kernel.canonical import content_hash  # noqa: E402

ENV1 = {"extends": "preset:image-2d", "task": "detection", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "lesion"}]}]}
ENV2 = {**ENV1, "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "lesion"}, {"id": "cyst"}]}]}


def run(api: str) -> None:
    rid = run_id()
    ws, ds = f"e2e-s-{rid}", "scans"
    alice, steward = Actor(api, ws, "user:alice"), Actor(api, ws, "user:steward")

    alice.post("/api/v1/datasets", json={"id": ds, "name": "Scans"}, expect=201)
    # Task setup: environment and notes, saved.
    alice.req("PUT", f"/api/environments/{ws}", json={"revision": alice.get(f"/api/environments/{ws}", expect=200).json()["revision"], "environment": ENV1}, expect=200)
    alice.req("PUT", f"/api/environments/{ws}/readme", json={"text": "# Scans\n\nBox every lesion.\n"}, expect=200)
    lock1 = alice.get(f"/api/environments/{ws}/lockfile", expect=200).json()
    assert lock1["lockfile"]["plugins"], "the workspace has first-party pins"
    saved = alice.post(f"/api/v1/datasets/{ds}/studio/commits", json={"reason": "Task setup saved"}, expect=201).json()
    assert saved["studio"]["tasks"] == {ws: content_hash(ENV1)} and saved["studio"]["lockfileHash"] == lock1["contentHash"]
    setup_oid = saved["commit_oid"]

    # Annotate on the work branch; the save keeps the setup.
    art = alice.upload(ds, png(16, 12, seed=1), "image/png")
    b = alice.get(f"/api/v1/datasets/{ds}/branches", expect=200).json()
    work = next(x for x in b["items"] if x["name"] == b["workBranch"])
    c = alice.post(f"/api/v1/datasets/{ds}/commits", json={"branch": work["name"], "expected_head": work["commit_oid"], "message": "Boxes",
                                                           "changes": {"samples": [{"sample_id": "img:0.png", "modality": "image", "width": 16, "height": 12, "split": "train", "objects": [{"role": "image", "sha256": art["sha256"], "size_bytes": art["size_bytes"], "media_type": "image/png"}]}],
                                                                       "annotations": [box("a1", "img/0.png", 2)]}}, expect=201).json()
    assert c.get("studio_tree") == saved["studio_tree"], c

    # Review → main → release v1.
    rv = alice.post(f"/api/v1/datasets/{ds}/reviews", json={"title": "Scans, first pass"}, expect=201).json()
    rv = steward.wait_review(ds, rv["id"], {"READY", "BLOCKED", "CONFLICTED"})
    assert rv["status"] == "READY", [(x["name"], x["outcome"]) for x in rv["checks"]]
    steward.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]}, expect=200)
    steward.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/merge", json={}, expect=200)
    rel = steward.post(f"/api/v1/datasets/{ds}/releases", json={"tag": "v1", "ref": "main"}, expect=201).json()
    assert rel["studio_tree"] == saved["studio_tree"] and rel["studio"]["tasks"] == {ws: content_hash(ENV1)}, rel
    assert rel["studio"]["lockfileHash"] == lock1["contentHash"] and "studioWarning" not in rel, rel

    # The setup changes: another class, and a plugin disabled.
    alice.req("PUT", f"/api/environments/{ws}", json={"revision": alice.get(f"/api/environments/{ws}", expect=200).json()["revision"], "environment": ENV2}, expect=200)
    # (one nothing else requires: disabling a required plugin is refused)
    victim = next(p for p in reversed(lock1["lockfile"]["plugins"]) if alice.post(f"/api/v1/workspaces/{ws}/plugins/disable", json={"pluginId": p["id"]}).status_code == 200)
    assert alice.get(f"/api/environments/{ws}/lockfile", expect=200).json()["contentHash"] != lock1["contentHash"]

    # v1 still pins the old setup, byte for byte.
    v1 = alice.get(f"/api/v1/datasets/{ds}/studio", params={"ref": "tag:v1", "current": "true"}, expect=200).json()
    assert v1["tasks"][ws]["environment"] == ENV1 and v1["tasks"][ws]["readme"].startswith("# Scans")
    assert v1["lockfile"] == lock1["lockfile"] and v1["lockfileHash"] == lock1["contentHash"]
    assert v1["current"]["tasks"][ws]["environment"] == ENV2 and v1["current"]["summary"]["fingerprint"] != v1["summary"]["fingerprint"]

    # Restoring the saved version restores its Studio setup.
    head = alice.post(f"/api/v1/datasets/{ds}/branches", json={}, expect=(200, 201)).json()
    r = alice.post(f"/api/v1/datasets/{ds}/reverts", json={"branch": head["name"], "expected_head": head["commit_oid"], "target_oid": setup_oid}, expect=201).json()
    assert r["restoredStudio"]["environments"][ws]["contentHash"] == content_hash(ENV1), r
    assert victim["id"] in r["restoredStudio"]["plugins"]["restored"], r
    env = alice.get(f"/api/environments/{ws}", expect=200).json()
    assert env["environment"] == ENV1 and env["contentHash"] == content_hash(ENV1)
    assert alice.get(f"/api/environments/{ws}/lockfile", expect=200).json()["contentHash"] == lock1["contentHash"]
    hist = alice.get(f"/api/environments/{ws}/history", expect=200).json()
    assert [h["contentHash"] for h in hist][-1] == content_hash(ENV1) and all(h["parentHash"].startswith("sha256:") for h in hist)
    print("flow S ok: v1 pins the environment and lockfile; reverting restored the Studio setup")


if __name__ == "__main__":
    from stack import main_for

    main_for(run)
