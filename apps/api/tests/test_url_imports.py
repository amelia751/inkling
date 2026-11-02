"""todo16 D10: add data from a link or by copy, through the normal import path."""

from __future__ import annotations

import hashlib
import os
import tempfile

import pytest
from fastapi import HTTPException

from studio_api import db as kdb
from studio_api.kernel import url_imports
from studio_api.models import PluginEvent, SourceNode

from .conftest import png
from .test_projects import _import

OTHER = {"X-Dev-Principal": "user:someone-else"}


def _fake(data: bytes, name: str = "chest.png"):
    calls: list[tuple[str, str, int]] = []

    def fetch(scheme: str, url: str, max_bytes: int) -> url_imports.Fetched:
        calls.append((scheme, url, max_bytes))
        if len(data) > max_bytes:
            raise url_imports.TooLarge()
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        return url_imports.Fetched(name, path, len(data), hashlib.sha256(data).hexdigest())

    return fetch, calls


@pytest.fixture
def public_dns(monkeypatch):
    monkeypatch.setattr(url_imports, "resolve", lambda host: ["93.184.216.34"] if host != "evil.example" else ["10.0.0.5"])


@pytest.mark.parametrize("url", ["http://example.com/a.png", "ftp://example.com/a", "file:///etc/passwd", "https://localhost/a", "https://127.0.0.1/a", "https://10.1.2.3/x", "https://[::1]/x", "https://169.254.169.254/latest/meta-data", "https://[::ffff:127.0.0.1]/x", "https://user:pw@example.com/a", "https://evil.example/a", "gs://bucket-only", ""])
def test_links_that_are_refused(url, public_dns):
    with pytest.raises(HTTPException) as e:
        url_imports.check_url(url)
    assert e.value.status_code == 422


def test_links_that_are_allowed(public_dns):
    assert url_imports.check_url("https://example.com/x/chest.png") == ("https", "https://example.com/x/chest.png")
    assert url_imports.check_url("gs://my-bucket/a/b.dcm")[0] == "gs"


def test_import_from_a_link_lands_in_files_and_is_inspected(client, monkeypatch, public_dns):
    img = png(5, 5)
    fetch, calls = _fake(img)
    monkeypatch.setattr(url_imports, "FETCH", fetch)
    p = client.post("/api/v1/projects", json={"title": "Links"}).json()
    r = client.post(f"/api/v1/projects/{p['id']}/imports/url", json={"url": "https://example.com/x/chest.png"})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["importId"] and out["state"] == "inspecting"
    assert out["files"] == [{"name": "chest.png", "size": len(img), "state": "uploaded"}]
    assert calls[0][2] == 5368709120  # the default cap
    with kdb.session_scope() as db:
        names = [n.name for n in db.query(SourceNode).filter(SourceNode.project_id == p["id"], SourceNode.is_dir.is_(False))]
        assert names == ["chest.png"]
        assert db.query(PluginEvent).filter(PluginEvent.workspace_id == p["id"], PluginEvent.type == "source.uploaded").count() == 1
    # The response never carries bytes.
    assert "data" not in r.text and len(r.content) < 2000


def test_import_from_a_link_respects_the_size_cap(make_client, monkeypatch, public_dns):
    client = make_client(url_import_max_bytes=10)
    fetch, _ = _fake(b"x" * 11)
    monkeypatch.setattr(url_imports, "FETCH", fetch)
    p = client.post("/api/v1/projects", json={"title": "Cap"}).json()
    r = client.post(f"/api/v1/projects/{p['id']}/imports/url", json={"url": "https://example.com/big.bin"})
    assert r.status_code == 413
    assert client.post(f"/api/v1/projects/{p['id']}/imports/url", json={"url": "http://example.com/a"}).status_code == 422


def test_copy_from_another_project_needs_read_access(client):
    a = client.post("/api/v1/projects", json={"title": "From"}).json()
    _import(client, a["id"], {"xr/one.png": png(3, 3), "xr/two.png": png(4, 4)})
    b = client.post("/api/v1/projects", json={"title": "To"}).json()
    r = client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"fromProjectId": a["id"]})
    assert r.status_code == 201, r.text
    assert sorted(f["name"] for f in r.json()["files"]) == ["one.png", "two.png"]
    with kdb.session_scope() as db:
        assert db.query(SourceNode).filter(SourceNode.project_id == b["id"], SourceNode.is_dir.is_(False)).count() == 2
    # Someone who can't read the source project gets a 404 (ids don't leak).
    mine = client.post("/api/v1/projects", json={"title": "Theirs"}, headers=OTHER).json()
    assert client.post(f"/api/v1/projects/{mine['id']}/imports/copy", json={"fromProjectId": a["id"]}, headers=OTHER).status_code == 404
    # Nor can they copy into a project that isn't theirs.
    assert client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"fromProjectId": a["id"]}, headers=OTHER).status_code == 404
    assert client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={}).status_code == 422


def test_copy_from_a_sample(client):
    b = client.post("/api/v1/projects", json={"title": "Sampled"}).json()
    r = client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"sampleId": "ws-a"})
    assert r.status_code == 201, r.text
    assert r.json()["files"]
    assert client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"sampleId": "nope"}).status_code == 404
