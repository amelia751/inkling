"""todo16 D8: the api checks the agent's signed destroy approval: signature, person, operation,
project, targets, expiry and single use."""

from __future__ import annotations

import time

import pytest

from studio_api import db as kdb
from studio_api.context import hash_token, issue_session
from studio_api.kernel import approvals

from .conftest import png
from .test_files import ALICE, _by_name, _new

BOB = "user:bob"


def _agent(p: str, person: str = ALICE) -> tuple[str, dict]:
    with kdb.session_scope() as db:
        token = issue_session(db, "agent:run_9", p, ["proposals.write", "project.write"], on_behalf_of=person)
    return token, {"Authorization": f"Bearer {token}"}


def _approval(token: str, p: str, op: str = "source.purge", tgt: list[str] | None = None, aid: str = "appr_1", exp: float | None = None, **extra) -> str:
    return approvals.sign({"aid": aid, "dlg": hash_token(token), "sub": ALICE, "op": op, "pid": p, "tgt": tgt or [], "exp": int(exp if exp is not None else time.time() + 300), **extra})


def _purge(client, p: str, node: str, headers: dict):
    return client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "purge", "nodeIds": [node]}]}, headers=headers)


@pytest.fixture
def trashed(client):
    p, _, _ = _new(client, {"study/a.png": png(4, 4)})
    n = _by_name(p)["a.png"].id
    assert client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "trash", "nodeIds": [n]}]}).status_code == 200
    return p, n


def test_valid_approval_purges_once(client, trashed):
    p, n = trashed
    token, h = _agent(p)
    ok = _approval(token, p, tgt=[n])
    r = _purge(client, p, n, {**h, "X-Approval-Id": ok})
    assert r.status_code == 200, r.text


def test_missing_or_forged_approval_is_refused(client, trashed):
    p, n = trashed
    token, h = _agent(p)
    assert _purge(client, p, n, h).status_code == 403
    assert _purge(client, p, n, {**h, "X-Approval-Id": "appr_1"}).status_code == 403
    forged = approvals.sign({"aid": "x", "dlg": hash_token(token), "op": "source.purge", "pid": p, "tgt": [n], "exp": int(time.time()) + 60}, secret="wrong")
    assert _purge(client, p, n, {**h, "X-Approval-Id": forged}).status_code == 403


def test_wrong_person_is_refused(client, trashed):
    p, n = trashed
    token, _ = _agent(p)
    _, other = _agent(p)  # another delegation (another chat, another person's token)
    r = _purge(client, p, n, {**other, "X-Approval-Id": _approval(token, p, tgt=[n])})
    assert r.status_code == 403 and "someone else" in r.json()["detail"]
    tok2, h2 = _agent(p)
    r = _purge(client, p, n, {**h2, "X-Approval-Id": _approval(tok2, p, tgt=[n], sub=BOB)})
    assert r.status_code == 403 and "someone else" in r.json()["detail"]


def test_wrong_operation_project_or_target_is_refused(client, trashed):
    p, n = trashed
    token, h = _agent(p)
    r = _purge(client, p, n, {**h, "X-Approval-Id": _approval(token, p, op="trash.empty", tgt=[n])})
    assert r.status_code == 403 and "another operation" in r.json()["detail"]
    r = _purge(client, p, n, {**h, "X-Approval-Id": _approval(token, "other-project", tgt=[n])})
    assert r.status_code == 403 and "another project" in r.json()["detail"]
    r = _purge(client, p, n, {**h, "X-Approval-Id": _approval(token, p, tgt=["someone-else"])})
    assert r.status_code == 403 and "other items" in r.json()["detail"]


def test_expired_approval_is_refused(client, trashed):
    p, n = trashed
    token, h = _agent(p)
    r = _purge(client, p, n, {**h, "X-Approval-Id": _approval(token, p, tgt=[n], exp=time.time() - 5)})
    assert r.status_code == 403 and "expired" in r.json()["detail"]
    r = _purge(client, p, n, {**h, "X-Approval-Id": _approval(token, p, tgt=[n], exp=time.time() + 3600)})
    assert r.status_code == 403 and "expired" in r.json()["detail"]


def test_reused_approval_is_refused(client, trashed):
    p, n = trashed
    token, h = _agent(p)
    ok = _approval(token, p, op="trash.empty")
    assert client.post(f"/api/v1/projects/{p}/trash/empty", headers={**h, "X-Approval-Id": ok}).status_code == 200
    r = client.post(f"/api/v1/projects/{p}/trash/empty", headers={**h, "X-Approval-Id": ok})
    assert r.status_code == 403 and "already used" in r.json()["detail"]


def test_people_need_no_approval(client, trashed):
    p, n = trashed
    assert client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "purge", "nodeIds": [n]}]}).status_code == 200


def test_an_approval_used_by_a_concurrent_request_is_refused_not_a_500(client, trashed, monkeypatch):
    """todo18 B: two requests racing with one approval. The use is recorded by INSERT … ON
    CONFLICT DO NOTHING, so the second one gets 403 "already used" even when both passed any
    read-before-write check (here: the ledger row lands between the checks and the write)."""
    from fastapi import HTTPException
    from sqlalchemy.orm import Session

    from studio_api.context import RequestContext
    from studio_api.models import ApprovalUsed

    p, _ = trashed
    token, _h = _agent(p)
    ok = _approval(token, p, op="trash.empty", aid="appr_race")
    ctx = RequestContext(p, "agent:run_9", "c1", scopes=("project.write",), on_behalf_of=ALICE, token_hash=hash_token(token), approval_id=ok)
    with kdb.session_scope() as db:
        approvals.verify(db, ctx, operation="trash.empty", project_id=p)
    real_get = Session.get
    monkeypatch.setattr(Session, "get", lambda self, model, ident, **kw: None if model is ApprovalUsed else real_get(self, model, ident, **kw))
    with kdb.session_scope() as db:
        with pytest.raises(HTTPException) as e:
            approvals.verify(db, ctx, operation="trash.empty", project_id=p)
    assert e.value.status_code == 403 and "already used" in str(e.value.detail)
