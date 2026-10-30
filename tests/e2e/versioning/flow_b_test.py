"""Flow B (versioning.md §16B): two users edit the same annotation → conflict → resolve →
merge → release. Also the Studio's save contract: a save from a stale head is a 409
`stale_head` ("someone else saved; refresh and re-apply"), never a silent overwrite.
"""

from __future__ import annotations

from common import Actor, box, png, run_id


def seed_main(owner: Actor, steward: Actor, ds: str, anns: list[dict]) -> None:
    """Put `anns` (and samples for their items) on main through a reviewed merge."""
    owner.post("/api/v1/datasets", json={"id": ds}, expect=201)
    b = owner.post(f"/api/v1/datasets/{ds}/branches", json={"name": f"import/{ds}"}, expect=201).json()
    art = owner.upload(ds, png(64, 48), "image/png")
    sample = {"sample_id": "img:a.png", "modality": "image", "width": 64, "height": 48, "objects": [{"role": "image", "sha256": art["sha256"], "size_bytes": art["size_bytes"], "media_type": "image/png"}]}
    owner.post(f"/api/v1/datasets/{ds}/commits", json={"branch": b["name"], "expected_head": b["commit_oid"], "message": "import", "changes": {"samples": [sample], "annotations": anns}}, expect=201)
    rv = owner.post(f"/api/v1/datasets/{ds}/reviews", json={"title": "import", "source_branch": b["name"]}, expect=201).json()
    rv = steward.wait_review(ds, rv["id"], {"READY"})
    steward.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]}, expect=200)
    steward.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/merge", json={}, expect=200)


def studio_save(user: Actor, ds: str, branch: str, head: str, anns: list[dict]):
    """What the Studio's versioned autosave sends: the whole document, with expected_head."""
    return user.post(f"/api/v1/datasets/{ds}/commits", json={"branch": branch, "expected_head": head, "message": "Save annotations", "document": {"annotations": anns}})


def run(api: str) -> None:
    ws, ds = f"e2e-b-{run_id()}", "labels"
    alice, bob = Actor(api, ws, "user:alice"), Actor(api, ws, "user:bob")
    seed_main(alice, bob, ds, [box("lv-1", "img/a.png", 10)])

    # Each opens the Studio: a work branch per user per dataset, loaded from main.
    wa = alice.post(f"/api/v1/datasets/{ds}/branches", json={}, expect=201).json()
    wb = bob.post(f"/api/v1/datasets/{ds}/branches", json={}, expect=201).json()
    assert (wa["name"], wb["name"]) == (f"work/user-alice/{ds}", f"work/user-bob/{ds}")
    doc = bob.get(f"/api/v1/datasets/{ds}/document", params={"ref": wb["name"]}, expect=200).json()
    assert [a["geometry"]["x"] for a in doc["annotations"]] == [10]

    # Both move the same box.
    ra = studio_save(alice, ds, wa["name"], wa["commit_oid"], [box("lv-1", "img/a.png", 20)])
    assert ra.status_code == 201, ra.text
    rb = studio_save(bob, ds, wb["name"], wb["commit_oid"], [box("lv-1", "img/a.png", 30, author="user:bob")])
    assert rb.status_code == 201, rb.text
    bob_head = rb.json()["commit_oid"]
    # A second tab of Bob's saving from the old head is refused with the current head.
    stale = studio_save(bob, ds, wb["name"], wb["commit_oid"], [box("lv-1", "img/a.png", 31, author="user:bob")])
    assert stale.status_code == 409 and stale.json()["code"] == "stale_head" and stale.json()["current_head"] == bob_head, stale.text

    # Alice's change lands first.
    rv_a = alice.post(f"/api/v1/datasets/{ds}/reviews", json={"title": "Alice: move LV"}, expect=201).json()
    rv_a = bob.wait_review(ds, rv_a["id"], {"READY"})
    bob.post(f"/api/v1/datasets/{ds}/reviews/{rv_a['id']}/approve", json={"source_oid": rv_a["source_oid"]}, expect=200)
    bob.post(f"/api/v1/datasets/{ds}/reviews/{rv_a['id']}/merge", json={}, expect=200)

    # Bob's review now conflicts on lv-1.
    rv_b = bob.post(f"/api/v1/datasets/{ds}/reviews", json={"title": "Bob: move LV"}, expect=201).json()
    rv_b = alice.wait_review(ds, rv_b["id"], {"CONFLICTED", "READY", "BLOCKED"})
    assert rv_b["status"] == "CONFLICTED", (rv_b["status"], rv_b["checks"])
    keys = [c["conflict_key"] for c in rv_b["conflicts"]]
    assert keys and all("lv-1" in k for k in keys), keys
    ours = next((c.get("ours_annotation") for c in rv_b["conflicts"] if c.get("ours_annotation")), None)
    theirs = next((c.get("theirs_annotation") for c in rv_b["conflicts"] if c.get("theirs_annotation")), None)
    assert ours and theirs and ours["geometry"]["x"] == 20 and theirs["geometry"]["x"] == 30
    # A self-merge or an unresolved merge is refused.
    assert bob.post(f"/api/v1/datasets/{ds}/reviews/{rv_b['id']}/merge", json={}).json()["code"] == "not_ready"

    # Resolve with a custom box (the service reports field-level keys, annotation:<id>:<field>;
    # a custom choice replaces the whole entry with a new revision the kernel uploads).
    res = [{"conflict_key": c["conflict_key"], "choice": "custom", "annotation": box("lv-1", "img/a.png", 25, author="user:bob")} for c in rv_b["conflicts"]]
    r = bob.post(f"/api/v1/datasets/{ds}/reviews/{rv_b['id']}/resolutions", json={"source_oid": rv_b["source_oid"], "target_oid": rv_b["checked_target_oid"], "resolutions": res}, expect=200).json()
    rv_b = alice.wait_review(ds, rv_b["id"], {"READY", "BLOCKED", "CONFLICTED"}) if r["status"] not in ("READY",) else r
    assert rv_b["status"] == "READY", (rv_b["status"], rv_b["checks"], rv_b["conflicts"])
    alice.post(f"/api/v1/datasets/{ds}/reviews/{rv_b['id']}/approve", json={"source_oid": rv_b["source_oid"]}, expect=200)
    merged = alice.post(f"/api/v1/datasets/{ds}/reviews/{rv_b['id']}/merge", json={}, expect=200).json()
    assert merged["status"] == "MERGED"

    main = alice.get(f"/api/v1/datasets/{ds}/document", params={"ref": "main"}, expect=200).json()
    lv = [a for a in main["annotations"] if a["id"] == "lv-1"]
    assert len(lv) == 1 and lv[0]["geometry"]["x"] == 25, lv
    alice.post(f"/api/v1/datasets/{ds}/releases", json={"tag": "v2", "ref": "main"}, expect=201)
    rels = alice.get(f"/api/v1/datasets/{ds}/releases", expect=200).json()["items"]
    assert [x["tag"] for x in rels] == ["v2"]
    print(f"flow B ok: conflicts {keys} resolved with a custom box, merged, released v2")


if __name__ == "__main__":
    from stack import main_for

    main_for(run)
