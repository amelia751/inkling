"""todo12 §4 M1 (todo12-kernel): the pipeline gateway routes against a stub pipeline HTTP
server, the api-signed JWT (kid `api`, audience `pipeline`), approvals bound to the candidate
digest and recorded in versioning (the in-memory fake), pipeline events on the project SSE
stream, and no pipeline routes for agents."""

from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from studio_api.kernel import pipeline_client, service_scope
from studio_api.kernel.versioning import client as vclient
from studio_api.kernel.versioning import service as vservice
from studio_api.kernel.versioning.fake import FakeVersioning

from .conftest import ws
from .test_versioning import ALICE, BOB, save, work

DIGEST = "sha256:" + "ab" * 32


class StubPipeline:
    """apps/pipeline's private API, enough of it: runs by id, a list, cancel, approvals."""

    def __init__(self) -> None:
        self.runs: dict[str, dict] = {}
        self.calls: list[tuple[str, str, dict, dict]] = []  # method, path, headers, body
        self.approvals: dict[str, dict] = {}
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _send(self, status: int, body) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _body(self) -> dict:
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n)) if n else {}

            def do_GET(self):
                u = urlsplit(self.path)
                stub.calls.append(("GET", u.path, dict(self.headers), {k: v[0] for k, v in parse_qs(u.query).items()}))
                if u.path == "/v1/runs":
                    q = parse_qs(u.query)
                    states = set((q.get("state") or [""])[0].split(",")) - {""}
                    rows = [r for r in stub.runs.values() if r["workspace_id"] == q["workspace_id"][0] and (not states or r["state"] in states)]
                    return self._send(200, {"runs": rows, "next_cursor": None})
                rid = u.path.rsplit("/", 1)[-1]
                return self._send(200, stub.runs[rid]) if rid in stub.runs else self._send(404, {"detail": "no such run"})

            def do_POST(self):
                u = urlsplit(self.path)
                body = self._body()
                stub.calls.append(("POST", u.path, dict(self.headers), body))
                if u.path == "/v1/runs":
                    rid = f"run-{len(stub.runs) + 1}"
                    stub.runs[rid] = {"run_id": rid, "workspace_id": body["workspace_id"], "project_id": body["project_id"], "definition_id": body["definition_id"], "state": "queued", "created_at": "2026-11-01T00:00:00Z", "steps": [], "items": []}
                    return self._send(201, stub.runs[rid])
                if u.path.endswith("/cancel"):
                    rid = u.path.split("/")[3]
                    stub.runs[rid]["state"] = "cancelled"
                    return self._send(200, stub.runs[rid])
                if u.path == "/v1/approvals":
                    prior = stub.approvals.setdefault(body["approval_id"], body)
                    stub.runs[body["run_id"]]["state"] = "publishing"
                    return self._send(202, {"approval_id": prior["approval_id"], "state": "publishing"})
                if u.path.endswith("/validate"):
                    return self._send(200, {"valid": True, "digest": "sha256:plan"})
                return self._send(404, {"detail": "no route"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture
def stub():
    s = StubPipeline()
    yield s
    s.close()
    pipeline_client.set_client(None)


@pytest.fixture
def fake():
    f = FakeVersioning()
    vclient.set_client(f)
    vservice.clear_cache()
    yield f
    vclient.set_client(None)
    vservice.clear_cache()


@pytest.fixture
def pc(make_client, stub, fake):
    c = make_client(pipeline_url=stub.url)
    pipeline_client.set_client(None)
    assert c.post("/api/v1/datasets", json={"id": "ds"}, headers=ALICE).status_code == 201
    return c


def candidate_run(c, stub: StubPipeline, run_id: str = "run-c") -> dict:
    """A run waiting for review: Bob's branch stands in for `pipeline/<run_id>` (the pipeline
    authors it through versioning directly), reviewed into main."""
    b = work(c, BOB)
    assert save(c, BOB, b, [{"id": "a1", "itemId": "img/a.png", "label": "x", "geometry": {"type": "box", "x": 1, "y": 2, "w": 3, "h": 4}, "provenance": "human-created", "author": "user:bob", "createdAt": "2026-11-01T00:00:00Z"}]).status_code == 201
    rv = c.post("/api/v1/datasets/ds/reviews", json={"title": "candidate"}, headers=BOB).json()
    run = {
        "run_id": run_id, "workspace_id": "ws-a", "project_id": "ws-a", "definition_id": "ingest", "state": "awaiting_review", "created_at": "2026-11-01T00:00:00Z",
        "steps": [{"step_id": "inspect", "state": "succeeded"}], "items": [],
        "candidate": {"dataset_id": "ds", "branch": b["name"], "commit": rv["source_oid"], "output_manifest_digest": DIGEST},
        "review": {"review_id": rv["id"], "status": rv["status"]},
    }
    stub.runs[run_id] = run
    return run


def claims_of(headers: dict) -> tuple[dict, dict, str]:
    tok = headers["Authorization"].split(" ", 1)[1]
    h, b, sig = tok.split(".")
    dec = lambda x: json.loads(base64.urlsafe_b64decode(x + "=" * (-len(x) % 4)))  # noqa: E731
    return dec(h), dec(b), tok


# ---- Calls and the JWT ----------------------------------------------------------------------------


def test_calls_carry_an_api_signed_jwt_the_pipeline_can_verify(pc, stub):
    r = pc.post("/api/v1/pipeline-runs", json={"project_id": "ws-a", "definition_id": "ingest"}, headers=ws("ws-a", **{"Idempotency-Key": "start-1"}))
    assert r.status_code == 202 and r.json()["state"] == "queued"
    method, path, headers, body = stub.calls[-1]
    assert (method, path, body["workspace_id"], body["actor"], body["idempotency_key"]) == ("POST", "/v1/runs", "ws-a", "user:local-expert", "start-1")
    assert {k.lower(): v for k, v in headers.items()}["idempotency-key"] == "start-1"
    header, claims, tok = claims_of({k.title(): v for k, v in headers.items()})
    assert header == {"alg": "EdDSA", "typ": "JWT", "kid": "api"}
    assert claims["aud"] == ["pipeline"] and claims["workspace_id"] == "ws-a" and claims["scopes"] == ["pipeline:run"]
    assert claims["exp"] - claims["iat"] == 60 and claims["actor"] == {"id": "user:local-expert", "kind": "user"}
    # Verifiable with the public JWKS the pipeline is given (PIPELINE_API_JWKS_FILE).
    jwks = json.loads(pipeline_client.jwks_path().read_text())
    (key,) = jwks["keys"]
    assert key["kid"] == "api" and key["alg"] == "EdDSA"
    pub = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(key["x"] + "=="))
    signing_input, sig = tok.rsplit(".", 1)
    pub.verify(base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4)), signing_input.encode())


def test_list_get_cancel_validate(pc, stub):
    for _ in range(2):
        pc.post("/api/v1/pipeline-runs", json={"definition_id": "ingest"}, headers=ws("ws-a"))
    stub.runs["other"] = {"run_id": "other", "workspace_id": "ws-b", "project_id": "ws-b", "state": "running"}
    page = pc.get("/api/v1/projects/ws-a/pipeline-runs?state=queued,running", headers=ws("ws-a")).json()
    assert [r["run_id"] for r in page["runs"]] == ["run-1", "run-2"] and "next_cursor" not in page
    assert stub.calls[-1][3] == {"workspace_id": "ws-a", "project_id": "ws-a", "state": "queued,running"}
    assert pc.get("/api/v1/projects/ws-a/pipeline-runs?state=bogus", headers=ws("ws-a")).status_code == 422
    assert pc.get("/api/v1/pipeline-runs/run-1", headers=ws("ws-a")).json()["state"] == "queued"
    assert pc.get("/api/v1/pipeline-runs/other", headers=ws("ws-a")).status_code == 404  # another workspace's run
    assert pc.get("/api/v1/pipeline-runs/nope", headers=ws("ws-a")).status_code == 404
    assert pc.post("/api/v1/pipeline-runs/run-1/cancel", headers=ws("ws-a")).json()["state"] == "cancelled"
    assert pc.post("/api/v1/pipelines/ingest/validate", json={}, headers=ws("ws-a")).json()["valid"] is True


def test_unconfigured_or_unreachable_pipeline(make_client, stub):
    c = make_client()
    pipeline_client.set_client(None)
    assert c.get("/api/v1/pipeline-runs/x", headers=ws("ws-a")).status_code == 503
    stub.close()
    c = make_client(pipeline_url=stub.url)
    pipeline_client.set_client(None)
    assert c.get("/api/v1/pipeline-runs/x", headers=ws("ws-a")).status_code == 503


# ---- Approvals -----------------------------------------------------------------------------------


def test_approve_records_in_versioning_then_starts_publish_once(pc, stub, fake):
    run = candidate_run(pc, stub)
    got = pc.get("/api/v1/pipeline-runs/run-c", headers=ALICE).json()
    assert got["review"]["can_approve"] is True
    r = pc.post("/api/v1/pipeline-runs/run-c/approve", json={"candidate_digest": DIGEST}, headers={**ALICE, "Idempotency-Key": "k"})
    assert r.status_code == 200, r.text
    aid = r.json()["approval_id"]
    assert r.json()["state"] == "publishing"
    # The approval id is versioning's, bound to the candidate digest and the target it was checked against.
    (approval,) = pc.get(f"/api/v1/datasets/ds/reviews/{run['review']['review_id']}", headers=ALICE).json()["approvals"]
    assert approval["id"] == aid and approval["candidate_digest"] == DIGEST and approval["approved_target_oid"]
    rv = pc.get(f"/api/v1/datasets/ds/reviews/{run['review']['review_id']}", headers=ALICE).json()
    assert [a["reviewer_id"] for a in rv["approvals"]] == ["user:alice"] and rv["approvals"][0]["approved_source_oid"] == run["candidate"]["commit"]
    posts = [b for m, p, _, b in stub.calls if p == "/v1/approvals"]
    assert posts == [{"run_id": "run-c", "approval_id": aid, "candidate_digest": DIGEST}]
    _, claims, _ = claims_of({k.title(): v for k, v in next(h for m, p, h, _ in stub.calls if p == "/v1/approvals").items()})
    assert claims["scopes"] == ["pipeline:approve"] and claims["sub"] == "user:alice"
    # Again (a double click, a retry, another reviewer): the same approval id, no second publish.
    again = pc.post("/api/v1/pipeline-runs/run-c/approve", json={"candidate_digest": DIGEST}, headers=BOB)
    assert again.status_code == 200 and again.json()["approval_id"] == aid
    assert len([1 for m, p, _, _ in stub.calls if p == "/v1/approvals"]) == 1


def test_a_stale_digest_is_a_409_and_records_nothing(pc, stub):
    candidate_run(pc, stub)
    r = pc.post("/api/v1/pipeline-runs/run-c/approve", json={"candidate_digest": "sha256:old"}, headers=ALICE)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "stale_candidate"
    assert not [1 for m, p, _, _ in stub.calls if p == "/v1/approvals"]


def test_the_candidates_author_cannot_approve(pc, stub):
    candidate_run(pc, stub)  # Bob opened the review
    r = pc.post("/api/v1/pipeline-runs/run-c/approve", json={"candidate_digest": DIGEST}, headers=BOB)
    assert r.status_code == 403
    assert not [1 for m, p, _, _ in stub.calls if p == "/v1/approvals"]


def test_approve_needs_a_run_awaiting_review(pc, stub):
    run = candidate_run(pc, stub)
    run["state"] = "running"
    assert pc.get("/api/v1/pipeline-runs/run-c", headers=ALICE).json()["review"]["can_approve"] is False
    assert pc.post("/api/v1/pipeline-runs/run-c/approve", json={"candidate_digest": DIGEST}, headers=ALICE).status_code == 409
    assert pc.post("/api/v1/pipeline-runs/run-c/approve", json={}, headers=ALICE).status_code == 422


# ---- Agents and the service principal ------------------------------------------------------------


def test_agents_get_no_pipeline_routes(pc, stub):
    candidate_run(pc, stub)
    r = pc.post("/api/v1/sessions", json={"agent": "proposer", "scopes": ["pipelines.read", "pipelines.run", "pipelines.approve", "versioning.approve"]}, headers=ALICE)
    agent = {"Authorization": f"Bearer {r.json()['token']}"}
    for method, path in [("GET", "/api/v1/projects/ws-a/pipeline-runs"), ("POST", "/api/v1/pipeline-runs"), ("GET", "/api/v1/pipeline-runs/run-c"), ("POST", "/api/v1/pipeline-runs/run-c/approve"), ("POST", "/api/v1/pipeline-runs/run-c/cancel"), ("POST", "/api/v1/pipelines/ingest/validate"), ("GET", "/api/v1/pipeline-runs/run-c/events")]:
        assert pc.request(method, path, headers=agent, json={"candidate_digest": DIGEST}).status_code == 403, (method, path)
    svc = {"Authorization": f"Bearer {service_scope.pipeline_token()}"}
    assert pc.get("/api/v1/pipeline-runs/run-c", headers=svc).status_code == 403


# ---- Events --------------------------------------------------------------------------------------


def test_pipeline_events_reach_the_project_stream(pc, stub):
    stub.runs["run-1"] = {"run_id": "run-1", "workspace_id": "ws-a", "project_id": "ws-a", "state": "running"}
    svc = {"Authorization": f"Bearer {service_scope.pipeline_token()}"}
    body = {"workspace_id": "ws-a", "type": "pipeline.run.started", "payload": {"project_id": "ws-a", "run_id": "run-1", "state": "running"}, "idempotency_key": "run-1/pipeline.run.started", "depth": 1}
    r = pc.post("/api/v1/service/events", json=body, headers=svc)
    assert r.status_code == 200 and r.json()["replayed"] is False
    assert pc.post("/api/v1/service/events", json=body, headers=svc).json() == {"event_id": r.json()["event_id"], "replayed": True}
    review = {**body, "type": "review.requested", "payload": {"project_id": "ws-a", "run_id": "run-1", "review_id": "rv"}, "idempotency_key": "run-1/review.requested"}
    assert pc.post("/api/v1/service/events", json=review, headers=svc).status_code == 200
    feed = pc.get("/api/v1/service/events?wait=0&types=pipeline.run.started,review.requested", headers=svc).json()["events"]
    assert [e["source"] for e in feed] == ["pipeline", "pipeline"] and feed[0]["depth"] == 1
    with pc.stream("GET", "/api/v1/projects/ws-a/events?after=0", headers=ws("ws-a")) as s:
        seen = []
        for line in s.iter_lines():
            if line.startswith("event: "):
                seen.append(line[7:])
            if len(seen) >= 2:
                break
    assert seen == ["pipeline.run.started", "review.requested"]
    with pc.stream("GET", "/api/v1/pipeline-runs/run-1/events", headers=ws("ws-a")) as s:
        datas = []
        for line in s.iter_lines():
            if line.startswith("data: "):
                datas.append(json.loads(line[6:]))
            if len(datas) >= 2:
                break
    assert [d["run_id"] for d in datas] == ["run-1", "run-1"]
