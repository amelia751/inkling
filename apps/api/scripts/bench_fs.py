"""todo7 Phase 9 performance probes for the Files kernel (not part of the test suite).

    uv run --package studio-api python apps/api/scripts/bench_fs.py            # SQLite file in a temp dir
    uv run --package studio-api python apps/api/scripts/bench_fs.py --files 100000 --zip-mb 600

1. Moving a folder of N files (D4: paths are computed, so a move touches O(depth) rows): the
   POST /fs/ops round trip through the app, plus its undo. Target < 200 ms at 100k on SQLite.
2. A ZIP of a large folder streams in constant memory: peak RSS growth while reading the whole
   response, against the bytes sent.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import resource
import sys
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient


def rss_mb() -> float:
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024  # bytes on macOS, KB on Linux


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", type=int, default=100_000)
    ap.add_argument("--zip-mb", type=int, default=600, help="total size of the ZIP probe (0 skips it)")
    ap.add_argument("--zip-files", type=int, default=60)
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="bench-fs-"))
    from studio_api import config, db
    from studio_api import db as kdb
    from studio_api.kernel import tree
    from studio_api.models import Asset, SourceNode

    seed = tmp / "seed"
    seed.mkdir()
    (seed / "manifest.json").write_text('{"projects": []}')
    s = config.load_settings(database_url=f"sqlite:///{tmp / 'bench.db'}", seed_root=seed, data_dir=tmp / "data", secret_key="bench-secret-key")
    config.set_settings(s)
    db.reset_engine()
    from studio_api.app import create_app

    client = TestClient(create_app())
    p = client.post("/api/v1/projects", json={"title": "Bench"}).json()["id"]
    root = client.get(f"/api/v1/projects/{p}/fs").json()["rootNodeId"]

    def mkdir(parent: str, name: str) -> str:
        return client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "mkdir", "parentId": parent, "name": name}]}).json()["nodes"][0]["id"]

    study = mkdir(root, "study")
    deep = mkdir(mkdir(study, "a"), "b")
    dest = mkdir(root, "dest")

    # ---- 1. Move a folder of N files ----------------------------------------------------------
    t0 = time.perf_counter()
    with kdb.session_scope() as d:
        big = SourceNode(**tree._row(id=tree.new_node_id(), source_id=None, project_id=p, project_root=root, parent_id=deep, name="big", original_path="", is_dir=True))
        d.add(big)
        d.flush()
        tree.bump(d, deep, 0, 0, children=1)
        tree.add_files(d, p, None, big.id, [tree.FileSpec(f"f{i:06d}.dcm", None, None, 10) for i in range(args.files)])
        big_id = big.id
    print(f"setup: {args.files:,} files in {time.perf_counter() - t0:.1f}s")
    times = []
    for i in range(3):
        target = dest if i % 2 == 0 else deep
        t = time.perf_counter()
        r = client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "move", "nodeIds": [big_id], "parentId": target}]})
        times.append((time.perf_counter() - t) * 1000)
        assert r.status_code == 200, r.text
    t = time.perf_counter()
    u = client.post(f"/api/v1/projects/{p}/fs/undo", json={})
    undo_ms = (time.perf_counter() - t) * 1000
    assert u.status_code == 200, u.text
    t = time.perf_counter()
    page = client.get(f"/api/v1/projects/{p}/fs/children", params={"node": big_id, "limit": 500})
    list_ms = (time.perf_counter() - t) * 1000
    print(f"move of a {args.files:,}-file folder (POST /fs/ops, through the app): " + ", ".join(f"{x:.0f} ms" for x in times) + f"; undo {undo_ms:.0f} ms; first page of its children {list_ms:.0f} ms ({page.status_code})")

    # ---- 2. ZIP in constant memory ------------------------------------------------------------
    if args.zip_mb:
        from studio_api import blobstore

        store = blobstore.data()
        each = args.zip_mb * 1024 * 1024 // args.zip_files
        z = mkdir(root, "zipme")
        block = os.urandom(1024 * 1024)
        with kdb.session_scope() as d:
            specs = []
            for i in range(args.zip_files):
                key = f"sources/{p}/bench-{i}.bin"
                path = tmp / f"blob-{i}.bin"
                with open(path, "wb") as fh:
                    left = each
                    while left > 0:
                        fh.write(block[: min(left, len(block))])
                        left -= len(block)
                store.put_file(key, str(path)) if hasattr(store, "put_file") else store.put(key, path.read_bytes())
                path.unlink()
                a = Asset(id=f"ast-bench-{i}", workspace_id=p, path=key, media_type="application/octet-stream", size=each)
                d.add(a)
                specs.append(tree.FileSpec(f"part{i:03d}.bin", a.id, hashlib.sha256(str(i).encode()).hexdigest(), each))
            d.flush()
            tree.add_files(d, p, None, z, specs)
        before = rss_mb()
        t = time.perf_counter()
        sent = 0
        with client.stream("POST", f"/api/v1/projects/{p}/fs/zip", json={"nodeIds": [z]}) as resp:
            assert resp.status_code == 200, resp.read()
            for chunk in resp.iter_bytes():
                sent += len(chunk)
        secs = time.perf_counter() - t
        print(f"ZIP of {args.zip_files} files, {sent / 1e6:,.0f} MB: {secs:.1f}s ({sent / 1e6 / secs:,.0f} MB/s); peak RSS {before:,.0f} → {rss_mb():,.0f} MB (growth {rss_mb() - before:,.0f} MB)")


if __name__ == "__main__":
    main()
