"""The project summary: a card names what its files are (kinds most first, ties most specific
first; masks and unreadable files left out), and the rights attestation is asked once per person."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.models import SourceNode

from .test_drops import _drop, _project


def test_project_list_counts_file_kinds(make_client):
    client = make_client()
    pid = _project(client, "Kinds")
    _drop(client, pid, {f"d/{n}": n.encode() for n in ("a.png", "b.png", "s.svs", "t.png", "m.nii.gz", "x.bin")})
    kinds = {"a.png": "image", "b.png": "image", "s.svs": "slide", "t.png": "mask", "m.nii.gz": "volume", "x.bin": "unknown"}
    with kdb.session_scope() as db:
        for n in db.scalars(select(SourceNode).where(SourceNode.project_id == pid, SourceNode.is_dir.is_(False))):
            n.detected_kind = kinds[n.name]
    got = next(p for p in client.get("/api/v1/projects").json()["projects"] if p["id"] == pid)
    assert got["kinds"] == [{"kind": "image", "count": 2}, {"kind": "slide", "count": 1}, {"kind": "volume", "count": 1}]


def test_the_rights_attestation_is_asked_once_per_person_not_per_project(make_client):
    client = make_client()
    first = _project(client, "First")
    assert client.get(f"/api/v1/projects/{first}").json()["attested"] is False
    _drop(client, first, {"a.png": b"a"})
    assert client.delete(f"/api/v1/projects/{first}").status_code == 200  # still counts from Trash
    second = _project(client, "Second")
    assert client.get(f"/api/v1/projects/{second}").json()["attested"] is True
