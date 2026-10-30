"""Dataset versioning routes and kernel commands (todo4 Phase 6), against the in-memory fake
of apps/versioning (no Go, Postgres or object storage needed)."""

from __future__ import annotations

import base64
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from studio_api.context import RequestContext
from studio_api.kernel.versioning import auth, client as vclient, service
from studio_api.kernel.versioning.fake import FakeVersioning
from studio_api.naming import ns

from .conftest import worker_headers, ws

ALICE = ws("ws-a", **{"X-Dev-Principal": "user:alice"})
BOB = ws("ws-a", **{"X-Dev-Principal": "user:bob"})


def ann(id_: str, item: str = "img/a.png", label: str = "lesion", x: float = 1, **extra) -> dict:
    return {"id": id_, "itemId": item, "label": label, "geometry": {"type": "box", "x": x, "y": 2, "w": 5, "h": 4}, "provenance": "human-created", "author": "user:alice", "createdAt": "2026-10-30T00:00:00Z", **extra}


@pytest.fixture
def fake():
    f = FakeVersioning()
    vclient.set_client(f)
    service.clear_cache()
    yield f
    vclient.set_client(None)
    service.clear_cache()


@pytest.fixture
def vc(client, fake):
    r = client.post("/api/v1/datasets", json={"id": "ds"}, headers=ALICE)
    assert r.status_code == 201, r.text
    return client


def work(c, headers) -> dict:
    r = c.post("/api/v1/datasets/ds/branches", json={}, headers=headers)
    assert r.status_code in (200, 201), r.text
    return r.json()


def save(c, headers, branch: dict, anns: list[dict], expected: str | None = None):
    return c.post("/api/v1/datasets/ds/commits", json={"branch": branch["name"], "expected_head": expected or branch["commit_oid"], "message": "save", "document": {"annotations": anns}}, headers=headers)


def deid_pass(c, review: dict) -> dict:
    """Act as the worker's de-identification subscriber for one review."""
    r = c.post("/api/v1/worker/versioning/run", json={"workspaceId": "ws-a", "datasetId": "ds", "op": "review.check", "subscriber": "deid", "body": {"review_id": review["id"], "source_oid": review["source_oid"], "target_oid": review["checked_target_oid"], "outcome": "passed", "details": {"findings": []}}}, headers=worker_headers())
    assert r.status_code == 200, r.text
    return r.json()


def land(c, author, approver, anns, title="change") -> dict:
    """Commit on `author`'s work branch, open a review into main, pass checks, approve, merge."""
    b = work(c, author)
    assert save(c, author, b, anns).status_code == 201
    rv = c.post("/api/v1/datasets/ds/reviews", json={"title": title}, headers=author).json()
    rv = deid_pass(c, rv)
    assert rv["status"] == "READY", rv
    assert c.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]}, headers=approver).status_code == 200
    m = c.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/merge", json={}, headers=approver)
    assert m.status_code == 200, m.text
    return m.json()


def agent_token(c, scopes=("commands.invoke", "versioning.read", "versioning.write", "versioning.review", "versioning.checkout", "versioning.approve", "versioning.merge")) -> dict:
    r = c.post("/api/v1/sessions", json={"agent": "proposer", "scopes": list(scopes)}, headers=ALICE)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ---- Off by default -----------------------------------------------------------------------


def test_off_by_default(client):
    vclient.set_client(None)
    assert client.get("/api/v1/versioning/status").json() == {"configured": False, "ready": False}
    r = client.post("/api/v1/datasets", json={"id": "ds"}, headers=ALICE)
    assert r.status_code == 503 and r.json()["code"] == "disabled"
    assert r.headers["content-type"].startswith("application/problem+json")


def test_status_configured(vc):
    s = vc.get("/api/v1/versioning/status", headers=ALICE).json()
    assert s["configured"] and s["ready"] and s["principal"] == "user:alice"


# ---- The service JWT (V4) -----------------------------------------------------------------


def test_minted_jwt_is_short_lived_scoped_and_verifiable(vc, fake):
    b = work(vc, ALICE)
    assert save(vc, ALICE, b, [ann("a1")]).status_code == 201
    method, claims = next((m, c) for m, c in fake.calls if m == "create_commit")
    assert claims["exp"] - claims["iat"] == 60
    assert claims["aud"] == ["versioning"] and claims["iss"] == "api"
    assert claims["tenant_id"] == auth.tenant_uuid() and claims["project_id"] == auth.project_uuid("ws-a")
    assert claims["actor"] == {"id": "user:alice", "kind": "user"}
    assert set(claims["scopes"]) == {"versioning:read", "versioning:write", "versioning:checkout"}
    # The public half the Go service reads verifies the signature.
    _, jwks_path = auth.key_paths()
    jwk = json.loads(jwks_path.read_text())["keys"][0]
    pub = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(jwk["x"] + "=="))
    tok = auth.mint(RequestContext("ws-a", "user:alice", "cid"), ["versioning:read"])
    head, body, sig = tok.split(".")
    pub.verify(base64.urlsafe_b64decode(sig + "=="), f"{head}.{body}".encode())
    assert json.loads(base64.urlsafe_b64decode(head + "=="))["kid"] == jwk["kid"]
    # Reads mint read-only tokens.
    vc.get("/api/v1/datasets/ds/branches", headers=ALICE)
    assert fake.calls[-1][1]["scopes"] == ["versioning:read"]


# ---- Save flow ----------------------------------------------------------------------------


def test_work_branch_save_load_roundtrip_and_stale_head(vc):
    b = work(vc, ALICE)
    assert b["name"] == "work/user-alice/ds" and b["created"]
    assert work(vc, ALICE)["created"] is False  # ensuring it again is a no-op
    a = ann("a1", attributes={"occluded": True, "note": "Has spaces & Caps"}, locked=True)
    r = save(vc, ALICE, b, [a])
    assert r.status_code == 201, r.text
    head = r.json()["commit_oid"]
    doc = vc.get("/api/v1/datasets/ds/document", params={"ref": b["name"]}, headers=ALICE).json()
    assert doc["annotations"] == [a] and doc["head"] == head and doc["branch"] == b["name"]

    # A second save from the old head: someone else saved first.
    stale = save(vc, ALICE, b, [ann("a1", x=9)])
    assert stale.status_code == 409
    p = stale.json()
    assert p["code"] == "stale_head" and p["current_head"] == head and p["status"] == 409
    assert save(vc, ALICE, b, [ann("a1", x=9)], expected=head).status_code == 201


def test_main_is_protected(vc):
    main = next(x for x in vc.get("/api/v1/datasets/ds/branches", headers=ALICE).json()["items"] if x["name"] == "main")
    r = save(vc, ALICE, main, [ann("a1")])
    assert r.status_code == 403 and r.json()["code"] == "protected_branch"


def test_dataset_is_workspace_scoped(vc):
    r = vc.get("/api/v1/datasets/ds/branches", headers=ws("ws-b"))
    assert r.status_code == 404 and r.json()["code"] == "not_found"


def test_import_document_on_create(client, fake):
    client.put("/api/annotations/ws-a", json={"revision": 0, "annotations": [ann("old")]}, headers=ALICE)
    r = client.post("/api/v1/datasets", json={"id": "ds", "import_document": True}, headers=ALICE)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["workBranch"] == "work/user-alice/ds" and out["imported"]["annotations"] == 1
    doc = client.get("/api/v1/datasets/ds/document", headers=ALICE).json()
    assert [a["id"] for a in doc["annotations"]] == ["old"]


# ---- Reviews, merge, release --------------------------------------------------------------


def test_review_approve_merge_release(vc, client):
    b = work(vc, ALICE)
    assert save(vc, ALICE, b, [ann("a1")]).status_code == 201
    rv = vc.post("/api/v1/datasets/ds/reviews", json={"title": "labels"}, headers=ALICE).json()
    assert rv["status"] == "CHECKING" and rv["target_branch"] == "main"
    evs = vc.post("/api/v1/worker/subscriptions/claim", json={"subscriber": "deid", "types": ["versioning.review.opened"]}, headers=worker_headers()).json()["events"]
    assert [e["payload"]["reviewId"] for e in evs] == [rv["id"]] and evs[0]["payload"]["sourceOid"] == rv["source_oid"]

    diff = vc.get("/api/v1/datasets/ds/diff", params={"base": "main", "head": b["name"]}, headers=ALICE).json()
    added = [c for c in diff["changes"] if c["type"] == "annotation.added"]
    assert len(added) == 1 and added[0]["head_annotation"]["id"] == "a1"

    # Not READY until the de-identification check passes; never self-approved.
    m = vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/merge", json={}, headers=BOB)
    assert m.status_code == 409 and m.json()["code"] == "not_ready"
    rv = deid_pass(vc, rv)
    assert rv["status"] == "READY"
    s = vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/approve", json={}, headers=ALICE)
    assert s.status_code == 403 and s.json()["code"] == "self_approval"
    assert vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/approve", json={}, headers=BOB).status_code == 200
    merged = vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/merge", json={}, headers=BOB).json()
    assert merged["status"] == "MERGED"
    doc = vc.get("/api/v1/datasets/ds/document", params={"ref": "main"}, headers=BOB).json()
    assert [a["id"] for a in doc["annotations"]] == ["a1"]

    rel = vc.post("/api/v1/datasets/ds/releases", json={"tag": "v1"}, headers=BOB)
    assert rel.status_code == 201, rel.text
    assert [x["tag"] for x in vc.get("/api/v1/datasets/ds/releases", headers=ALICE).json()["items"]] == ["v1"]
    hist = vc.get("/api/v1/datasets/ds/commits", params={"ref": "main"}, headers=ALICE).json()["items"]
    assert hist[0]["operation"] == "merge"

    actions = [e["action"] for e in client.get("/api/v1/audit", headers=ALICE).json()["entries"]]
    for a in ("versioning.commit", "versioning.review.open", "versioning.review.approve", "versioning.merge", "versioning.release", "versioning.denied"):
        assert a in actions, a


def test_conflict_resolution(vc):
    land(vc, ALICE, BOB, [ann("a1", x=1)], "base")
    # Both branch from main and edit the same annotation.
    ba = vc.post("/api/v1/datasets/ds/branches", json={"name": "work/user-alice/ds-2", "from": "main"}, headers=ALICE).json()
    bb = vc.post("/api/v1/datasets/ds/branches", json={"name": "work/user-bob/ds-2", "from": "main"}, headers=BOB).json()
    assert save(vc, ALICE, ba, [ann("a1", x=10)]).status_code == 201
    assert save(vc, BOB, bb, [ann("a1", x=20)]).status_code == 201
    ra = deid_pass(vc, vc.post("/api/v1/datasets/ds/reviews", json={"source_branch": ba["name"]}, headers=ALICE).json())
    vc.post(f"/api/v1/datasets/ds/reviews/{ra['id']}/approve", json={}, headers=BOB)
    assert vc.post(f"/api/v1/datasets/ds/reviews/{ra['id']}/merge", json={}, headers=BOB).json()["status"] == "MERGED"

    rb = deid_pass(vc, vc.post("/api/v1/datasets/ds/reviews", json={"source_branch": bb["name"]}, headers=BOB).json())
    assert rb["status"] == "CONFLICTED"
    (cf,) = rb["conflicts"]
    assert cf["ours_annotation"]["geometry"]["x"] == 10 and cf["theirs_annotation"]["geometry"]["x"] == 20
    custom = ann("a1", x=15)
    r = vc.post(f"/api/v1/datasets/ds/reviews/{rb['id']}/resolutions", json={"resolutions": [{"conflict_key": cf["conflict_key"], "choice": "custom", "annotation": custom}]}, headers=BOB)
    assert r.status_code == 200 and r.json()["status"] == "READY", r.text
    vc.post(f"/api/v1/datasets/ds/reviews/{rb['id']}/approve", json={}, headers=ALICE)
    assert vc.post(f"/api/v1/datasets/ds/reviews/{rb['id']}/merge", json={}, headers=ALICE).json()["status"] == "MERGED"
    doc = vc.get("/api/v1/datasets/ds/document", params={"ref": "main"}, headers=ALICE).json()
    assert doc["annotations"] == [custom]


def test_stale_merge_target_requeues_checks(vc):
    ra_b = vc.post("/api/v1/datasets/ds/branches", json={"name": "work/user-alice/x"}, headers=ALICE).json()
    rb_b = vc.post("/api/v1/datasets/ds/branches", json={"name": "work/user-bob/y"}, headers=BOB).json()
    save(vc, ALICE, ra_b, [ann("a1")])
    save(vc, BOB, rb_b, [ann("b1", item="img/b.png")])
    ra = deid_pass(vc, vc.post("/api/v1/datasets/ds/reviews", json={"source_branch": ra_b["name"]}, headers=ALICE).json())
    rb = deid_pass(vc, vc.post("/api/v1/datasets/ds/reviews", json={"source_branch": rb_b["name"]}, headers=BOB).json())
    vc.post(f"/api/v1/datasets/ds/reviews/{ra['id']}/approve", json={}, headers=BOB)
    vc.post(f"/api/v1/datasets/ds/reviews/{rb['id']}/approve", json={}, headers=ALICE)
    assert vc.post(f"/api/v1/datasets/ds/reviews/{ra['id']}/merge", json={}, headers=BOB).status_code == 200
    # main moved under rb: the fake (like the service) re-checks it; the kernel re-announces.
    rb = vc.get(f"/api/v1/datasets/ds/reviews/{rb['id']}", headers=ALICE).json()
    assert rb["status"] == "CHECKING"
    evs = vc.post("/api/v1/worker/subscriptions/claim", json={"subscriber": "t", "types": ["versioning.review.checks_requested"]}, headers=worker_headers()).json()["events"]
    assert any(e["payload"]["reviewId"] == rb["id"] and e["payload"]["targetOid"] == rb["checked_target_oid"] for e in evs)


# ---- Agents (spec §16C) -------------------------------------------------------------------


def test_agent_policy_enforced_in_the_kernel(vc, fake):
    h = agent_token(vc)
    b = vc.post("/api/v1/datasets/ds/branches", json={}, headers=h)
    assert b.status_code == 201 and b.json()["name"] == "work/agent-proposer/ds"
    # Writes to anything but work/agent-* are refused before reaching the service.
    n = len(fake.calls)
    bad = vc.post("/api/v1/datasets/ds/branches", json={"name": "work/user-alice/sneaky"}, headers=h)
    assert bad.status_code == 403 and bad.json()["code"] == "forbidden" and len(fake.calls) == n
    alice = work(vc, ALICE)
    r = save(vc, h, alice, [ann("x")])
    assert r.status_code == 403 and len([m for m, _ in fake.calls if m == "create_commit"]) == 0

    ok = save(vc, h, b.json(), [ann("x")])
    assert ok.status_code == 201, ok.text
    claims = next(c for m, c in fake.calls if m == "create_commit")
    assert claims["actor"] == {"id": "agent:proposer", "kind": "agent", "on_behalf_of": "user:alice"}
    rv = vc.post("/api/v1/datasets/ds/reviews", json={"title": "agent proposal"}, headers=h)
    assert rv.status_code == 201, rv.text
    rv = deid_pass(vc, rv.json())
    for path in ("approve", "merge", "resolutions"):
        d = vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/{path}", json={"resolutions": []}, headers=h)
        assert d.status_code == 403, (path, d.text)
    assert vc.post("/api/v1/datasets/ds/releases", json={"tag": "v9"}, headers=h).status_code == 403
    assert not any(m in ("approve_review", "merge_review", "create_release") for m, _ in fake.calls)
    # The same through the command gateway.
    for cmd in ("versioning.review.approve", "versioning.merge"):
        r = vc.post("/api/v1/commands", json={"tool": ns(cmd), "input": {"dataset": "ds", "review_id": rv["id"]}}, headers=h)
        assert r.status_code == 403 and r.json()["code"] == "forbidden"
    # The agent's own user (or anyone) approves; the author-on-behalf-of can't.
    assert vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/approve", json={}, headers=ALICE).json()["code"] == "self_approval"
    assert vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/approve", json={}, headers=BOB).status_code == 200
    assert vc.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/merge", json={}, headers=BOB).json()["status"] == "MERGED"
    denied = [e for e in vc.get("/api/v1/audit", params={"action": "versioning.denied"}, headers=ALICE).json()["entries"] if e["actor"] == "agent:proposer"]
    assert len(denied) >= 5


def test_agent_needs_session_scopes(vc):
    h = agent_token(vc, scopes=("commands.invoke", "versioning.read"))
    r = vc.post("/api/v1/datasets/ds/branches", json={}, headers=h)
    assert r.status_code == 403 and "versioning.write" in r.json()["detail"]


# ---- Kernel commands ------------------------------------------------------------------------


def test_commands_through_the_gateway(vc):
    h = agent_token(vc)
    call = lambda cmd, **inp: vc.post("/api/v1/commands", json={"tool": ns(f"versioning.{cmd}"), "input": {"dataset": "ds", **inp}}, headers=h)  # noqa: E731
    b = call("branch")
    assert b.status_code == 201 and b.json()["command"] == ns("versioning.branch")
    branch = b.json()["result"]
    c = call("commit", branch=branch["name"], expected_head=branch["commit_oid"], message="agent", changes={"annotations": [ann("g1")]})
    assert c.status_code == 201, c.text
    d = call("diff", base="main", head=branch["name"]).json()["result"]
    assert d["summary"]["annotation.added"] == 1
    rv = call("review.open", title="from agent").json()["result"]
    assert rv["source_branch"] == branch["name"]
    co = call("checkout", ref=branch["name"]).json()["result"]
    assert len(co["annotations"]) == 1
    stale = call("commit", branch=branch["name"], expected_head=branch["commit_oid"], changes={"annotations": [ann("g2")]})
    assert stale.status_code == 409 and stale.json()["code"] == "stale_head"
    assert call("diff").status_code == 200  # defaults: main ← the caller's work branch
    missing = vc.post("/api/v1/commands", json={"tool": ns("versioning.diff"), "input": {}}, headers=h)
    assert missing.status_code == 422


def test_plugin_tools_still_resolve(client):
    r = client.post("/api/v1/commands", json={"tool": ns("nothing.here"), "input": {}}, headers=ws("ws-a"))
    assert r.status_code == 403 and "no active plugin" in r.text


# ---- Subscriptions ----------------------------------------------------------------------------


def test_subscription_claim_and_ack(vc):
    b = work(vc, ALICE)
    save(vc, ALICE, b, [ann("a1")])
    vc.post("/api/v1/datasets/ds/reviews", json={}, headers=ALICE)
    claim = lambda: vc.post("/api/v1/worker/subscriptions/claim", json={"subscriber": "deid", "types": ["versioning.review.opened"]}, headers=worker_headers()).json()["events"]  # noqa: E731
    evs = claim()
    assert len(evs) == 1 and evs[0]["workspaceId"] == "ws-a"
    assert claim() == evs  # unacked events come back
    vc.post("/api/v1/worker/subscriptions/ack", json={"subscriber": "deid", "eventIds": [evs[0]["eventId"]]}, headers=worker_headers())
    assert claim() == []
    assert vc.post("/api/v1/worker/subscriptions/claim", json={"subscriber": "deid", "types": ["x"]}).status_code == 401
    assert vc.post("/api/v1/worker/versioning/run", json={"workspaceId": "ws-a", "datasetId": "ds", "op": "merge"}, headers=worker_headers()).status_code == 403
