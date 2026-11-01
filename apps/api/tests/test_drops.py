"""todo13-drops (Milestone 1): drops, chat imports, name screening and the agent serializer."""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
import io

import pytest
from sqlalchemy import select

from studio_api import db as kdb
from studio_api.kernel import agent_scope, name_screen
from studio_api.models import Drop, OrganizationMember, PluginEvent, ProjectRow, Source, SourceNode
from studio_api.routes.worker import worker_token

from .conftest import png

W = lambda: {"X-Worker-Token": worker_token()}  # noqa: E731
ALICE = "user:local-expert"
SMITH = "Smith_John_1962-04-03.dcm"


def _files(files: dict[str, bytes]) -> list[dict]:
    return [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]


def _project(client, title: str = "Drops") -> str:
    return client.post("/api/v1/projects", json={"title": title}).json()["id"]


def _drop(client, pid: str, files: dict[str, bytes], conv: str = "conv-1", title: str = "Chest X-rays", complete: bool = True, headers: dict | None = None) -> tuple[dict, dict]:
    d = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": conv, "conversationTitle": title, "messageId": "msg-1", "files": len(files), "bytes": sum(map(len, files.values()))}, headers=headers or {})
    assert d.status_code == 201, d.text
    drop = d.json()
    s = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files(files), "origin": {"kind": "chat", "conversationId": conv, "messageId": "msg-1", "dropId": drop["id"]}}, headers=headers or {})
    assert s.status_code == 201, s.text
    imp = s.json()
    assert imp["dropId"] == drop["id"]
    for f in imp["files"]:
        if f["uploadUrl"]:
            data = next(v for k, v in files.items() if k.endswith(f["relPath"]))
            assert client.put(f["uploadUrl"], content=data, headers=headers or {}).json()["state"] == "uploaded"
    if complete:
        imp = client.post(f"/api/v1/imports/{imp['id']}/complete", headers=headers or {}).json()
    return drop, imp


def _report(client, imp: dict, kinds: dict[str, str], facts: dict | None = None) -> None:
    files = client.get(f"/api/v1/worker/inspect/imports/{imp['id']}", headers=W()).json()["files"]
    nodes = [{"nodeId": f["nodeId"], "detectedKind": kinds.get(f["name"], "unknown"), "facts": (facts or {}).get(f["name"], {})} for f in files]
    r = client.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json={"inspector": "test", "nodes": nodes}, headers=W())
    assert r.status_code == 200, r.text


def _agent(pid: str, run: str = "run_1") -> dict:
    from studio_api.context import issue_session

    with kdb.session_scope() as db:
        token = issue_session(db, f"agent:{run}", pid, ["proposals.write"], on_behalf_of=ALICE)
    return {"Authorization": f"Bearer {token}"}


def _events(pid: str, prefix: str = "drop.") -> list[tuple[str, dict]]:
    with kdb.session_scope() as db:
        return [(e.type, e.payload) for e in db.scalars(select(PluginEvent).where(PluginEvent.workspace_id == pid, PluginEvent.type.like(f"{prefix}%")).order_by(PluginEvent.created_at))]


# ---- Drops land in Shared in chat ------------------------------------------------------------


def test_a_chat_drop_lands_in_shared_in_chat_and_reports_its_files(client):
    pid = _project(client)
    files = {f"xray_{i:02d}.png": png(8 + i, 8) for i in range(12)}
    drop, imp = _drop(client, pid, files)
    assert drop["state"] == "uploading" and drop["origin"] == "chat"
    # Files: `Shared in chat/<conversation>`, provenance a chat source.
    root = client.get(f"/api/v1/projects/{pid}/fs").json()["rootNodeId"]
    top = client.get(f"/api/v1/projects/{pid}/fs/children", params={"node": root}).json()["items"]
    # One conversation so far: the listing compacts `Shared in chat / Chest X-rays` into one row.
    conv = next(i for i in top if i.get("displayPath") == "Shared in chat / Chest X-rays")
    shared = {"id": client.get(f"/api/v1/source-nodes/{conv['id']}").json()["parentId"]}
    with kdb.session_scope() as db:
        inside = [n.name for n in db.scalars(select(SourceNode).where(SourceNode.parent_id == conv["id"]))]
    assert sorted(inside) == sorted(files)
    with kdb.session_scope() as db:
        assert {s.kind for s in db.scalars(select(Source).where(Source.project_id == pid))} == {"chat"}
    # The drop: live states, then inspection.
    got = client.get(f"/api/v1/drops/{drop['id']}").json()
    assert got["state"] == "inspecting" and {f["state"] for f in got["files"]} == {"checking"} and len(got["files"]) == 12
    _report(client, imp, {n: "image" for n in files}, {n: {"width": 8, "height": 8} for n in files})
    got = client.get(f"/api/v1/drops/{drop['id']}").json()
    assert {f["state"] for f in got["files"]} == {"ready"}
    assert got["summary"]["byKind"] == {"image": 12} and got["summary"]["groups"][0]["kind"] == "image"
    kinds = [t for t, _ in _events(pid)]
    assert kinds[0] == "drop.received" and kinds.count("drop.file") == 24
    # The inspector: "Shared in chat · <conversation> · <date>".
    node = got["files"][0]["nodeId"]
    prov = client.get(f"/api/v1/source-nodes/{node}").json()["provenance"]
    assert prov["sourceKind"] == "chat" and prov["drop"]["conversationTitle"] == "Chest X-rays" and prov["drop"]["sharedAt"]
    # A second drop in the same conversation lands in the same folder; Shared files lists both.
    d2, _ = _drop(client, pid, {"more.png": png(3, 3)})
    assert d2["id"] != drop["id"]
    listed = client.get(f"/api/v1/projects/{pid}/drops", params={"conversationId": "conv-1"}).json()["drops"]
    assert [d["id"] for d in listed] == [d2["id"], drop["id"]]
    assert len(client.get(f"/api/v1/projects/{pid}/fs/children", params={"node": shared["id"]}).json()["items"]) == 1


def test_a_chat_origin_without_a_drop_makes_one_and_duplicates_link(client):
    pid = _project(client)
    img = png(5, 5)
    s = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({"a.png": img}), "origin": {"kind": "chat", "conversationId": "c9", "messageId": "m1"}}).json()
    assert s["dropId"].startswith("drp-")
    client.put(s["files"][0]["uploadUrl"], content=img)
    client.post(f"/api/v1/imports/{s['id']}/complete")
    # The same bytes again in another drop: "Already in Files", no upload.
    d, imp = _drop(client, pid, {"copy.png": img}, conv="c9")
    f = client.get(f"/api/v1/drops/{d['id']}").json()["files"][0]
    assert f["reason"] == "Already in Files" and imp["files"][0]["received"] == len(img)


# ---- Name screening and the agent's view (D3, D13) ------------------------------------------


def test_an_identifier_like_name_reaches_the_agent_screened(client):
    pid = _project(client)
    drop, imp = _drop(client, pid, {SMITH: b"DICM-ish", "chest_01.png": png(4, 4)}, title="Smith John")
    _report(client, imp, {SMITH: "dicom", "chest_01.png": "image"}, {SMITH: {"modality": "CT", "rows": 4, "patientName": "SMITH^JOHN"}})
    agent = _agent(pid)
    summary = client.get(f"/api/v1/drops/{drop['id']}", headers=agent).json()
    names = {f["agentName"] for f in summary["files"]}
    assert names == {"dicom-0001.dcm", "chest_01.png"}, summary
    dicom = next(f for f in summary["files"] if f["kind"] == "dicom")
    assert dicom["facts"] == {"modality": "CT", "rows": 4}  # technical facts only
    assert "Smith" not in json.dumps(summary) and "SMITH" not in json.dumps(summary)
    # The person sees the real name.
    assert SMITH in json.dumps(client.get(f"/api/v1/drops/{drop['id']}").json())
    # describe_source_node returns the screened name, and the path too.
    detail = client.get(f"/api/v1/source-nodes/{dicom['nodeId']}", headers=agent).json()
    assert detail["name"] == "dicom-0001.dcm" and "Smith" not in json.dumps(detail)
    # A rename forgets the screening; the new name is screened again.
    with kdb.session_scope() as db:
        n = db.get(SourceNode, dicom["nodeId"])
        n.name = "case_7.dcm"
        assert n.agent_name is None and n.name_flagged is None
    assert client.get(f"/api/v1/source-nodes/{dicom['nodeId']}", headers=agent).json()["name"] == "case_7.dcm"


def _fill(route: str, ids: dict[str, str]) -> str | None:
    def sub(m: re.Match) -> str:
        return ids.get(m.group(1), "x")

    return re.sub(r"\{([a-z_]+)(?::path)?\}", sub, route)


def test_no_agent_route_returns_an_unscreened_name(client):
    """The D13 walk: an identifier-like name in a fixture project appears in no agent response."""
    pid = _project(client, "Walk")
    files = {f"Doe_Jane_2001-02-03/{SMITH}": b"DICM1", "Doe_Jane_2001-02-03/scan_0001.png": png(4, 4), "notes/Smith_John_mrn_12345678.pdf": b"%PDF-1.4"}
    imp = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files(files)}).json()
    for f in imp["files"]:
        client.put(f["uploadUrl"], content=next(v for k, v in files.items() if k.endswith(f["relPath"])))
    client.post(f"/api/v1/imports/{imp['id']}/complete")
    _report(client, imp, {SMITH: "dicom", "scan_0001.png": "image", "Smith_John_mrn_12345678.pdf": "document"})
    drop, _ = _drop(client, pid, {"Smith_Jane.png": png(6, 6)})
    with kdb.session_scope() as db:
        nodes = {n.name: n.id for n in db.scalars(select(SourceNode).where(SourceNode.project_id == pid))}
        source_id = db.scalar(select(Source.id).where(Source.project_id == pid))
    ids = {"project_id": pid, "node_id": nodes[SMITH], "source_id": source_id, "drop_id": drop["id"], "dataset_id": "x", "workspace_id": pid, "task_id": "x", "boot_id": "x", "proposal_id": "x", "plugin_id": "x", "fixture_set_id": "x", "name": "x", "job_id": "x", "oid": "x", "review_id": "x", "request_id": "x", "rest": "x"}
    agent = _agent(pid)
    checked = 0
    for method, route in sorted(agent_scope.AGENT_ROUTES):
        url = _fill(route, ids)
        params = {"node": nodes["Doe_Jane_2001-02-03"]} if route.endswith(("fs/children", "/children")) else {"q": "Smith"} if route.endswith("/search") else {}
        r = client.request(method, url, params=params, json={} if method != "GET" else None, headers=agent)
        assert r.status_code != 403 or "data boundary" not in r.text, (method, route)
        body = r.text
        for needle in ("Smith", "SMITH", "Doe_Jane", "1962-04-03", "12345678"):
            assert needle not in body, (method, route, r.status_code, body[:500])
        checked += 1
    assert checked == len(agent_scope.AGENT_ROUTES)
    # Listing the folder of the flagged folder: a screened folder name, real clean file names.
    folder = client.get(f"/api/v1/source-nodes/{nodes['Doe_Jane_2001-02-03']}", headers=agent).json()
    assert re.fullmatch(r"folder-\d{4}", folder["name"]), folder["name"]
    # People still see everything.
    assert client.get(f"/api/v1/source-nodes/{nodes['Doe_Jane_2001-02-03']}").json()["name"] == "Doe_Jane_2001-02-03"


def test_unscreened_names_fail_closed_and_the_backfill_resumes(make_client, monkeypatch):
    client = make_client(name_screen_mode="dlp")
    pid = _project(client)

    def boom(names):
        raise RuntimeError("no credentials")

    monkeypatch.setattr(name_screen, "_dlp_flags", boom)
    monkeypatch.setattr(name_screen, "screen_pending", lambda db, project_id, max_calls=None: 0)  # nothing screened live
    imp = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({"plain.png": png(3, 3)})}).json()
    client.put(imp["files"][0]["uploadUrl"], content=png(3, 3))
    client.post(f"/api/v1/imports/{imp['id']}/complete")
    agent = _agent(pid)
    with kdb.session_scope() as db:
        nid = db.scalar(select(SourceNode.id).where(SourceNode.project_id == pid, SourceNode.name == "plain.png"))
    # Not screened yet: `file-<n>.png`.
    assert re.fullmatch(r"file-\d+\.png", client.get(f"/api/v1/source-nodes/{nid}", headers=agent).json()["name"])
    # The backfill runs; the API errors, so the batch is flagged (fail closed).
    r = client.post("/api/v1/worker/scheduled/files.screen_names", json={"budgetS": 5}, headers=W()).json()
    assert r["result"]["screened"] >= 2 and r["result"]["remaining"] == 0
    assert client.get(f"/api/v1/source-nodes/{nid}", headers=agent).json()["name"] == "image-0001.png"
    # With the API answering, a clean name is itself.
    monkeypatch.setattr(name_screen, "_dlp_flags", lambda names: [False] * len(names))
    with kdb.session_scope() as db:
        for n in db.scalars(select(SourceNode).where(SourceNode.project_id == pid)):
            n.agent_name, n.name_flagged = None, None
    with kdb.session_scope() as db:
        out = name_screen.backfill(db, project_id=pid)
    assert out["remaining"] == 0
    assert client.get(f"/api/v1/source-nodes/{nid}", headers=agent).json()["name"] == "plain.png"


def test_the_dlp_call_maps_findings_to_rows(make_client, monkeypatch):
    make_client(name_screen_mode="dlp", name_screen_project="phi-proj", name_screen_qps=0)
    sent = {}

    class Creds:
        token = "t"

        def refresh(self, req):
            pass

    import google.auth
    import httpx

    monkeypatch.setattr(google.auth, "default", lambda scopes=None: (Creds(), "other"))

    def post(url, json=None, headers=None, timeout=None):
        sent.update(url=url, body=json)
        return httpx.Response(200, json={"result": {"findings": [{"location": {"contentLocations": [{"recordLocation": {"tableLocation": {"rowIndex": "1"}}}]}}]}}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", post)
    assert name_screen.screen(["scan_01.png", "Jane Roe.png", "Smith_John.png"]) == [False, True, True]
    assert sent["url"].endswith("/projects/phi-proj/locations/us-central1/content:inspect")
    assert sent["body"]["item"]["table"]["rows"][2] == {"values": [{"stringValue": "Smith John.png"}]}
    assert {"name": "PERSON_NAME"} in sent["body"]["inspectConfig"]["infoTypes"]


def test_production_refuses_unscreened_names(monkeypatch, tmp_path):
    from studio_api import config

    with pytest.raises(config.SettingsError) as e:
        config.load_settings(env="production", database_url="sqlite://", secret_key="k", worker_token="w", name_screen_mode="off", data_dir=tmp_path)
    assert "API_NAME_SCREEN_MODE" in str(e.value)
    assert config.load_settings(env="production", database_url="sqlite://", secret_key="k", worker_token="w", data_dir=tmp_path).screen_mode == "dlp"


# ---- Who may drop, limits, flags (D14, §7) ----------------------------------------------------


def test_viewers_cannot_drop(client):
    pid = _project(client)
    with kdb.session_scope() as db:
        p = db.get(ProjectRow, pid)
        db.add(OrganizationMember(org_id=p.org_id, principal="user:viewer", role="viewer"))
    viewer = {"X-Dev-Principal": "user:viewer"}
    assert client.get(f"/api/v1/projects/{pid}", headers=viewer).json()["role"] == "viewer"
    assert client.get(f"/api/v1/projects/{pid}").json()["role"] == "owner"
    assert client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c"}, headers=viewer).status_code == 403
    r = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({"a.png": b"x"}), "origin": {"kind": "chat", "conversationId": "c"}}, headers=viewer)
    assert r.status_code == 403
    # An agent can't start a drop either.
    assert client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c"}, headers=_agent(pid)).status_code == 403


def test_limits_and_rate_limit(make_client):
    client = make_client(drop_max_files=3, drop_max_bytes=1000, drop_rate_per_minute=2)
    pid = _project(client)
    r = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c", "files": 4})
    assert r.status_code == 413 and "Files" in r.json()["detail"]
    assert client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c", "bytes": 2000}).status_code == 413
    d = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c", "files": 1}).json()
    # The actual files count too: 4 files in one session is over the drop's limit.
    r = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({f"{i}.png": b"x" for i in range(4)}), "dropId": d["id"]})
    assert r.status_code == 413
    # The same id again is the same drop (a retry), not a new one.
    again = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c", "id": d["id"]})
    assert again.status_code == 201 and again.json()["id"] == d["id"]
    client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c"})
    r = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c"})
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1


def test_the_flag_off_hides_every_drop_route(make_client):
    client = make_client(feature_chat_drops=False)
    pid = _project(client)
    assert client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "c"}).status_code == 404
    assert client.get(f"/api/v1/projects/{pid}/drops").status_code == 404
    assert client.get("/api/v1/drops/drp-0123456789abcdef").status_code == 404
    assert client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({"a.png": b"x"}), "origin": {"kind": "chat", "conversationId": "c"}}).status_code == 404
    # Plain imports work as before.
    assert client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({"a.png": b"x"})}).status_code == 201


def test_a_spoofed_type_is_classified_by_what_it_is(client):
    pid = _project(client)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("inner.txt", "hi")
    drop, imp = _drop(client, pid, {"photo.png": buf.getvalue()})
    _report(client, imp, {"photo.png": "archive"})
    f = client.get(f"/api/v1/drops/{drop['id']}").json()["files"][0]
    assert f["kind"] == "archive" and f["looksLike"] == "a ZIP" and f["state"] == "kept"


# ---- Lifecycle (D4, D15) ------------------------------------------------------------------------


def test_removing_from_chat_keeps_the_file_and_deleting_shows_deleted(client):
    pid = _project(client)
    drop, imp = _drop(client, pid, {"a.png": png(4, 4), "b.png": png(5, 5)})
    a, b = (f["nodeId"] for f in client.get(f"/api/v1/drops/{drop['id']}").json()["files"])
    r = client.delete(f"/api/v1/drops/{drop['id']}/files/{a}")
    assert r.status_code == 200 and next(f for f in r.json()["files"] if f["nodeId"] == a)["state"] == "removed"
    assert client.get(f"/api/v1/source-nodes/{a}").json()["trash"] is None  # still in Files
    assert client.get(f"/api/v1/source-nodes/{a}").json()["provenance"]["drop"]["removedFromChat"] is True
    assert client.get(f"/api/v1/drops/{drop['id']}", headers=_agent(pid)).json()["total"] == 1
    # Deleting the File (to Trash) turns its chip into "Deleted file".
    assert client.post(f"/api/v1/projects/{pid}/fs/ops", json={"ops": [{"kind": "trash", "nodeIds": [b]}]}).status_code == 200
    assert next(f for f in client.get(f"/api/v1/drops/{drop['id']}").json()["files"] if f["nodeId"] == b)["state"] == "deleted"
    assert ("drop.file", {"projectId": pid, "dropId": drop["id"], "nodeId": a, "state": "removed"}) in _events(pid)


def test_deleting_a_conversation_keeps_its_folder_renamed(client):
    pid = _project(client)
    drop, _ = _drop(client, pid, {"a.png": png(4, 4)}, conv="conv-x", title="Knee MRI")
    r = client.post(f"/api/v1/projects/{pid}/conversations/conv-x/deleted").json()
    assert r["drops"] == 1 and len(r["renamedFolders"]) == 1
    with kdb.session_scope() as db:
        folder = db.get(SourceNode, db.get(Drop, drop["id"]).folder_node_id)
        assert folder.name == "Knee MRI (deleted chat)" and folder.trashed_at is None
        assert db.get(Drop, drop["id"]).message_id is None


# ---- Integration (todo13 Milestone 4) ------------------------------------------------------


def test_a_home_drop_in_a_conversation_lands_in_shared_in_chat(client):
    """D1 + D2: Home's drop is delivered into the new project's conversation."""
    pid = _project(client)
    d = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "home", "conversationId": "conv-h", "messageId": "msg-h", "files": 1, "bytes": 10})
    assert d.status_code == 201, d.text
    files = {"a.png": png(9, 9)}
    s = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files(files), "origin": {"kind": "home", "conversationId": "conv-h", "messageId": "msg-h", "dropId": d.json()["id"]}})
    assert s.status_code == 201, s.text
    root = client.get(f"/api/v1/projects/{pid}/fs").json()["rootNodeId"]
    top = client.get(f"/api/v1/projects/{pid}/fs/children?node={root}").json()["items"]
    assert any((i.get("displayPath") or i["name"]).startswith("Shared in chat") for i in top), top
    with kdb.session_scope() as db:
        assert {s.kind for s in db.scalars(select(Source).where(Source.project_id == pid))} == {"chat"}


def _json_lines(caplog, prefix: str = "drop.") -> list[dict]:
    return [{"msg": r.getMessage(), **{k: v for k, v in r.__dict__.items() if k in ("event", "dropId", "state", "elapsed_ms", "origin", "byKind", "step", "errorClass", "auto", "stuck_ms")}} for r in caplog.records if r.getMessage().startswith(prefix)]


def test_every_drop_transition_logs_one_line_without_names(client, caplog):
    """§7.3: one JSON line per drop.* transition, with dropId, state, elapsed since received,
    origin and counts by kind; never a file name."""
    caplog.set_level("INFO")
    pid = _project(client)
    files = {SMITH: b"DICM" + b"\0" * 40, "xray_01.png": png(8, 8)}
    drop, imp = _drop(client, pid, files)
    _report(client, imp, {SMITH: "dicom", "xray_01.png": "image"})
    lines = _json_lines(caplog)
    names = [x["msg"] for x in lines if x.get("dropId") == drop["id"]]
    for step in ("drop.received", "drop.uploaded", "drop.inspected", "drop.classified", "drop.planned"):
        assert step in names, names
    assert all(x.get("event") == x["msg"] and x.get("elapsed_ms") is not None for x in lines if x.get("dropId") == drop["id"])
    classified = next(x for x in lines if x["msg"] == "drop.classified")
    assert sum(classified["byKind"].values()) == 2 and classified["origin"] == "chat"
    text = "\n".join(r.getMessage() + json.dumps({k: str(v) for k, v in r.__dict__.items()}) for r in caplog.records if r.name.startswith("studio_api.drops"))
    assert "Smith" not in text and "xray_01" not in text


def test_a_drop_stuck_inspecting_is_logged(client, caplog):
    from datetime import timedelta

    from studio_api.kernel import drops
    from studio_api.models import now

    caplog.set_level("INFO")
    pid = _project(client)
    drop, _ = _drop(client, pid, {"a.png": png(8, 8)})
    with kdb.session_scope() as db:
        assert drops.log_stuck(db) == 0
        row = db.get(Drop, drop["id"])
        assert row is not None and row.state == "inspecting"
        row.updated_at = now() - timedelta(minutes=11)
    with kdb.session_scope() as db:
        assert drops.log_stuck(db) == 1
    stuck = [x for x in _json_lines(caplog) if x["msg"] == "drop.stuck"]
    assert stuck and stuck[0]["dropId"] == drop["id"] and stuck[0]["stuck_ms"] >= 600_000


def test_a_table_dropped_into_a_dataset_is_checked_against_its_file_names(client):
    """§3.3 (J5): a labels CSV dropped later is keyed by names already in the dataset; the worker
    gets those names with the import (it's in the project's perimeter), never the agent."""
    pid = _project(client)
    _, imp = _drop(client, pid, {"cxr_1.png": png(5, 5), "cxr_2.png": png(6, 6)})
    nodes = [f["nodeId"] for f in client.get(f"/api/v1/worker/inspect/imports/{imp['id']}", headers=W()).json()["files"]]
    ds = client.post(f"/api/v1/projects/{pid}/datasets", json={"title": "X", "nodeIds": nodes}).json()
    d = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "conv-2", "datasetId": ds["id"], "files": 1, "bytes": 30}).json()
    csv = b"file,label\ncxr_1.png,a\ncxr_2.png,b\n"
    s = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({"labels.csv": csv}), "origin": {"kind": "chat", "conversationId": "conv-2", "dropId": d["id"]}}).json()
    client.put(s["files"][0]["uploadUrl"], content=csv)
    client.post(f"/api/v1/imports/{s['id']}/complete")
    listing = client.get(f"/api/v1/worker/inspect/imports/{s['id']}", headers=W()).json()
    assert sorted(listing["knownNames"]) == ["cxr_1.png", "cxr_2.png"]
    # An import without a table doesn't carry them.
    assert "knownNames" not in client.get(f"/api/v1/worker/inspect/imports/{imp['id']}", headers=W()).json()
