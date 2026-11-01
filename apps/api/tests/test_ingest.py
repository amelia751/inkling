"""todo11 D8 (Milestone 3 Slice A): items dropped into a Studio register at once, upgrade in
place as they upload and the worker processes them, and every step is an `item.*` event."""

from __future__ import annotations

import hashlib

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.models import PluginEvent

from .conftest import png, worker_headers, ws

ITEM_EVENTS = ("item.registered", "item.uploaded", "item.probed", "item.thumb_ready", "item.preview_ready", "item.ready", "item.failed")


def _draft(client) -> tuple[str, str]:
    p = client.post("/api/v1/projects", json={"title": "Drop"}, headers=ws("default")).json()["id"]
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-ingest-1", "preset": "preset:image-2d"})
    assert r.status_code == 202, r.text
    return p, r.json()["taskIds"][0]


def _events(project: str) -> list[tuple[str, dict]]:
    with kdb.session_scope() as s:
        rows = s.scalars(select(PluginEvent).where(PluginEvent.workspace_id == project, PluginEvent.type.in_(ITEM_EVENTS)).order_by(PluginEvent.created_at)).all()
        return [(e.type, e.payload) for e in rows]


def _drop(client, p: str, task: str, files: dict[str, bytes]) -> dict:
    body = {"attested": True, "taskId": task, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    r = client.post(f"/api/v1/projects/{p}/imports", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _webp() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, "WEBP")
    return buf.getvalue()


def test_a_drop_registers_items_before_any_byte_and_they_upgrade_in_place(client):
    p, task = _draft(client)
    files = {"films/a.png": png(30, 20), "films/b.png": png(10, 40), "films/c.png": png(12, 12), "films/notes.csv": b"x,y\n1,2\n"}
    s = _drop(client, p, task, files)
    # Three images are items at once, in name order; the CSV only goes to Files.
    items = s["items"]
    assert [i["name"] for i in items] == ["a.png", "b.png", "c.png"]
    assert {i["ingest"]["state"] for i in items} == {"registered"} and all(i["nodeId"].startswith("nod-") and i["path"].startswith(f"sources/{p}/") for i in items)
    reg = _events(p)
    assert [k for k, _ in reg] == ["item.registered"] * 3
    assert reg[0][1]["taskId"] == task and reg[0][1]["itemId"] == items[0]["path"] and reg[0][1]["nodeId"] == items[0]["nodeId"] and reg[0][1]["kind"] == "image"

    # The task's items, a page at a time: registered items are there before any upload.
    page = client.get(f"/api/v1/tasks/{task}/items", params={"limit": 2}).json()
    assert [i["name"] for i in page["items"]] == ["a.png", "b.png"] and page["next"] == "2" and page["total"] == 3
    rest = client.get(f"/api/v1/tasks/{task}/items", params={"after": page["next"]}).json()
    assert [i["name"] for i in rest["items"]] == ["c.png"] and rest["next"] is None and rest["cursor"] == "3"

    # One file arrives: its item is `uploaded` and its bytes are served before the import completes.
    up = next(f for f in s["files"] if f["relPath"].endswith("b.png"))
    assert client.put(up["uploadUrl"], content=files["films/b.png"]).json()["state"] == "uploaded"
    b = next(i for i in items if i["name"] == "b.png")
    assert _events(p)[-1] == ("item.uploaded", {"taskId": task, "itemId": b["path"], "nodeId": b["nodeId"], "kind": "image", "meta": _events(p)[-1][1]["meta"]})
    tok = client.post("/api/v1/assets/url-token", headers=ws(task)).json()
    got = client.get(f"{tok['base']}{b['path']}", params={"exp": tok["exp"], "sig": tok["sig"]})
    assert got.status_code == 200 and got.content == files["films/b.png"]

    # The worker claims uploaded items only; visible items come first.
    for f in s["files"]:
        if f["uploadUrl"] and not f["relPath"].endswith("b.png"):
            client.put(f["uploadUrl"], content=files["films/" + f["relPath"].split("/")[-1]])
    c = next(i for i in items if i["name"] == "c.png")
    assert client.post(f"/api/v1/tasks/{task}/items/visible", json={"itemIds": [c["path"]]}).json() == {"prioritised": 1}
    claimed = client.post("/api/v1/worker/items/claim", json={"limit": 2}, headers=worker_headers()).json()["items"]
    assert [x["name"] for x in claimed] == ["c.png", "a.png"]
    # Leased: a second worker gets the rest.
    assert [x["name"] for x in client.post("/api/v1/worker/items/claim", json={"limit": 5}, headers=worker_headers()).json()["items"]] == ["b.png"]

    # Its bytes, its derivatives, its stages.
    wid = claimed[0]["id"]
    assert client.get(f"/api/v1/worker/items/{wid}/content", headers=worker_headers()).content == files["films/c.png"]
    thumb = client.put(f"/api/v1/worker/items/{wid}/derived/thumb-webp", content=_webp(), headers={**worker_headers(), "Content-Type": "image/webp"}).json()["path"]
    r = client.post(f"/api/v1/worker/items/{wid}/report", json={"stages": [{"stage": "probed", "meta": {"width": 12, "height": 12, "format": "PNG"}}, {"stage": "thumb_ready", "meta": {"thumb": thumb, "thumbhash": "AAAA"}}]}, headers=worker_headers())
    assert r.json() == {"state": "thumb_ready"}
    assert client.post(f"/api/v1/worker/items/{wid}/report", json={"stage": "thumb_ready", "meta": {"thumb": "seed/elsewhere.png"}}, headers=worker_headers()).status_code == 422
    client.post(f"/api/v1/worker/items/{wid}/report", json={"stages": [{"stage": "preview_ready", "meta": {"preview": c["path"]}}, {"stage": "ready"}]}, headers=worker_headers())
    mine = [k for k, pl in _events(p) if pl["itemId"] == c["path"]]
    assert mine == ["item.registered", "item.uploaded", "item.probed", "item.thumb_ready", "item.preview_ready", "item.ready"]
    tr = next(pl for k, pl in _events(p) if k == "item.thumb_ready")
    assert tr["meta"]["thumb"] == thumb and tr["meta"]["thumbhash"] == "AAAA" and isinstance(tr["meta"]["at"], int)

    # The document shows the item upgraded; completing pins the files to the draft's dataset.
    doc = client.get(f"/api/v1/tasks/{task}/document").json()
    cdoc = next(a for a in doc["assets"] if a["name"] == "c.png")
    assert cdoc["ingest"]["state"] == "ready" and cdoc["ingest"]["thumb"] == thumb and cdoc["width"] == 12
    done = client.post(f"/api/v1/imports/{s['id']}/complete").json()
    assert done["state"] == "inspecting"
    ds = client.get(f"/api/v1/tasks/{task}").json()["datasetId"]
    defn = client.get(f"/api/v1/projects/{p}/datasets/{ds}").json()["definition"]
    assert sorted(f["nodeId"] for f in defn["files"]) == sorted(i["nodeId"] for i in items)
    after = client.get(f"/api/v1/tasks/{task}/document").json()["assets"]
    assert [a["name"] for a in after] == ["a.png", "b.png", "c.png"]  # still once each, in drop order


def test_a_redrop_of_known_bytes_is_uploaded_at_once_and_agents_cannot_read_items(client):
    p, task = _draft(client)
    data = png(9, 9)
    s = _drop(client, p, task, {"x.png": data})
    client.put(s["files"][0]["uploadUrl"], content=data)
    client.post(f"/api/v1/imports/{s['id']}/complete")
    # The same bytes under a new name: no upload, the existing asset is the item, already `uploaded`.
    again = client.post(f"/api/v1/projects/{p}/imports", json={"attested": True, "taskId": task, "files": [{"clientFileId": "g0", "relPath": "copy.png", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]}).json()
    assert again["items"] == []  # same item id as x.png: one item per bytes in a task
    # A task of another project is refused.
    other = client.post("/api/v1/projects", json={"title": "Other"}).json()["id"]
    r = client.post(f"/api/v1/projects/{other}/imports", json={"attested": True, "taskId": task, "files": [{"clientFileId": "h0", "relPath": "y.png", "size": 3, "sha256": "0" * 64}]})
    assert r.status_code == 422

    tok = client.post("/api/v1/sessions", json={"agent": "assistant", "profile": "assistant", "scopes": ["proposals.write"]}, headers=ws(p)).json()["token"]
    agent = {"Authorization": f"Bearer {tok}"}
    assert client.get(f"/api/v1/tasks/{task}/items", headers=agent).status_code == 403
    assert client.post(f"/api/v1/tasks/{task}/items/visible", json={"itemIds": []}, headers=agent).status_code == 403


def test_a_failed_or_cancelled_upload_fails_its_item(client):
    p, task = _draft(client)
    data = png(5, 5)
    s = _drop(client, p, task, {"bad.png": data, "later.png": png(6, 6)})
    bad = next(f for f in s["files"] if f["relPath"] == "bad.png")
    assert client.put(bad["uploadUrl"], content=b"\x00" * len(data)).json()["state"] == "failed"  # wrong bytes
    client.post(f"/api/v1/imports/{s['id']}/cancel")
    states = {pl["itemId"].rsplit("/", 1)[-1]: k for k, pl in _events(p)}
    assert set(states.values()) == {"item.failed"}
    assert {a["ingest"]["state"] for a in client.get(f"/api/v1/tasks/{task}/items").json()["items"]} == {"failed"}
