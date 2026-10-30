"""todo6 Phase 4: the server side of Sources (opaque run ids, duplicates, the upload event)."""

from __future__ import annotations

from studio_api import db as kdb
from studio_api.models import Asset, PluginEvent, SourceNode

from .conftest import png
from .test_projects import _import, _session_body


def _children(client, source_id: str, node: str | None = None) -> list[dict]:
    params = {"node": node} if node else {}
    return client.get(f"/api/v1/sources/{source_id}/children", params=params).json()["items"]


def test_run_ids_are_opaque_and_files_know_their_run(client):
    p = client.post("/api/v1/projects", json={"title": "Runs"}).json()
    files = {f"patient_smith/smith_scan{i}.dcm": f"d{i}".encode() for i in range(1, 6)}
    files["patient_smith/notes.txt"] = b"n"
    _import(client, p["id"], files)
    src = client.get(f"/api/v1/projects/{p['id']}/sources").json()["sources"][0]
    top = _children(client, src["id"])
    run = next(i for i in top if i["kind"] == "sequence")
    # The id goes into URLs: it never carries the names it was made from.
    assert run["id"].startswith("seq:") and "smith" not in run["id"] and "#" not in run["id"]
    assert [i["name"] for i in _children(client, src["id"], run["id"])] == [f"smith_scan{i}.dcm" for i in range(1, 6)]
    scan3 = next(i for i in _children(client, src["id"], run["id"]) if i["name"] == "smith_scan3.dcm")
    assert client.get(f"/api/v1/source-nodes/{scan3['id']}").json()["runId"] == run["id"]
    notes = next(i for i in top if i["name"] == "notes.txt")
    assert client.get(f"/api/v1/source-nodes/{notes['id']}").json()["runId"] is None
    # An unknown run id is an empty listing, not someone else's files.
    assert _children(client, src["id"], f"seq:{src['rootNodeId']}:000000000000") == []


def test_duplicates_link_to_the_existing_asset(client):
    p = client.post("/api/v1/projects", json={"title": "Dups"}).json()
    img = png(7, 7)
    _import(client, p["id"], {"one/a.png": img})
    # The same bytes under another name and extension, twice in one drop, plus a new file.
    files = {"two/copy.bin": img, "two/copy2.bin": img, "two/new.png": png(8, 8)}
    s = client.post(f"/api/v1/projects/{p['id']}/imports", json=_session_body(files, prefix="g")).json()
    by_name = {f["relPath"]: f for f in s["files"]}
    # Known bytes need no upload.
    assert by_name["copy.bin"]["state"] == "uploaded" and by_name["copy.bin"]["uploadUrl"] is None
    for f in s["files"]:
        if f["uploadUrl"]:
            client.put(f["uploadUrl"], content=files["two/" + f["relPath"]])
    done = client.post(f"/api/v1/imports/{s['id']}/complete").json()
    assert done["totals"]["committed"] == 3
    with kdb.session_scope() as db:
        nodes = {n.name: n for n in db.query(SourceNode).filter(SourceNode.project_id == p["id"], SourceNode.is_dir.is_(False))}
        original = nodes["a.png"]
        for name in ("copy.bin", "copy2.bin"):
            assert nodes[name].asset_id == original.asset_id
            assert nodes[name].flags["duplicate_of"] == {"nodeId": original.id, "name": "a.png"}
        assert "duplicate_of" not in (nodes["new.png"].flags or {})
        # Stored once: no asset row for the duplicate's would-be key.
        assert db.query(Asset).filter(Asset.workspace_id == p["id"]).count() == 2
    dup = client.get(f"/api/v1/source-nodes/{nodes['copy.bin'].id}").json()
    assert dup["flags"]["duplicate_of"]["name"] == "a.png"


def test_duplicates_within_one_drop_point_at_the_first(client):
    p = client.post("/api/v1/projects", json={"title": "Twins"}).json()
    img = png(9, 9)
    _import(client, p["id"], {"d/x1.png": img, "d/x2.png": img})
    with kdb.session_scope() as db:
        nodes = {n.name: n for n in db.query(SourceNode).filter(SourceNode.project_id == p["id"], SourceNode.is_dir.is_(False))}
        assert nodes["x1.png"].asset_id == nodes["x2.png"].asset_id
        assert nodes["x2.png"].flags["duplicate_of"] == {"nodeId": nodes["x1.png"].id, "name": "x1.png"}
        assert not nodes["x1.png"].flags


def test_source_uploaded_event_names_the_new_nodes(client):
    """The worker's inspection (Phase 5) consumes this event: keep its name and payload."""
    p = client.post("/api/v1/projects", json={"title": "Event"}).json()
    done = _import(client, p["id"], {"e/a.png": png(4, 4), "e/b.csv": b"id,x\n1,2\n"})
    with kdb.session_scope() as db:
        ev = [e for e in db.query(PluginEvent).filter(PluginEvent.workspace_id == p["id"], PluginEvent.type == "source.uploaded")]
        assert len(ev) == 1
        payload = ev[0].payload
        ids = {n.id for n in db.query(SourceNode).filter(SourceNode.project_id == p["id"], SourceNode.is_dir.is_(False))}
    assert set(payload) == {"projectId", "importId", "sourceId", "nodeIds"}
    assert payload["projectId"] == p["id"] and payload["importId"] == done["id"] and set(payload["nodeIds"]) == ids


def test_upload_limits_come_from_settings(make_client):
    client = make_client(upload_max_file_bytes=10, upload_max_session_files=2)
    p = client.post("/api/v1/projects", json={"title": "Limits"}).json()
    s = client.post(f"/api/v1/projects/{p['id']}/imports", json=_session_body({"l/big.png": png(9, 9)})).json()
    assert s["files"][0]["state"] == "rejected" and "Too large" in s["files"][0]["reason"]
    many = _session_body({f"l/{i}.txt": bytes([i]) for i in range(3)})
    r = client.post(f"/api/v1/projects/{p['id']}/imports", json=many)
    assert r.status_code == 413 and "Too many files" in r.json()["detail"]


def test_redropping_a_folder_onto_its_own_source_skips_everything(client):
    p = client.post("/api/v1/projects", json={"title": "Redrop"}).json()
    files = {"study/a/x.png": png(5, 5), "study/b.csv": b"k,v\n1,2\n"}
    _import(client, p["id"], files)
    src = client.get(f"/api/v1/projects/{p['id']}/sources").json()["sources"][0]
    # The same folder, dropped while its source is open (the source root is the target).
    again = client.post(f"/api/v1/projects/{p['id']}/imports", json={**_session_body(files, prefix="r"), "targetNodeId": src["rootNodeId"]}).json()
    assert {f["state"] for f in again["files"]} == {"skipped_duplicate"}
    # A different folder dropped onto it still nests, as in any file browser.
    other = client.post(f"/api/v1/projects/{p['id']}/imports", json={**_session_body({"extra/y.png": png(6, 6)}, prefix="o"), "targetNodeId": src["rootNodeId"]}).json()
    assert other["files"][0]["relPath"] == "extra/y.png"
