"""Flow C (versioning.md §16C): an agent proposes a change on its own branch through the
kernel commands → a human approves → merged. The agent's attempts to approve, merge, or write
outside `work/agent-*` are rejected (by the kernel, and the service would refuse too).
"""

from __future__ import annotations

from common import Actor, box, run_id
from flow_b_test import seed_main

AGENT_SCOPES = ["commands.invoke", "versioning.read", "versioning.write", "versioning.review", "versioning.checkout",
                # Granted on purpose: the kernel still refuses agents these operations.
                "versioning.approve", "versioning.merge", "versioning.release"]


def run(api: str) -> None:
    ws, ds = f"e2e-c-{run_id()}", "cells"
    alice, bob = Actor(api, ws, "user:alice"), Actor(api, ws, "user:bob")
    seed_main(alice, bob, ds, [box("c-1", "img/a.png", 5)])
    agent = alice.agent("proposer", AGENT_SCOPES)  # an agent run Alice started

    b = agent.command("versioning.branch", expect=201, dataset=ds).json()["result"]
    assert b["name"] == f"work/agent-proposer/{ds}", b
    # Writing anywhere else is refused.
    bad = agent.command("versioning.branch", dataset=ds, name="review/sneaky")
    assert bad.status_code == 403 and bad.json()["code"] == "forbidden", bad.text
    main_head = next(x for x in alice.get(f"/api/v1/datasets/{ds}/branches", expect=200).json()["items"] if x["name"] == "main")["commit_oid"]
    assert agent.command("versioning.commit", dataset=ds, branch="main", expected_head=main_head, changes={"annotations": [box("c-2", "img/a.png", 30)]}).status_code == 403

    c = agent.command("versioning.commit", expect=201, dataset=ds, branch=b["name"], expected_head=b["commit_oid"], message="Propose c-2", tool="segment",
                      changes={"annotations": [box("c-2", "img/a.png", 30, label="cell", author="agent:proposer")]}).json()["result"]
    d = agent.command("versioning.diff", expect=200, dataset=ds, base="main", head=b["name"]).json()["result"]
    assert [ch["annotation_id"] for ch in d["changes"] if ch["type"] == "annotation.added"] == ["c-2"], d["changes"]
    rv = agent.command("versioning.review.open", expect=201, dataset=ds, title="Agent proposal: c-2").json()["result"]
    assert rv["source_oid"] == c["commit_oid"] and rv["author_id"] == "agent:proposer" and rv.get("author_on_behalf_of") == "user:alice"

    rv = bob.wait_review(ds, rv["id"], {"READY", "BLOCKED", "CONFLICTED"})
    assert rv["status"] == "READY", rv["checks"]
    # The agent can't approve, merge or release, through commands or routes.
    for cmd in ("versioning.review.approve", "versioning.merge"):
        r = agent.command(cmd, dataset=ds, review_id=rv["id"], source_oid=rv["source_oid"])
        assert r.status_code == 403 and r.json()["code"] == "forbidden", (cmd, r.text)
    assert agent.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]}).status_code == 403
    assert agent.command("versioning.release", dataset=ds, tag="agent-v1").status_code == 403
    # Nor can the user it acts for approve its proposal (author on behalf of).
    sa = alice.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]})
    assert sa.status_code == 403 and sa.json()["code"] == "self_approval", sa.text

    bob.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]}, expect=200)
    merged = bob.post(f"/api/v1/datasets/{ds}/reviews/{rv['id']}/merge", json={}, expect=200).json()
    assert merged["status"] == "MERGED"
    main = bob.get(f"/api/v1/datasets/{ds}/document", params={"ref": "main"}, expect=200).json()
    assert sorted(a["id"] for a in main["annotations"]) == ["c-1", "c-2"]
    hist = bob.get(f"/api/v1/datasets/{ds}/commits", params={"ref": b["name"]}, expect=200).json()["items"]
    assert hist[0]["author_id"] == "agent:proposer" and hist[0].get("on_behalf_of") == "user:alice", hist[0]
    denied = [e for e in alice.get("/api/v1/audit", params={"action": "versioning.denied"}, expect=200).json()["entries"] if e["actor"] == "agent:proposer"]
    assert len(denied) >= 6, denied
    print("flow C ok: agent proposal merged after human approval; agent approve/merge/release refused")


if __name__ == "__main__":
    from stack import main_for

    main_for(run)
