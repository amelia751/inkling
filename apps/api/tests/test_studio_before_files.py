"""todo24 D3: a Studio made for a drop shows that drop's items, whichever came first: the Studio
(the assistant booted it while the files were still uploading) or the files (committed before
the boot)."""

from __future__ import annotations

import hashlib

from .conftest import png, worker_headers, ws

KINDS = {"a.jpg": "image", "b.png": "image", "c.png": "image", "d.png": "image", "notes.csv": "table"}


def _project(client) -> str:
    return client.post("/api/v1/projects", json={"title": "Chest X-rays"}, headers=ws("default")).json()["id"]


def _boot(client, p: str, boot_id: str) -> str:
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": boot_id, "preset": "preset:image-2d"})
    assert r.status_code == 202, r.text
    return r.json()["taskIds"][0]


def _start(client, p: str, files: dict[str, bytes]) -> dict:
    """A plain import (no `taskId`): Home with chat drops off."""
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    r = client.post(f"/api/v1/projects/{p}/imports", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _finish(client, s: dict, files: dict[str, bytes]) -> None:
    """Upload every byte, complete, and let the worker inspect the files."""
    data = list(files.values())
    for f in s["files"]:
        if f.get("uploadUrl"):
            assert client.put(f["uploadUrl"], content=data[int(f["clientFileId"][1:])]).json()["state"] == "uploaded"
    assert client.post(f"/api/v1/imports/{s['id']}/complete").status_code == 200
    found = client.get(f"/api/v1/worker/inspect/imports/{s['id']}", headers=worker_headers()).json()["files"]
    nodes = [{"nodeId": f["nodeId"], "detectedKind": KINDS.get(f["name"], "unknown"), "facts": {}} for f in found]
    r = client.post(f"/api/v1/worker/inspect/imports/{s['id']}/report", json={"inspector": "test", "nodes": nodes}, headers=worker_headers())
    assert r.status_code == 200, r.text


def _names(client, task: str) -> list[str]:
    return sorted(a["name"] for a in client.get(f"/api/v1/tasks/{task}/document").json()["assets"])


def _pinned(client, p: str, task: str) -> int:
    ds = client.get(f"/api/v1/tasks/{task}").json()["datasetId"]
    return len(client.get(f"/api/v1/projects/{p}/datasets/{ds}").json()["definition"]["files"])


XRAYS = {"xr/a.jpg": png(10, 10), "xr/b.png": png(11, 11), "xr/notes.csv": b"id,label\n1,normal\n"}


def test_studio_first_the_uploading_drop_and_later_uploads_join_it(client):
    p = _project(client)
    s = _start(client, p, XRAYS)  # the upload started…
    task = _boot(client, p, "boot-w5-task-first")  # …then the assistant booted the Studio
    # The in-flight upload joined it: its images are items before their bytes land.
    assert _names(client, task) == ["a.jpg", "b.png"]
    _finish(client, s, XRAYS)
    assert _names(client, task) == ["a.jpg", "b.png"] and _pinned(client, p, task) == 2  # the CSV stays in Files

    # An upload started after the boot joins too, while the Studio is a draft.
    more = {"xr2/c.png": png(12, 12)}
    _finish(client, _start(client, p, more), more)
    assert _names(client, task) == ["a.jpg", "b.png", "c.png"] and _pinned(client, p, task) == 3

    # Once a person publishes it, uploads no longer join on their own.
    assert client.post(f"/api/v1/tasks/{task}/publish").status_code == 200
    late = {"xr3/d.png": png(13, 13)}
    _finish(client, _start(client, p, late), late)
    assert _names(client, task) == ["a.jpg", "b.png", "c.png"]


def test_files_first_the_projects_first_studio_starts_with_them(client):
    p = _project(client)
    _finish(client, _start(client, p, XRAYS), XRAYS)  # committed (and inspected) before the boot
    task = _boot(client, p, "boot-w5-files-first")
    assert _names(client, task) == ["a.jpg", "b.png"] and _pinned(client, p, task) == 2
    steps = client.get("/api/v1/boots/boot-w5-files-first").json()["steps"]
    assert any("Linked 2 files" in str(st) for st in steps), steps

    # A second Studio booted empty doesn't sweep in the project's existing files.
    other = _boot(client, p, "boot-w5-second")
    assert _names(client, other) == []
