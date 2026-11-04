"""todo23 W9 (D11): reviews per artifact version; the builder never reviews its own work; hidden
tests stay out of the builder's reach; promotion needs a passing review."""

from __future__ import annotations

from studio_api import db
from studio_api.kernel import reviews

from .conftest import ws
from .test_artifacts import GEN, build, package, token
from .test_distribution import _org

PERSON = ws("ws-a", **{"X-Dev-Principal": "user:erin"})
ART = {"kind": "plugin", "id": GEN, "version": "0.1.0"}


def members(org: str, *who: str) -> None:
    from studio_api.models import OrganizationMember, now

    with db.session_scope() as s:
        for w in who:
            s.add(OrganizationMember(org_id=org, principal=w, role="member", created_at=now()))


def body(verdict="pass", **kw):
    return {"artifact": ART, "model": "anthropic:claude-sonnet-5-5", "verdict": verdict, "findings": [], **kw}


def test_reviewer_session_writes_reviews_and_hidden_tests_builder_cannot(client):
    assert build(client, package()).json()["registered"]
    reviewer = token(client, "ws-a", ["reviews.write", "reviews.read"], agent="reviewer")
    builder = token(client, "ws-a", ["plugins.read", "plugins.manage", "plugins.author", "reviews.write"])
    # The builder never reviews, even with the scope.
    assert client.post("/api/v1/projects/ws-a/reviews", json=body(), headers=builder).status_code == 403
    finding = {"severity": "blocker", "class": "hidden-network", "file": "ui/impl.ts", "line": 3, "claim": "fetch() to an outside host", "test": "hidden-tests/net.test.ts"}
    assert client.post("/api/v1/projects/ws-a/reviews", json=body(findings=[finding]), headers=reviewer).status_code == 422  # pass with a blocker
    r = client.post("/api/v1/projects/ws-a/reviews", json=body("block", findings=[finding]), headers=reviewer)
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["reviewer"] == "agent:reviewer" and doc["schema"] == "review.v1" and doc["findings"][0]["class"] == "hidden-network"
    with db.session_scope() as s:
        assert reviews.has_passing_review(s, ART) is False
    # Hidden tests: the reviewer writes and reads them; the builder does neither.
    t = {"artifact": ART, "path": "net.test.ts", "content": "test('no fetch', () => {})"}
    assert client.post("/api/v1/projects/ws-a/reviews/hidden-tests", json=t, headers=builder).status_code == 403
    assert client.post("/api/v1/projects/ws-a/reviews/hidden-tests", json={**t, "path": "../x"}, headers=reviewer).status_code == 422
    assert client.post("/api/v1/projects/ws-a/reviews/hidden-tests", json=t, headers=reviewer).status_code == 201
    q = {"artifact": f"plugin:{GEN}@0.1.0"}
    assert client.get("/api/v1/projects/ws-a/reviews/hidden-tests", params=q, headers=builder).status_code == 403
    assert len(client.get("/api/v1/projects/ws-a/reviews/hidden-tests", params=q, headers=reviewer).json()["tests"]) == 1
    # A later pass supersedes the block.
    assert client.post("/api/v1/projects/ws-a/reviews", json=body(), headers=reviewer).status_code == 201
    listed = client.get("/api/v1/projects/ws-a/reviews", params=q, headers=ws("ws-a")).json()
    assert listed["passing"] is True and [x["verdict"] for x in listed["reviews"]] == ["pass", "block"]
    with db.session_scope() as s:
        assert reviews.has_passing_review(s, ("plugin", GEN, "0.1.0"))
        assert not reviews.has_passing_review(s, ("plugin", GEN, "0.2.0"))


def test_the_author_cannot_review_their_own_artifact(client):
    _org(client, "org-1", "ws-a")
    members("org-1", "user:alice", "user:erin")
    alice = ws("ws-a", **{"X-Dev-Principal": "user:alice"})
    assert build(client, package(), headers=alice).json()["registered"]
    assert client.post("/api/v1/projects/ws-a/reviews", json=body(), headers=alice).status_code == 403
    # Kinds without a resolver: the claimed authors count.
    other = {**body(), "artifact": {"kind": "preview", "id": "p1", "version": "1"}, "authors": ["user:erin"]}
    assert client.post("/api/v1/projects/ws-a/reviews", json=other, headers=PERSON).status_code == 403
    assert client.post("/api/v1/projects/ws-a/reviews", json={**body(), "verdict": "maybe"}, headers=PERSON).status_code == 422
    assert client.get("/api/v1/projects/ws-a/reviews", params={"artifact": "nope"}, headers=PERSON).status_code == 422
