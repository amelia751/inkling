"""todo18 P0-4: the annotation document save checks the client's revision.

Two tabs (or two people) saving from the same revision: the second gets 409 with the
server's document so the Studio can merge per annotation id instead of overwriting.
"""

from __future__ import annotations

from .conftest import ws


def ann(aid: str, label: str = "cell") -> dict:
    return {"id": aid, "itemId": "img/a.png", "label": label, "geometry": {"type": "box", "x": 1, "y": 2, "w": 3, "h": 4}, "provenance": "human-created", "author": "alice", "createdAt": "2026-01-01"}


def test_stale_revision_gets_409_with_the_server_document(registry_client):
    c = registry_client()
    first = c.put("/api/annotations/ws-a", json={"revision": 0, "annotations": [ann("a1")]}, headers=ws("ws-a"))
    assert first.status_code == 200, first.text
    rev = first.json()["revision"]
    # Tab B still thinks the document is at revision 0.
    stale = c.put("/api/annotations/ws-a", json={"revision": 0, "annotations": [ann("b1")]}, headers=ws("ws-a"))
    assert stale.status_code == 409, stale.text
    body = stale.json()
    detail = body.get("detail", body)
    server = detail["current"]
    assert server["revision"] == rev and [a["id"] for a in server["annotations"]] == ["a1"]
    # Nothing was overwritten.
    assert [a["id"] for a in c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]] == ["a1"]
    # Saving on top of the current revision works.
    ok = c.put("/api/annotations/ws-a", json={"revision": rev, "annotations": [ann("a1"), ann("b1")]}, headers=ws("ws-a"))
    assert ok.status_code == 200 and ok.json()["revision"] == rev + 1
