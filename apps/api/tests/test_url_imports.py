"""todo16 D10: add data from a link or by copy, through the normal import path."""

from __future__ import annotations

import hashlib
import os
import tempfile

import pytest
from fastapi import HTTPException

from studio_api import db as kdb
from studio_api.kernel import url_imports
from studio_api.models import PluginEvent, PluginJob, SourceNode

from .conftest import png, worker_headers
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


def _run_import_job(client, worker="w1") -> dict:
    """Act as apps/worker: claim the queued `imports.fetch_url` job and run it."""
    claim = client.post("/api/v1/worker/claim", json={"workerId": worker}, headers=worker_headers()).json()
    assert claim["builtin"] == "imports" and claim["job"]["tool"] == "fetch_url", claim
    r = client.post(f"/api/v1/worker/imports/jobs/{claim['job']['jobId']}/run", json={"workerId": worker}, headers=worker_headers())
    assert r.status_code == 200, r.text
    return r.json()


def test_import_from_a_link_is_a_job_that_lands_in_files(client, monkeypatch, public_dns):
    img = png(5, 5)
    fetch, calls = _fake(img)
    monkeypatch.setattr(url_imports, "FETCH", fetch)
    p = client.post("/api/v1/projects", json={"title": "Links"}).json()
    r = client.post(f"/api/v1/projects/{p['id']}/imports/url", json={"url": "https://example.com/x/chest.png", "attested": True})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["importId"] and out["state"] == "fetching"
    assert not calls  # nothing fetched in the request
    with kdb.session_scope() as db:
        j = db.get(PluginJob, out["jobId"])
        assert j is not None and j.plugin_id == url_imports.PLUGIN and j.tool == "fetch_url" and j.state == "queued"
    assert client.get(f"/api/v1/imports/{out['importId']}").json()["state"] == "fetching"
    assert _run_import_job(client)["state"] == "inspecting"
    s = client.get(f"/api/v1/imports/{out['importId']}").json()
    assert s["state"] == "inspecting" and [f["relPath"] for f in s["files"]] == ["chest.png"]
    assert calls[0][2] == 5368709120  # the default cap
    with kdb.session_scope() as db:
        names = [n.name for n in db.query(SourceNode).filter(SourceNode.project_id == p["id"], SourceNode.is_dir.is_(False))]
        assert names == ["chest.png"]
        assert db.query(PluginEvent).filter(PluginEvent.workspace_id == p["id"], PluginEvent.type == "source.uploaded").count() == 1
        assert db.get(PluginJob, out["jobId"]).state == "succeeded"
    assert "data" not in r.text and len(r.content) < 2000


def test_import_from_a_link_needs_the_rights_confirmation(client, monkeypatch, public_dns):
    fetch, calls = _fake(png(2, 2))
    monkeypatch.setattr(url_imports, "FETCH", fetch)
    p = client.post("/api/v1/projects", json={"title": "Rights"}).json()
    for body in ({"url": "https://example.com/a.png"}, {"url": "https://example.com/a.png", "attested": "yes"}):
        r = client.post(f"/api/v1/projects/{p['id']}/imports/url", json=body)
        assert r.status_code == 422 and "rights" in r.text
    with kdb.session_scope() as db:
        assert db.query(PluginJob).filter(PluginJob.plugin_id == url_imports.PLUGIN).count() == 0


def test_import_from_a_link_respects_the_size_cap(make_client, monkeypatch, public_dns):
    client = make_client(url_import_max_bytes=10)
    fetch, _ = _fake(b"x" * 11)
    monkeypatch.setattr(url_imports, "FETCH", fetch)
    p = client.post("/api/v1/projects", json={"title": "Cap"}).json()
    r = client.post(f"/api/v1/projects/{p['id']}/imports/url", json={"url": "https://example.com/big.bin", "attested": True})
    assert r.status_code == 202
    assert _run_import_job(client)["state"] == "failed"
    s = client.get(f"/api/v1/imports/{r.json()['importId']}").json()
    assert s["state"] == "failed" and "larger than" in s["error"]
    assert client.post(f"/api/v1/projects/{p['id']}/imports/url", json={"url": "http://example.com/a", "attested": True}).status_code == 422


def _mock_client(monkeypatch, handler):
    import httpx

    seen: list[httpx.Request] = []

    def h(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    monkeypatch.setattr(url_imports, "_client", lambda: httpx.Client(transport=httpx.MockTransport(h), follow_redirects=False))
    return seen


def test_fetch_connects_to_the_checked_address(monkeypatch):
    import httpx

    answers = iter([["93.184.216.34"], ["127.0.0.1"]])  # a rebinding resolver: public, then private
    lookups: list[str] = []

    def resolve(host):
        lookups.append(host)
        return next(answers)

    monkeypatch.setattr(url_imports, "resolve", resolve)
    seen = _mock_client(monkeypatch, lambda req: httpx.Response(200, content=b"abc"))
    got = url_imports._fetch_https("https://files.example.org/x/a.bin", 100)
    os.unlink(got.path)
    assert got.size == 3 and got.name == "a.bin"
    assert lookups == ["files.example.org"]  # resolved once
    req = seen[0]
    assert req.url.host == "93.184.216.34"  # the pinned, checked address
    assert req.headers["host"] == "files.example.org"
    assert req.extensions["sni_hostname"] == "files.example.org"


def test_a_redirect_to_a_rebound_private_address_is_refused(monkeypatch):
    import httpx

    monkeypatch.setattr(url_imports, "resolve", lambda host: ["93.184.216.34"] if host == "files.example.org" else ["169.254.169.254"])

    def handler(req):
        return httpx.Response(302, headers={"location": "https://rebind.example.net/latest/meta-data"})

    seen = _mock_client(monkeypatch, handler)
    with pytest.raises(HTTPException) as e:
        url_imports._fetch_https("https://files.example.org/a", 100)
    assert e.value.status_code == 422 and "private" in str(e.value.detail)
    assert [r.url.host for r in seen] == ["93.184.216.34"]  # never connected to the private one


def test_copy_from_another_project_needs_read_access(client):
    a = client.post("/api/v1/projects", json={"title": "From"}).json()
    _import(client, a["id"], {"xr/one.png": png(3, 3), "xr/two.png": png(4, 4)})
    b = client.post("/api/v1/projects", json={"title": "To"}).json()
    r = client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"fromProjectId": a["id"], "attested": True})
    assert r.status_code == 201, r.text
    assert sorted(f["name"] for f in r.json()["files"]) == ["one.png", "two.png"]
    with kdb.session_scope() as db:
        assert db.query(SourceNode).filter(SourceNode.project_id == b["id"], SourceNode.is_dir.is_(False)).count() == 2
    # Someone who can't read the source project gets a 404 (ids don't leak).
    mine = client.post("/api/v1/projects", json={"title": "Theirs"}, headers=OTHER).json()
    assert client.post(f"/api/v1/projects/{mine['id']}/imports/copy", json={"fromProjectId": a["id"], "attested": True}, headers=OTHER).status_code == 404
    # Nor can they copy into a project that isn't theirs.
    assert client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"fromProjectId": a["id"], "attested": True}, headers=OTHER).status_code == 404
    assert client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"attested": True}).status_code == 422
    # The rights confirmation is required (round 2): without it, nothing is copied.
    assert client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"fromProjectId": a["id"]}).status_code == 422


def test_copy_from_a_sample(client):
    b = client.post("/api/v1/projects", json={"title": "Sampled"}).json()
    r = client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"sampleId": "ws-a", "attested": True})
    assert r.status_code == 201, r.text
    assert r.json()["files"]
    assert client.post(f"/api/v1/projects/{b['id']}/imports/copy", json={"sampleId": "nope", "attested": True}).status_code == 404
