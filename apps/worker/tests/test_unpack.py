"""Archive unpack (todo13 M2 item 7): safe checks without extracting (zip bombs, nesting, path
traversal, links, encryption, counts, sizes), bounded memory, and the whole loop through the
live kernel: a ZIP in a drop is unpacked next to itself and its contents become a child drop."""

from __future__ import annotations

import hashlib
import io
import tarfile
import tracemalloc
import zipfile
from pathlib import Path

import httpx
import pytest

from studio_worker.config import UnpackLimits
from studio_worker.inspect import InspectSubscriber
from studio_worker.unpack import Refused, UnpackSubscriber, safe_path, scan

from .conftest import png
from .test_inspection import upload

@pytest.fixture(autouse=True)
def _flags_off():
    from studio_api.kernel import drop_flags

    drop_flags.OVERRIDES.update(auto_apply=False, fast_path=False)
    yield
    drop_flags.OVERRIDES.clear()


LIMITS = UnpackLimits(max_bytes=200 << 20, max_files=100, max_ratio=100, max_depth=2, tmp_bytes=50 << 20)


def _zip(path: Path, entries: dict[str, bytes], *, method=zipfile.ZIP_DEFLATED, mutate=None) -> Path:
    with zipfile.ZipFile(path, "w", method) as z:
        for name, data in entries.items():
            info = zipfile.ZipInfo(name)
            info.compress_type = method
            if mutate:
                mutate(info)
            z.writestr(info, data)
    return path


def test_a_normal_zip_is_listed_with_hashes(tmp_path):
    data = {"study/a.png": png(8, 8), "study/b/c.png": png(9, 9), "notes.txt": b"hello"}
    s = scan(_zip(tmp_path / "ok.zip", data), LIMITS)
    assert s.kind == "zip" and s.skipped == 0
    assert {e.rel_path: e.sha256 for e in s.entries} == {k: hashlib.sha256(v).hexdigest() for k, v in data.items()}


def test_zip_bomb_by_ratio_is_refused(tmp_path):
    bomb = _zip(tmp_path / "bomb.zip", {"zeros.bin": bytes(40 << 20)})
    assert bomb.stat().st_size < 200_000
    with pytest.raises(Refused) as e:
        scan(bomb, LIMITS)
    assert e.value.reason == "ratio"


def test_an_entry_that_lies_about_its_size_is_refused(tmp_path):
    # Header says 1 KiB; the stream inflates to 4 MiB of zeros.
    path = _zip(tmp_path / "liar.zip", {"x.bin": bytes(4 << 20)})
    raw = bytearray(path.read_bytes())
    with zipfile.ZipFile(path) as z:
        info = z.infolist()[0]
    # Patch the central directory's uncompressed size (offset 24 in the central header).
    cd = raw.rfind(b"PK\x01\x02")
    raw[cd + 24 : cd + 28] = (1024).to_bytes(4, "little")
    lh = raw.find(b"PK\x03\x04")
    raw[lh + 22 : lh + 26] = (1024).to_bytes(4, "little")
    path.write_bytes(bytes(raw))
    assert info.file_size == 4 << 20
    with pytest.raises((Refused, zipfile.BadZipFile)):
        scan(path, UnpackLimits(max_ratio=10_000))


def test_path_traversal_is_refused_in_zip_and_tar(tmp_path):
    with pytest.raises(Refused) as e:
        scan(_zip(tmp_path / "trav.zip", {"../../etc/evil.png": png(4, 4)}), LIMITS)
    assert e.value.reason == "traversal"
    with pytest.raises(Refused) as e:
        scan(_zip(tmp_path / "abs.zip", {"/abs/evil.png": png(4, 4)}), LIMITS)
    assert e.value.reason == "traversal"
    t = tmp_path / "trav.tar"
    with tarfile.open(t, "w") as tf:
        data = png(4, 4)
        info = tarfile.TarInfo("ok/../../evil.png")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    with pytest.raises(Refused) as e:
        scan(t, LIMITS)
    assert e.value.reason == "traversal"
    assert safe_path("a\\b\\c.png") == "a/b/c.png" and safe_path("C:/x") is None and safe_path("./a/./b") == "a/b"


def test_links_are_never_followed(tmp_path):
    def link(info: zipfile.ZipInfo) -> None:
        if info.filename == "link":
            info.external_attr = (0o120777 << 16)

    s = scan(_zip(tmp_path / "links.zip", {"a.png": png(4, 4), "link": b"/etc/passwd"}, mutate=link), LIMITS)
    assert [e.rel_path for e in s.entries] == ["a.png"] and s.skipped == 1
    t = tmp_path / "links.tar.gz"
    with tarfile.open(t, "w:gz") as tf:
        sym = tarfile.TarInfo("evil")
        sym.type, sym.linkname = tarfile.SYMTYPE, "/etc/passwd"
        tf.addfile(sym)
        data = png(5, 5)
        info = tarfile.TarInfo("ok.png")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    s = scan(t, LIMITS)
    assert s.kind == "tar" and [e.rel_path for e in s.entries] == ["ok.png"] and s.skipped == 1


def test_encrypted_archives_are_refused(tmp_path):
    # Set the "encrypted" bit in the local and central headers (zipfile won't write one).
    path = _zip(tmp_path / "enc.zip", {"a.png": png(4, 4)})
    raw = bytearray(path.read_bytes())
    raw[raw.find(b"PK\x03\x04") + 6] |= 0x1
    raw[raw.rfind(b"PK\x01\x02") + 8] |= 0x1
    path.write_bytes(bytes(raw))
    with pytest.raises(Refused) as e:
        scan(path, LIMITS)
    assert e.value.reason == "encrypted"


def test_count_and_size_limits(tmp_path):
    many = {f"f{i}.txt": b"x" for i in range(5)}
    with pytest.raises(Refused) as e:
        scan(_zip(tmp_path / "many.zip", many), UnpackLimits(max_files=4))
    assert e.value.reason == "too_many_files"
    with pytest.raises(Refused) as e:
        scan(_zip(tmp_path / "big.zip", {"a.bin": bytes(range(256)) * 64}, method=zipfile.ZIP_STORED), UnpackLimits(max_bytes=1000))
    assert e.value.reason == "too_large"


def test_not_an_archive_is_unreadable(tmp_path):
    p = tmp_path / "x.zip"
    p.write_bytes(b"PK\x03\x04 this is not really a zip")
    with pytest.raises(Refused):
        scan(p, LIMITS)


def test_scanning_holds_a_chunk_not_the_archive(tmp_path):
    # 30 MiB of incompressible-ish data: peak Python memory stays a few MiB.
    import os

    blob = os.urandom(30 << 20)
    path = _zip(tmp_path / "big.zip", {"big.bin": blob}, method=zipfile.ZIP_STORED)
    del blob
    tracemalloc.start()
    try:
        scan(path, LIMITS)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 << 20, peak


class _Kernel:
    """A fake kernel for the subscriber's refusal paths."""

    def __init__(self, archive: bytes):
        self.archive, self.calls = archive, []

    def handler(self, req: httpx.Request) -> httpx.Response:
        self.calls.append((req.method, req.url.path))
        if req.url.path.endswith("/content"):
            return httpx.Response(200, content=self.archive)
        if req.url.path.endswith("/refused"):
            import json

            return httpx.Response(200, json={"refused": json.loads(req.content)["reason"]})
        return httpx.Response(404)


def test_too_deep_and_tmp_budget_are_refused_before_reading(tmp_path):
    k = _Kernel(b"PK")
    sub = UnpackSubscriber(httpx.Client(base_url="http://k", transport=httpx.MockTransport(k.handler)), tmp_path, LIMITS)
    assert sub.handle({"nodeId": "nod-1", "dropId": "d", "depth": 3}) == "refused:depth"
    assert k.calls == [("POST", "/api/v1/worker/unpack/nod-1/refused")]
    k2 = _Kernel(bytes(2048))
    sub2 = UnpackSubscriber(httpx.Client(base_url="http://k", transport=httpx.MockTransport(k2.handler)), tmp_path, UnpackLimits(tmp_bytes=1024))
    assert sub2.handle({"nodeId": "nod-2", "dropId": "d", "depth": 1}) == "refused:tmp_budget"
    assert not list(tmp_path.glob("*.archive"))  # scratch cleaned up


# ---- Through the live kernel ------------------------------------------------------------------


def test_a_dropped_zip_is_unpacked_into_a_child_drop(stack, tmp_path):
    from studio_api import db as kdb
    from studio_api.models import ImportSession

    url = stack["url"]
    p = httpx.post(f"{url}/api/v1/projects", json={"title": "Zip drop"}).json()["id"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("films/a.png", png(12, 10))
        z.writestr("films/b.png", png(13, 10))
    imp = upload(url, p, {"in/scans.zip": buf.getvalue()})
    with kdb.session_scope() as s:
        row = s.get(ImportSession, imp["id"])
        row.totals = {**(row.totals or {}), "dropId": "drp_zip_e2e"}
    http = httpx.Client(base_url=url, headers={"X-Worker-Token": stack["token"]}, timeout=30)
    inspect = InspectSubscriber(http, tmp_path / "inspect")
    assert inspect.tick() >= 1
    plan = httpx.get(f"{url}/api/v1/drops/drp_zip_e2e/plan").json()
    assert [a["type"] for a in plan["plan"]["actions"]] == ["unpack"]
    assert httpx.post(f"{url}/api/v1/drops/drp_zip_e2e/apply", json={}).json()["state"] == "applied"

    unpack = UnpackSubscriber(http, tmp_path / "unpack", LIMITS)
    assert unpack.tick() == 1
    assert unpack.tick() == 0  # acknowledged
    assert inspect.tick() >= 1  # the child drop's files are inspected like any upload
    children = [x for x in httpx.get(f"{url}/api/v1/projects/{p}/search", params={"q": "png"}).json()["items"] if x["name"].endswith(".png")]
    assert sorted(x["name"] for x in children) == ["a.png", "b.png"]
    with kdb.session_scope() as s:
        child = next(x for x in s.query(ImportSession).filter(ImportSession.project_id == p) if (x.totals or {}).get("origin") == "unpack")
        child_drop = child.totals["dropId"]
    st = httpx.get(f"{url}/api/v1/drops/{child_drop}/plan").json()
    assert st["groups"][0]["kind"] == "image" and st["groups"][0]["count"] == 2
    assert not list((tmp_path / "unpack").glob("*.archive"))


def test_a_zip_bomb_in_a_drop_is_refused_with_a_chip(stack, tmp_path):
    from studio_api import db as kdb
    from studio_api.models import ImportSession

    url = stack["url"]
    p = httpx.post(f"{url}/api/v1/projects", json={"title": "Bomb"}).json()["id"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("zeros.bin", bytes(30 << 20))
    imp = upload(url, p, {"bomb.zip": buf.getvalue()})
    with kdb.session_scope() as s:
        row = s.get(ImportSession, imp["id"])
        row.totals = {**(row.totals or {}), "dropId": "drp_bomb_e2e"}
    http = httpx.Client(base_url=url, headers={"X-Worker-Token": stack["token"]}, timeout=30)
    InspectSubscriber(http, tmp_path / "inspect").tick()
    httpx.post(f"{url}/api/v1/drops/drp_bomb_e2e/apply", json={})
    assert UnpackSubscriber(http, tmp_path / "unpack", LIMITS).tick() == 1
    node = next(x for x in httpx.get(f"{url}/api/v1/projects/{p}/search", params={"q": "bomb"}).json()["items"] if x["name"] == "bomb.zip")
    flags = httpx.get(f"{url}/api/v1/source-nodes/{node['id']}").json()["flags"]
    assert flags["unpack"] == {"refused": "ratio"} and "zip bomb" in flags["unsupported"]
